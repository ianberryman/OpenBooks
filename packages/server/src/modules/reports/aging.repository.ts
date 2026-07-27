import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';

import type { TenantDatabase } from '../../db';

/**
 * The aging aggregation (OB-065; ROADMAP D-34, D-37, D-39, D-40, acceptance C8).
 *
 * Every other report in this module aggregates `journal_lines`. This one
 * aggregates *documents and allocations*, and that is the whole reason C8 is worth
 * asserting: two independent aggregations over two different sets of tables have to
 * produce the same number, and an aging report that does not tie to the ledger is a
 * list of hopes (D-40).
 *
 * ## As at means as at, and it is decided here
 *
 * Three date predicates, and each of them is the as-at rule applied to one table:
 *
 *  - **A document is in the report when its posting journal is**, i.e. when
 *    `journals.entry_date <= asOf`. Not `issue_date <= asOf`, which would be the
 *    obvious filter and is the wrong one: the figure this report must tie to is the
 *    control account's balance, the control account moves on `entry_date`, and
 *    nothing in the schema forces the two columns to agree. Asking the ledger when
 *    the document landed makes the reconciliation structural rather than dependent
 *    on a convention `0005_subledger` does not state.
 *  - **A void removes the document only once the reversal is in the ledger**, by the
 *    same rule on `void_journal_id`. A document voided in March is still outstanding
 *    in an aging report as at February, because in February it was — and the control
 *    account says so too.
 *  - **An allocation counts when `allocated_on <= asOf`.** That column exists for
 *    exactly this (D-40, and the `ar_allocations` commentary in `0005_subledger`):
 *    using today's allocations against a past date's documents produces a report
 *    that cannot be reproduced tomorrow, which is the failure D-32 accepted
 *    deliberately for sliced reports and which D-40 explicitly refuses here.
 *
 * The residual limit, stated rather than discovered: an allocation is an ordinary
 * deletable row (it posts no journal, so removing one restates no financial
 * statement), and a deletion carries no date. So aging as at a past date is
 * reproducible against allocations *arriving* and not against one being removed.
 * Nothing in the M3 schema makes the second expressible; if it ever matters the
 * answer is D-34's — a projection rebuilt from the ledger and asserted against it,
 * never a stored balance.
 *
 * ## Why the two sums are correlated subqueries and not joins
 *
 * A document's total is a `SUM` over its lines and its settled amount is a `SUM`
 * over its allocations. Joining both into one statement multiplies every line by
 * every allocation and inflates both figures — the same row-multiplication
 * `balances.repository.ts` avoids on `journal_line_dimensions`, arriving through a
 * different table. A subquery cannot add rows to the result whatever it finds, so
 * the arithmetic is unrelated to how many lines or allocations a document carries.
 *
 * Correlated per document rather than a grouped derived table, because a derived
 * table would aggregate every line and every allocation the org has ever written
 * before discarding the ones belonging to settled documents, while the correlation
 * reads only the rows of the documents the report actually returned.
 *
 * ## What this costs, measured
 *
 * On MySQL 8.4 in the test container, one org, 50 contacts, one open invoice each
 * of two lines and two allocations (one inside the as-at window, one after it):
 *
 * | documents | allocations | `getAging` median |
 * | --------- | ----------- | ----------------- |
 * | 200       | 400         | 1.8 ms            |
 * | 1,000     | 2,000       | 6.3 ms            |
 *
 * Linear in documents, because the plan is one index range per document:
 * `idx_ar_documents_org_type_issue` covers the outer scan,
 * `uq_ar_document_lines_document_line` the line sum, and
 * `idx_ar_allocations_org_invoice (org_id, invoice_id, allocated_on)` the
 * allocation sum with `allocated_on` pushed down as an index condition. Forcing
 * that last index produces a byte-identical plan, so it is the one the optimizer
 * would have been given anyway. **No index was added by this ticket** — the two
 * `0005_subledger` designed for this query are the right two, which is D-34's
 * predicted cost ("it will need indexes designed for it the way
 * `idx_jld_org_dimension_value` was") arriving as designed.
 *
 * The measurement is recorded because the first attempt at it was misleading and
 * the next person will hit the same thing. Bulk-loading a fresh table and querying
 * it immediately leaves InnoDB's persistent statistics describing an empty table,
 * and the optimizer then ignores `idx_ar_allocations_org_invoice` in favour of
 * `uq_ar_allocations_org_id` — which shares only the `org_id` prefix, so every
 * document rescans the org's whole allocation set and 1,000 documents take
 * **1,180 ms** instead of 6.3. One `ANALYZE TABLE ar_allocations` is the entire
 * difference. That is a seeding artifact rather than a property of this query, and
 * the number to be alarmed by would be a plan that stays quadratic *after* the
 * statistics are current.
 *
 * Org scoping on the subqueries is the correlation `alloc.org_id = <doc>.org_id`,
 * which is `dimensionFilterPredicate`'s pattern and inherits its scope the same
 * way: the outer table is reached through `tenantDb`, so the correlated predicate
 * pins the inner table to an org the wrapper has already fixed.
 *
 * ## Why AR and AP are written twice
 *
 * `0005_subledger` argues at length that a shared table with a `side` column would
 * "put a predicate on `side` in front of every one of those, and the first query
 * that forgot it would mix money a business owes with money it is owed". A single
 * query builder generic over both tables is the same bet one layer up, and it does
 * not typecheck cleanly either — the two `document_type` enums are disjoint, so a
 * union-typed builder narrows the value a `where` may take to `never`. The two
 * functions below differ only in table names; the arithmetic they feed is shared,
 * in `aging.service.ts`, which is where a divergence would actually matter.
 */

