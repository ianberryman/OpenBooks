import { sql } from 'kysely';
import type { Expression, SqlBool } from 'kysely';

import type { RequestContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { bufferToUuid, orgScope as toOrgId, tenantDb } from '../../../db';
import type { AgingDocumentRow } from '../../reports/aging.repository';
import { selectApDocuments, selectArDocuments } from '../../reports/aging.repository';

/**
 * The read surfaces the match engine draws candidates from (OB-079; ROADMAP D-43,
 * acceptance E3, E10).
 *
 * Every function here is a **read** — matching proposes and never writes (D-43), so
 * this file touches no journal table, no clearing, no proposal row. Each loader is
 * built to run **once for a whole page** of statement lines rather than once per line
 * (E10): the request names up to `PAGE_SIZE_MAX` lines, and a per-line query would
 * turn one screen into thousands of round trips against a 5,000-line statement.
 *
 * The three ledger-side sources map onto the three proposal kinds:
 *
 *  - existing journals on the bank's ledger account, not yet cleared → `link_entry`;
 *  - open invoices and bills with an outstanding balance → `allocate_document`;
 *  - the org's own past codings of similar lines → `post_entry` (with `ruleId` null).
 *
 * Rules — the fourth source, and another `post_entry` — are not read here: they come
 * through the injected `RuleEvaluator` (`../rule-evaluator.ts`), so nothing a rule
 * returns can reach the ledger and the engine does not import the rules service.
 */

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * Everything reconciliation reads once a document has posted counts as "open" when its
 * outstanding is non-zero. A far-future as-at collapses the aging report's as-at
 * machinery to "everything posted, minus every allocation to date" — which is exactly
 * current outstanding (D-34) — without asking this module what day it is. A calendar
 * "today" would need a timezone the matcher has no business choosing, and would make
 * the same page return different candidates side of midnight.
 */
const OPEN_AS_OF = '9999-12-31';

// ---------------------------------------------------------------------------
// The lines the page is about
// ---------------------------------------------------------------------------

export interface StatementLineRow {
  readonly id: Buffer;
  readonly lineId: string;
  readonly bankAccountId: Buffer;
  readonly postedDate: string;
  readonly description: string;
  readonly counterparty: string | null;
  readonly amount: bigint;
  readonly bankReference: string | null;
}

/**
 * The requested lines that exist in this org. A line absent from the result was
 * cross-org or never existed, and is simply not proposed for — a cross-org read is
 * indistinguishable from a nonexistent one (E9), so one bad id neither errors the page
 * nor confirms the line is out there.
 */
export async function selectStatementLines(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<StatementLineRow[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .selectFrom('bank_statement_lines')
    .select([
      'id',
      'bank_account_id',
      'posted_date',
      'description',
      'counterparty',
      'amount_minor',
      'bank_reference',
    ])
    .where('id', 'in', [...ids])
    .execute();

  return rows.map((row) => ({
    id: row.id,
    lineId: bufferToUuid(row.id),
    bankAccountId: row.bank_account_id,
    postedDate: row.posted_date,
    description: row.description,
    counterparty: row.counterparty,
    amount: row.amount_minor,
    bankReference: row.bank_reference,
  }));
}

// ---------------------------------------------------------------------------
// The bank accounts, and the ledger accounts behind them
// ---------------------------------------------------------------------------

export interface BankAccountRow {
  readonly id: Buffer;
  readonly ledgerAccountId: Buffer;
}

/**
 * Every bank account in the org, so the caller can both map a line to its ledger
 * account and know the full set of ledger accounts that are a *bank* side — the coding
 * history below must never propose one of them. Orgs hold a handful of bank accounts,
 * so this is a single small read rather than a per-line lookup.
 */
export async function selectBankAccounts(db: TenantDatabase): Promise<BankAccountRow[]> {
  const rows = await db.selectFrom('bank_accounts').select(['id', 'account_id']).execute();
  return rows.map((row) => ({ id: row.id, ledgerAccountId: row.account_id }));
}

// ---------------------------------------------------------------------------
// link_entry — journals already on the bank account, not yet cleared
// ---------------------------------------------------------------------------

export interface LinkCandidateSpec {
  readonly ledgerAccountIds: readonly Buffer[];
  readonly fromDate: string;
  readonly toDate: string;
  readonly netMin: bigint;
  readonly netMax: bigint;
}

export interface LinkCandidateRow {
  readonly journalId: Buffer;
  readonly ledgerAccountId: Buffer;
  readonly entryDate: string;
  readonly memo: string | null;
  /** The journal's net movement on the bank ledger account, signed in the line's frame. */
  readonly net: bigint;
}

/**
 * Journals posting to any of the page's bank ledger accounts, within the page's date
 * and amount windows, that no clearing has claimed yet.
 *
 * The net movement is `SUM(debit − credit)` on the bank account's own lines: on an
 * asset account a debit is money in, which is the line's own sign convention
 * (positive into the account), so the two are directly comparable without a
 * conditional — the same reason the wire amount is signed (E4). A journal already in
 * `bank_line_clearings` is excluded by the anti-join: a cleared entry is not a
 * candidate to clear a line against, and `uq_blc_journal` makes that at most one row.
 *
 * The date and amount windows are the page's, pushed into SQL so the candidate set is
 * bounded by what the page could plausibly match rather than by the account's whole
 * history — the coarse cut for E10; the per-line tolerance is applied in memory after.
 */
export async function selectLinkCandidates(
  db: TenantDatabase,
  spec: LinkCandidateSpec,
): Promise<LinkCandidateRow[]> {
  if (spec.ledgerAccountIds.length === 0) return [];

  const net = sql<string>`SUM(${sql.ref('journal_lines.debit_minor')} - ${sql.ref('journal_lines.credit_minor')})`;

  const rows = await db
    .selectFrom('journal_lines')
    .innerJoin('journals', (join) =>
      join
        .onRef('journals.id', '=', 'journal_lines.journal_id')
        .onRef('journals.org_id', '=', 'journal_lines.org_id'),
    )
    .leftJoin('bank_line_clearings', (join) =>
      join
        .onRef('bank_line_clearings.cleared_journal_id', '=', 'journals.id')
        .onRef('bank_line_clearings.org_id', '=', 'journals.org_id'),
    )
    .where('journal_lines.account_id', 'in', [...spec.ledgerAccountIds])
    .where('bank_line_clearings.id', 'is', null)
    .where('journals.entry_date', '>=', spec.fromDate)
    .where('journals.entry_date', '<=', spec.toDate)
    .groupBy([
      'journal_lines.journal_id',
      'journal_lines.account_id',
      'journals.entry_date',
      'journals.memo',
    ])
    .having(sql<SqlBool>`${net} BETWEEN ${spec.netMin} AND ${spec.netMax}`)
    .select([
      'journal_lines.journal_id as journal_id',
      'journal_lines.account_id as ledger_account_id',
      'journals.entry_date as entry_date',
      'journals.memo as memo',
    ])
    .select(net.as('net'))
    .execute();

  return rows.map((row) => ({
    journalId: row.journal_id,
    ledgerAccountId: row.ledger_account_id,
    entryDate: row.entry_date,
    memo: row.memo,
    net: BigInt(row.net),
  }));
}

// ---------------------------------------------------------------------------
// allocate_document — open invoices and bills, outstanding computed on read (D-34)
// ---------------------------------------------------------------------------

export interface OpenDocumentRow {
  readonly documentId: Buffer;
  readonly documentNumber: string | null;
  readonly reference: string | null;
  readonly contactId: Buffer;
  readonly contactName: string;
  readonly outstanding: bigint;
}

/** Open invoices — an inbound line is a customer settling one of these. */
export async function selectOpenInvoices(db: TenantDatabase): Promise<OpenDocumentRow[]> {
  const rows = await selectArDocuments(db, {
    asOf: OPEN_AS_OF,
    documentType: 'invoice',
    allocationLink: 'invoice_id',
    contactId: null,
  });
  return toOpenDocuments(rows);
}

/** Open bills — an outbound line is us settling one of these. */
export async function selectOpenBills(db: TenantDatabase): Promise<OpenDocumentRow[]> {
  const rows = await selectApDocuments(db, {
    asOf: OPEN_AS_OF,
    documentType: 'bill',
    allocationLink: 'bill_id',
    contactId: null,
  });
  return toOpenDocuments(rows);
}

function toOpenDocuments(rows: readonly AgingDocumentRow[]): OpenDocumentRow[] {
  const open: OpenDocumentRow[] = [];
  for (const row of rows) {
    const outstanding = row.total - row.allocated;
    // Settled and over-allocated documents are not something a line can pay down.
    if (outstanding <= 0n) continue;
    open.push({
      documentId: row.documentId,
      documentNumber: row.sequenceNumber === null ? null : row.sequenceNumber.toString(),
      reference: row.reference,
      contactId: row.contactId,
      contactName: row.contactName,
      outstanding,
    });
  }
  return open;
}

// ---------------------------------------------------------------------------
// post_entry from history — accounts this org has coded similar lines to before
// ---------------------------------------------------------------------------

export interface CodingHistorySpec {
  readonly counterparties: readonly string[];
  readonly descriptions: readonly string[];
  /** Ledger accounts that are a bank side; a coding never proposes one of these. */
  readonly bankLedgerAccountIds: readonly Buffer[];
}

export interface CodingHistoryRow {
  /** The historical line's own counterparty and description, to correlate by likeness. */
  readonly counterparty: string | null;
  readonly description: string;
  readonly accountId: Buffer;
  readonly contactId: Buffer | null;
}

/**
 * Every account this org has previously coded a line to via `post_entry`, for lines
 * whose counterparty or description matches one on the page.
 *
 * The record of a coding is a `post_entry` clearing: it created a journal for the
 * line, and that journal's non-bank line names the account the line was coded to. So
 * this reads `bank_line_clearings` (the org's own history) joined to the coded
 * journal's lines, excluding the bank side. The prefilter matches raw counterparty and
 * description strings — a merchant's string is stable across statements — and the
 * likeness that actually decides a proposal is judged in memory, normalised, against
 * each page line. One query for the whole page.
 */
export async function selectCodingHistory(
  db: TenantDatabase,
  spec: CodingHistorySpec,
): Promise<CodingHistoryRow[]> {
  if (spec.counterparties.length === 0 && spec.descriptions.length === 0) return [];

  let query = db
    .selectFrom('bank_line_clearings')
    .innerJoin('bank_statement_lines', (join) =>
      join
        .onRef('bank_statement_lines.id', '=', 'bank_line_clearings.statement_line_id')
        .onRef('bank_statement_lines.org_id', '=', 'bank_line_clearings.org_id'),
    )
    .innerJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.journal_id', '=', 'bank_line_clearings.cleared_journal_id')
        .onRef('journal_lines.org_id', '=', 'bank_line_clearings.org_id'),
    )
    .where('bank_line_clearings.method', '=', 'post_entry')
    .where((eb) => {
      const clauses: Expression<SqlBool>[] = [];
      if (spec.counterparties.length > 0) {
        clauses.push(eb('bank_statement_lines.counterparty', 'in', [...spec.counterparties]));
      }
      if (spec.descriptions.length > 0) {
        clauses.push(eb('bank_statement_lines.description', 'in', [...spec.descriptions]));
      }
      return eb.or(clauses);
    });

  if (spec.bankLedgerAccountIds.length > 0) {
    query = query.where('journal_lines.account_id', 'not in', [...spec.bankLedgerAccountIds]);
  }

  const rows = await query
    .select([
      'bank_statement_lines.counterparty as counterparty',
      'bank_statement_lines.description as description',
      'journal_lines.account_id as account_id',
      'journal_lines.contact_id as contact_id',
    ])
    .execute();

  return rows.map((row) => ({
    counterparty: row.counterparty,
    description: row.description,
    accountId: row.account_id,
    contactId: row.contact_id,
  }));
}
