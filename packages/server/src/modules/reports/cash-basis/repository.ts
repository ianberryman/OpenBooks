import { sql } from 'kysely';

import type { TenantDatabase } from '../../../db';
import { bufferToUuid } from '../../../db';

import type { CashSettlement, DocumentLeg, RecognizableDocument } from './recognition';

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
 * to the ledger) and the review flags (D-99) are the next increment; this file is the
 * document-recognition majority D-88 names as the common case.
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