/** Which allocation column ties an `ar_allocations` row to the document being read. */
export type ArAllocationLink = 'invoice_id' | 'credit_note_id';

/** The `ap_allocations` mirror. */
export type ApAllocationLink = 'bill_id' | 'vendor_credit_id';

export interface AgingDocumentSpec<Type extends string, Link extends string> {
  /** Inclusive. Everything in this report is "as the books stood at the end of it". */
  readonly asOf: string;
  readonly documentType: Type;
  readonly allocationLink: Link;
  /** One contact, or `null` for every contact with something in the subledger. */
  readonly contactId: Buffer | null;
}

export interface AgingDocumentRow {
  readonly documentId: Buffer;
  /**
   * Non-null by `chk_ar_documents_approved` — a document with a journal has a
   * number — and the query inner-joins the journal, so a null here is a schema
   * violation rather than a draft.
   */
  readonly sequenceNumber: bigint | null;
  readonly reference: string | null;
  readonly issueDate: string;
  /**
   * Null on a credit note or a vendor credit, which the CHECK constraints require
   * a due date only of an approved invoice or bill: a credit is allocated, not
   * chased.
   */
  readonly dueDate: string | null;
  readonly contactId: Buffer;
  readonly contactName: string;
  /** The sum of the document's lines, net plus tax. Never a stored column (D-34). */
  readonly total: bigint;
  /** The allocations against it dated on or before `asOf`. */
  readonly allocated: bigint;
}

export interface AgingPaymentSpec {
  readonly asOf: string;
  readonly direction: 'received' | 'paid';
  readonly allocations: 'ar_allocations' | 'ap_allocations';
  readonly contactId: Buffer | null;
}

export interface AgingPaymentRow {
  readonly paymentId: Buffer;
  /**
   * `payments.sequence_number` is NOT NULL — a payment has no draft phase, so its
   * number is issued in the same transaction that records it (D-36).
   */
  readonly sequenceNumber: bigint;
  readonly reference: string | null;
  readonly paymentDate: string;
  readonly contactId: Buffer;
  readonly contactName: string;
  readonly amount: bigint;
  readonly allocated: bigint;
}

