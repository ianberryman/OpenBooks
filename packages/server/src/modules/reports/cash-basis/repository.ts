import { sql } from 'kysely';

import type { TenantDatabase } from '../../../db';
import { bufferToUuid } from '../../../db';

import type {
  CashSettlement,
  DirectCashLeg,
  DocumentLeg,
  RecognizableDocument,
} from './recognition';

/**
 * The raw materials the cash-basis transform recognises against (OB-154, path A).
 *
 * All I/O lives here, kept apart from `recognition.ts` so the arithmetic stays a pure
 * function the property suite can stand over. This gathers, per accrual document
 * (invoice/bill), the three things the recogniser needs — the document's gross (the
 * denominator of the proportion), its journal's P&L legs (revenue/expense), and its
 * **cash** settlements (allocations carrying a `payment_id`; a credit-note settlement
 * has none and moves no cash, so it is never gathered). A voided document is excluded
 * by `void_journal_id IS NULL`, the same test every read of these tables makes.
 *
 * AR and AP are two explicit reads rather than one config-driven query: `tenantDb`
 * restricts `selectFrom` to bare tenant-table names (no alias), and the two
 * document-line tables do not even share a column type, so a generic over them would
 * erase the typing this file exists to keep. The three-array `assemble` below is where
 * the shape they do share lives. Full table names in every ref, the accrual core's style.
 *
 * Path B (direct cash-touching journals with a P&L leg — a cash sale posted straight
 * to the ledger) and the review flags (K3/K4) are `gatherDirectCash` at the foot of
 * this file; this half is the document-recognition majority D-88 names as the common case.
 */

interface LegRow {
  readonly document_id: Buffer;
  readonly account_id: Buffer;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
}
interface GrossRow {
  readonly document_id: Buffer;
  readonly gross: string;
}
interface SettlementRow {
  readonly document_id: Buffer;
  readonly allocated_on: string;
  readonly amount_minor: bigint;
}

/** Every recognisable document across both subledgers. */
export async function gatherRecognizableDocuments(
  db: TenantDatabase,
): Promise<readonly RecognizableDocument[]> {
  const [ar, ap] = await Promise.all([gatherArDocuments(db), gatherApDocuments(db)]);
  return [...ar, ...ap];
}

async function gatherArDocuments(db: TenantDatabase): Promise<readonly RecognizableDocument[]> {
  const legs = await db
    .selectFrom('ar_documents')
    .innerJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.org_id', '=', 'ar_documents.org_id')
        .onRef('journal_lines.journal_id', '=', 'ar_documents.journal_id'),
    )
    .innerJoin('accounts', (join) =>
      join
        .onRef('accounts.org_id', '=', 'journal_lines.org_id')
        .onRef('accounts.id', '=', 'journal_lines.account_id'),
    )
    .where('ar_documents.document_type', '=', 'invoice')
    .where('ar_documents.void_journal_id', 'is', null)
    .where('accounts.type', 'in', ['revenue', 'expense'])
    .select([
      'ar_documents.id as document_id',
      'journal_lines.account_id as account_id',
      'journal_lines.debit_minor as debit_minor',
      'journal_lines.credit_minor as credit_minor',
    ])
    .execute();

  // The document's gross is its journal's total — `SUM(debit_minor)` equals
  // `SUM(credit_minor)` for any balanced journal, and equals the control-line amount
  // the allocations settle against. Read off the journal (always present for an
  // approved document) rather than re-summing the document lines.
  const gross = await db
    .selectFrom('ar_documents')
    .innerJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.org_id', '=', 'ar_documents.org_id')
        .onRef('journal_lines.journal_id', '=', 'ar_documents.journal_id'),
    )
    .where('ar_documents.document_type', '=', 'invoice')
    .where('ar_documents.void_journal_id', 'is', null)
    .select('ar_documents.id as document_id')
    .select(sql<string>`SUM(journal_lines.debit_minor)`.as('gross'))
    .groupBy('ar_documents.id')
    .execute();

  const settlements = await db
    .selectFrom('ar_allocations')
    .where('ar_allocations.payment_id', 'is not', null)
    .select([
      'ar_allocations.invoice_id as document_id',
      'ar_allocations.allocated_on as allocated_on',
      'ar_allocations.amount_minor as amount_minor',
    ])
    .execute();

  return assemble(legs, gross, settlements);
}

async function gatherApDocuments(db: TenantDatabase): Promise<readonly RecognizableDocument[]> {
  const legs = await db
    .selectFrom('ap_documents')
    .innerJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.org_id', '=', 'ap_documents.org_id')
        .onRef('journal_lines.journal_id', '=', 'ap_documents.journal_id'),
    )
    .innerJoin('accounts', (join) =>
      join
        .onRef('accounts.org_id', '=', 'journal_lines.org_id')
        .onRef('accounts.id', '=', 'journal_lines.account_id'),
    )
    .where('ap_documents.document_type', '=', 'bill')
    .where('ap_documents.void_journal_id', 'is', null)
    .where('accounts.type', 'in', ['revenue', 'expense'])
    .select([
      'ap_documents.id as document_id',
      'journal_lines.account_id as account_id',
      'journal_lines.debit_minor as debit_minor',
      'journal_lines.credit_minor as credit_minor',
    ])
    .execute();

  const gross = await db
    .selectFrom('ap_documents')
    .innerJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.org_id', '=', 'ap_documents.org_id')
        .onRef('journal_lines.journal_id', '=', 'ap_documents.journal_id'),
    )
    .where('ap_documents.document_type', '=', 'bill')
    .where('ap_documents.void_journal_id', 'is', null)
    .select('ap_documents.id as document_id')
    .select(sql<string>`SUM(journal_lines.debit_minor)`.as('gross'))
    .groupBy('ap_documents.id')
    .execute();

  const settlements = await db
    .selectFrom('ap_allocations')
    .where('ap_allocations.payment_id', 'is not', null)
    .select([
      'ap_allocations.bill_id as document_id',
      'ap_allocations.allocated_on as allocated_on',
      'ap_allocations.amount_minor as amount_minor',
    ])
    .execute();

  return assemble(legs, gross, settlements);
}

interface DocumentBuild {
  gross: bigint;
  readonly legs: DocumentLeg[];
  readonly settlements: CashSettlement[];
}

/**
 * Joins the three per-side reads by document id. A document contributes only if it
 * carries a P&L leg — a document of purely balance-sheet lines has nothing a
 * cash-basis P&L recognises, so its gross and settlements are gathered but it produces
 * no `RecognizableDocument`.
 */
function assemble(
  legRows: readonly LegRow[],
  grossRows: readonly GrossRow[],
  settlementRows: readonly SettlementRow[],
): readonly RecognizableDocument[] {
  const byId = new Map<string, DocumentBuild>();
  const build = (id: string): DocumentBuild => {
    const existing = byId.get(id);
    if (existing !== undefined) return existing;
    const created: DocumentBuild = { gross: 0n, legs: [], settlements: [] };
    byId.set(id, created);
    return created;
  };

  for (const row of legRows) {
    build(bufferToUuid(row.document_id)).legs.push({
      accountId: bufferToUuid(row.account_id),
      debit: row.debit_minor,
      credit: row.credit_minor,
    });
  }
  for (const row of grossRows) {
    build(bufferToUuid(row.document_id)).gross = BigInt(row.gross);
  }
  for (const row of settlementRows) {
    const document = byId.get(bufferToUuid(row.document_id));
    if (document === undefined) continue;
    document.settlements.push({ date: row.allocated_on, amount: row.amount_minor });
  }

  const documents: RecognizableDocument[] = [];
  for (const document of byId.values()) {
    if (document.legs.length === 0) continue;
    documents.push({
      gross: document.gross,
      legs: document.legs,
      settlements: document.settlements,
    });
  }
  return documents;
}

/**
 * Path B (OB-154, K3): direct cash journals and the edges the transform flags.
 *
 * A journal that is not a document or payment journal but touches a cash account —
 * a cash sale, a cash expense, posted straight to the ledger — recognises its P&L
 * legs at its own date, because the cash already moved. "To the extent it touches
 * cash" (K3) is taken as a whole-journal test rather than a per-line proportion: a
 * journal whose only non-P&L lines are cash accounts is fully cash-backed and is
 * recognised; a journal that mixes cash with an accrual balance-sheet account (a
 * part-cash, part-financed purchase) is the ambiguous case D-87 will not guess at, so
 * it is **flagged, not split**. Unallocated receipts — cash in against no invoice —
 * are flagged for the same reason: whether an unapplied receipt is income is a
 * judgment (unearned deposit vs. cash sale), not a fact the ledger settles (K4).
 *
 * Cash accounts are those registered in `bank_accounts` or flagged
 * `accounts.cash_basis_role = 'cash'` — the same set the Statement of Cash Flows uses.
 */
export interface DirectCashResult {
  readonly legs: readonly DirectCashLeg[];
  /** Receipts posted against no invoice — cash whose recognition is a judgment (K4). */
  readonly unallocatedReceiptCount: number;
  /** Cash journals mixing cash with an accrual account — recognition is ambiguous (K3). */
  readonly mixedCashJournalCount: number;
}

interface CandidateLine {
  readonly journal_id: Buffer;
  readonly entry_date: string;
  readonly account_id: Buffer;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
}