export async function selectArDocuments(
  db: TenantDatabase,
  spec: AgingDocumentSpec<'invoice' | 'credit_note', ArAllocationLink>,
): Promise<readonly AgingDocumentRow[]> {
  let query = db
    .selectFrom('ar_documents')
    .innerJoin('journals as posted_journal', (join) =>
      join
        .onRef('posted_journal.id', '=', 'ar_documents.journal_id')
        .onRef('posted_journal.org_id', '=', 'ar_documents.org_id')
        .on('posted_journal.entry_date', '<=', spec.asOf),
    )
    .leftJoin('journals as void_journal', (join) =>
      join
        .onRef('void_journal.id', '=', 'ar_documents.void_journal_id')
        .onRef('void_journal.org_id', '=', 'ar_documents.org_id')
        .on('void_journal.entry_date', '<=', spec.asOf),
    )
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'ar_documents.contact_id')
        .onRef('contacts.org_id', '=', 'ar_documents.org_id'),
    )
    .where('ar_documents.document_type', '=', spec.documentType)
    .where('void_journal.id', 'is', null);

  if (spec.contactId !== null) {
    query = query.where('ar_documents.contact_id', '=', spec.contactId);
  }

  const rows = await query
    .select([
      'ar_documents.id as document_id',
      'ar_documents.sequence_number as sequence_number',
      'ar_documents.reference as reference',
      'ar_documents.issue_date as issue_date',
      'ar_documents.due_date as due_date',
      'contacts.id as contact_id',
      'contacts.display_name as contact_name',
    ])
    // A second `select` so the column references above keep their inferred types;
    // mixing them with `sql` fragments in one array collapses the row type to an
    // index signature. `balances.repository.ts` splits its aggregates for the same
    // reason.
    .select([
      documentTotal('ar_documents', 'ar_document_lines').as('total'),
      allocatedTotal('ar_documents', 'ar_allocations', spec.allocationLink, spec.asOf).as(
        'allocated',
      ),
    ])
    .execute();

  return rows.map(toDocumentRow);
}

export async function selectApDocuments(
  db: TenantDatabase,
  spec: AgingDocumentSpec<'bill' | 'vendor_credit', ApAllocationLink>,
): Promise<readonly AgingDocumentRow[]> {
  let query = db
    .selectFrom('ap_documents')
    .innerJoin('journals as posted_journal', (join) =>
      join
        .onRef('posted_journal.id', '=', 'ap_documents.journal_id')
        .onRef('posted_journal.org_id', '=', 'ap_documents.org_id')
        .on('posted_journal.entry_date', '<=', spec.asOf),
    )
    .leftJoin('journals as void_journal', (join) =>
      join
        .onRef('void_journal.id', '=', 'ap_documents.void_journal_id')
        .onRef('void_journal.org_id', '=', 'ap_documents.org_id')
        .on('void_journal.entry_date', '<=', spec.asOf),
    )
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'ap_documents.contact_id')
        .onRef('contacts.org_id', '=', 'ap_documents.org_id'),
    )
    .where('ap_documents.document_type', '=', spec.documentType)
    .where('void_journal.id', 'is', null);

  if (spec.contactId !== null) {
    query = query.where('ap_documents.contact_id', '=', spec.contactId);
  }

  const rows = await query
    .select([
      'ap_documents.id as document_id',
      'ap_documents.sequence_number as sequence_number',
      'ap_documents.reference as reference',
      'ap_documents.issue_date as issue_date',
      'ap_documents.due_date as due_date',
      'contacts.id as contact_id',
      'contacts.display_name as contact_name',
    ])
    .select([
      documentTotal('ap_documents', 'ap_document_lines').as('total'),
      allocatedTotal('ap_documents', 'ap_allocations', spec.allocationLink, spec.asOf).as(
        'allocated',
      ),
    ])
    .execute();

  return rows.map(toDocumentRow);
}

/**
 * Payments in one direction, with how much of each was applied as at the date.
 *
 * One table for both directions, unlike the documents, because `payments` *is* one
 * table — `direction` is the column the schema chose, and the allocation table it
 * reaches is the only thing that varies with it (D-37: 'received' settles AR,
 * 'paid' settles AP).
 *
 * Per payment rather than summed per contact in SQL, because the service has to
 * treat an over-payment and a settled one differently only in that the second
 * contributes zero, and because a `GROUP BY` here would hide which payment produced
 * a credit when one is being chased. The identifying columns are selected for the
 * same reason: OB-066a gives an unapplied payment its own detail row, so the report
 * can name the receipt a customer is holding credit from rather than showing a
 * number with no document behind it.
 */