export async function gatherDirectCash(db: TenantDatabase): Promise<DirectCashResult> {
  const unallocatedReceiptCount = await countUnallocatedReceipts(db);

  const cashAccountIds = await selectCashAccountIds(db);
  if (cashAccountIds.length === 0) {
    return { legs: [], unallocatedReceiptCount, mixedCashJournalCount: 0 };
  }
  const cashSet = new Set(cashAccountIds.map((id) => id.toString('hex')));

  const excludedSet = new Set((await selectExcludedJournalIds(db)).map((id) => id.toString('hex')));

  const touching = await db
    .selectFrom('journal_lines')
    .where('journal_lines.account_id', 'in', cashAccountIds)
    .select('journal_lines.journal_id as journal_id')
    .distinct()
    .execute();
  const candidateIds = touching
    .map((row) => row.journal_id)
    .filter((id) => !excludedSet.has(id.toString('hex')));
  if (candidateIds.length === 0) {
    return { legs: [], unallocatedReceiptCount, mixedCashJournalCount: 0 };
  }

  const lines: CandidateLine[] = await db
    .selectFrom('journal_lines')
    .innerJoin('journals', (join) =>
      join
        .onRef('journals.org_id', '=', 'journal_lines.org_id')
        .onRef('journals.id', '=', 'journal_lines.journal_id'),
    )
    .innerJoin('accounts', (join) =>
      join
        .onRef('accounts.org_id', '=', 'journal_lines.org_id')
        .onRef('accounts.id', '=', 'journal_lines.account_id'),
    )
    .where('journal_lines.journal_id', 'in', candidateIds)
    .select([
      'journal_lines.journal_id as journal_id',
      'journals.entry_date as entry_date',
      'journal_lines.account_id as account_id',
      'journal_lines.debit_minor as debit_minor',
      'journal_lines.credit_minor as credit_minor',
      'accounts.type as type',
    ])
    .execute();

  const byJournal = new Map<string, CandidateLine[]>();
  for (const line of lines) {
    const key = line.journal_id.toString('hex');
    const group = byJournal.get(key) ?? [];
    group.push(line);
    byJournal.set(key, group);
  }

  const legs: DirectCashLeg[] = [];
  let mixedCashJournalCount = 0;

  for (const group of byJournal.values()) {
    const isPnl = (line: CandidateLine): boolean =>
      line.type === 'revenue' || line.type === 'expense';
    const isCash = (line: CandidateLine): boolean => cashSet.has(line.account_id.toString('hex'));

    // Pure cash: every non-P&L line is a cash account. A line that is neither P&L nor
    // cash is an accrual account, which makes the journal's cash content ambiguous.
    const pure = group.every((line) => isPnl(line) || isCash(line));
    if (!pure) {
      mixedCashJournalCount += 1;
      continue;
    }
    for (const line of group) {
      if (!isPnl(line)) continue;
      legs.push({
        accountId: bufferToUuid(line.account_id),
        date: line.entry_date,
        debit: line.debit_minor,
        credit: line.credit_minor,
      });
    }
  }

  return { legs, unallocatedReceiptCount, mixedCashJournalCount };
}

/** The account ids that count as cash: registered bank accounts, or flagged `cash`. */
async function selectCashAccountIds(db: TenantDatabase): Promise<readonly Buffer[]> {
  const [banks, flagged] = await Promise.all([
    db.selectFrom('bank_accounts').select('bank_accounts.account_id as id').execute(),
    db
      .selectFrom('accounts')
      .where('accounts.cash_basis_role', '=', 'cash')
      .select('accounts.id as id')
      .execute(),
  ]);
  const ids = new Map<string, Buffer>();
  for (const row of [...banks, ...flagged]) ids.set(row.id.toString('hex'), row.id);
  return [...ids.values()];
}

/**
 * The journals that belong to a document or a payment, and their reversals — the ones
 * path B must not treat as standalone cash journals. A document journal carries the
 * P&L that path A recognises through its settlements; a payment journal has no P&L leg
 * at all; a void journal reverses one of those. None is a direct cash sale.
 */
async function selectExcludedJournalIds(db: TenantDatabase): Promise<readonly Buffer[]> {
  const [ar, ap, payments] = await Promise.all([
    db
      .selectFrom('ar_documents')
      .select(['ar_documents.journal_id as journal_id', 'ar_documents.void_journal_id as void_id'])
      .execute(),
    db
      .selectFrom('ap_documents')
      .select(['ap_documents.journal_id as journal_id', 'ap_documents.void_journal_id as void_id'])
      .execute(),
    db
      .selectFrom('payments')
      .select(['payments.journal_id as journal_id', 'payments.void_journal_id as void_id'])
      .execute(),
  ]);
  const ids = new Map<string, Buffer>();
  for (const row of [...ar, ...ap, ...payments]) {
    if (row.journal_id !== null) ids.set(row.journal_id.toString('hex'), row.journal_id);
    if (row.void_id !== null) ids.set(row.void_id.toString('hex'), row.void_id);
  }
  return [...ids.values()];
}

/**
 * Received payments that settle no document. A receipt with no allocation is cash in
 * the bank against nothing on the subledger — a deposit, a prepayment, an on-account
 * receipt — and whether it is income on a cash basis is the judgment K4 hands to
 * review rather than deciding here. Counted, not recognised.
 */
async function countUnallocatedReceipts(db: TenantDatabase): Promise<number> {
  const row = await db
    .selectFrom('payments')
    .where('payments.direction', '=', 'received')
    .where('payments.void_journal_id', 'is', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('ar_allocations')
            .whereRef('ar_allocations.payment_id', '=', 'payments.id')
            .select(sql`1`.as('one')),
        ),
      ),
    )
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