export async function selectPayments(
  db: TenantDatabase,
  spec: AgingPaymentSpec,
): Promise<readonly AgingPaymentRow[]> {
  let query = db
    .selectFrom('payments')
    .innerJoin('journals as posted_journal', (join) =>
      join
        .onRef('posted_journal.id', '=', 'payments.journal_id')
        .onRef('posted_journal.org_id', '=', 'payments.org_id')
        .on('posted_journal.entry_date', '<=', spec.asOf),
    )
    .leftJoin('journals as void_journal', (join) =>
      join
        .onRef('void_journal.id', '=', 'payments.void_journal_id')
        .onRef('void_journal.org_id', '=', 'payments.org_id')
        .on('void_journal.entry_date', '<=', spec.asOf),
    )
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'payments.contact_id')
        .onRef('contacts.org_id', '=', 'payments.org_id'),
    )
    .where('payments.direction', '=', spec.direction)
    .where('void_journal.id', 'is', null);

  if (spec.contactId !== null) {
    query = query.where('payments.contact_id', '=', spec.contactId);
  }

  const rows = await query
    .select([
      'payments.id as payment_id',
      'payments.sequence_number as sequence_number',
      'payments.reference as reference',
      'payments.payment_date as payment_date',
      'contacts.id as contact_id',
      'contacts.display_name as contact_name',
      'payments.amount_minor as amount_minor',
    ])
    .select([allocatedPayment(spec.allocations, spec.asOf).as('allocated')])
    .execute();

  return rows.map((row) => ({
    paymentId: row.payment_id,
    sequenceNumber: row.sequence_number,
    reference: row.reference,
    paymentDate: row.payment_date,
    contactId: row.contact_id,
    contactName: row.contact_name,
    amount: row.amount_minor,
    allocated: toBigInt(row.allocated),
  }));
}

interface RawDocumentRow {
  readonly document_id: Buffer;
  readonly sequence_number: bigint | null;
  readonly reference: string | null;
  readonly issue_date: string;
  readonly due_date: string | null;
  readonly contact_id: Buffer;
  readonly contact_name: string;
  readonly total: string | number | bigint;
  readonly allocated: string | number | bigint;
}

function toDocumentRow(row: RawDocumentRow): AgingDocumentRow {
  return {
    documentId: row.document_id,
    sequenceNumber: row.sequence_number,
    reference: row.reference,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    contactId: row.contact_id,
    contactName: row.contact_name,
    total: toBigInt(row.total),
    allocated: toBigInt(row.allocated),
  };
}

/**
 * `SUM(net + tax)` over a document's own lines.
 *
 * The two columns are added rather than one gross column being read, because
 * `0005_subledger` stores them separately on purpose: they are the two roundings
 * D-35 permits, recorded where they happened. No header total exists to read
 * instead — D-34 is that absence, and this subquery is what it costs.
 */
function documentTotal(
  documents: 'ar_documents' | 'ap_documents',
  lines: 'ar_document_lines' | 'ap_document_lines',
): RawBuilder<string> {
  const line = sql.table('doc_line');

  return sql<string>`(
    SELECT COALESCE(SUM(${sql.ref('doc_line.line_amount_minor')}
                      + ${sql.ref('doc_line.tax_amount_minor')}), 0)
    FROM ${sql.table(lines)} AS ${line}
    WHERE ${sql.ref('doc_line.org_id')} = ${sql.ref(`${documents}.org_id`)}
      AND ${sql.ref('doc_line.document_id')} = ${sql.ref(`${documents}.id`)}
  )`;
}

/**
 * What has been applied to this document, as at the date.
 *
 * `allocated_on <= asOf` is the whole of D-40's as-at rule for the settlement side,
 * and it is a bound parameter on an indexed column rather than a filter applied
 * after the fact — `idx_ar_allocations_org_invoice` is `(org_id, invoice_id,
 * allocated_on)`, so the three predicates below are one index range per document.
 */
function allocatedTotal(
  documents: 'ar_documents' | 'ap_documents',
  allocations: 'ar_allocations' | 'ap_allocations',
  link: ArAllocationLink | ApAllocationLink,
  asOf: string,
): RawBuilder<string> {
  const alias = sql.table('alloc');

  return sql<string>`(
    SELECT COALESCE(SUM(${sql.ref('alloc.amount_minor')}), 0)
    FROM ${sql.table(allocations)} AS ${alias}
    WHERE ${sql.ref('alloc.org_id')} = ${sql.ref(`${documents}.org_id`)}
      AND ${sql.ref(`alloc.${link}`)} = ${sql.ref(`${documents}.id`)}
      AND ${sql.ref('alloc.allocated_on')} <= ${asOf}
      AND ${counterpartPosted(allocations, link, asOf)}
  )`;
}

/**
 * The fourth as-at predicate, and the one the file's header originally missed (OB-071).
 *
 * An allocation counts only once **the document at its other end has itself posted**.
 * Bounding it by `allocated_on` alone is not enough, because an allocation's date
 * defaults to its *source's* date and a source routinely predates its target: a deposit
 * taken on 5 January and applied to an invoice approved on 23 February carries 5 January,
 * so at 22 February the subledger showed the customer owing nothing while the control
 * account still held their credit. A back-dated credit note reads the same way from the
 * other side — the invoice appears settled while the ledger still carries it.
 *
 * Nothing throws in either case and the report is internally consistent; only comparison
 * with the ledger notices. That is exactly why spec §11 made subledger agreement an
 * invariant rather than a review item, and it is what `test/properties/
 * subledger-agreement.test.ts` caught on its first run.
 */
function counterpartPosted(
  allocations: 'ar_allocations' | 'ap_allocations',
  link: ArAllocationLink | ApAllocationLink,
  asOf: string,
): RawBuilder<boolean> {
  const receivable = allocations === 'ar_allocations';

  // A document is reduced by either a payment or a credit, so either far end posting
  // makes the allocation count; a credit is reduced only by the document it was applied
  // to, which is the single case below.
  if (link === 'invoice_id' || link === 'bill_id') {
    return sql<boolean>`(${postedCounterpart('payments', 'payment_id', asOf)} OR ${postedCounterpart(
      receivable ? 'ar_documents' : 'ap_documents',
      receivable ? 'credit_note_id' : 'vendor_credit_id',
      asOf,
    )})`;
  }

  return postedCounterpart(
    receivable ? 'ar_documents' : 'ap_documents',
    receivable ? 'invoice_id' : 'bill_id',
    asOf,
  );
}

/** Whether the row `alloc.<column>` names had reached the ledger by `asOf`. */
function postedCounterpart(
  table: 'ar_documents' | 'ap_documents' | 'payments',
  column: string,
  asOf: string,
): RawBuilder<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${sql.table(table)} AS far
    INNER JOIN journals AS far_journal
      ON far_journal.id = far.journal_id AND far_journal.org_id = far.org_id
    WHERE far.id = ${sql.ref(`alloc.${column}`)}
      AND far.org_id = ${sql.ref('alloc.org_id')}
      AND far_journal.entry_date <= ${asOf}
  )`;
}

/** The payment mirror of `allocatedTotal`, over `idx_ar_allocations_org_payment`. */
function allocatedPayment(
  allocations: 'ar_allocations' | 'ap_allocations',
  asOf: string,
): RawBuilder<string> {
  const alias = sql.table('alloc');

  return sql<string>`(
    SELECT COALESCE(SUM(${sql.ref('alloc.amount_minor')}), 0)
    FROM ${sql.table(allocations)} AS ${alias}
    WHERE ${sql.ref('alloc.org_id')} = ${sql.ref('payments.org_id')}
      AND ${sql.ref('alloc.payment_id')} = ${sql.ref('payments.id')}
      AND ${sql.ref('alloc.allocated_on')} <= ${asOf}
      AND ${postedCounterpart(
        allocations === 'ar_allocations' ? 'ar_documents' : 'ap_documents',
        allocations === 'ar_allocations' ? 'invoice_id' : 'bill_id',
        asOf,
      )}
  )`;
}

/** `SUM` arrives as a DECIMAL string; `COALESCE(..., 0)` over no rows as a number. */
function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
