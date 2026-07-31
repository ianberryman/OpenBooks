import type { TaxRateApplicability } from '@openbooks/shared-types';
import { sql } from 'kysely';
import type { Expression, RawBuilder, SqlBool } from 'kysely';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import type { ResolvedLineTag } from '../dimensions';

import type { ArDocumentKind } from './kinds';

/**
 * Data access for `ar_documents` and its lines (OB-062).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement
 * before this file adds a predicate: a cross-org document id matches nothing and
 * the service's `assertFound` turns that into the one error a miss may produce
 * (A7).
 *
 * ## Nothing here reads or writes a balance or a status
 *
 * There is no `outstanding_minor` column and no `status` column to select — D-34
 * and D-38, which `0005_subledger` implements by simply not having them. What is
 * stored is what caused the state: `journal_id`, `void_journal_id`, and the
 * allocations in another table. So every "what is left on this document" number in
 * this file is a `SUM` computed at read time.
 *
 * `SUM` over a `BIGINT` column yields `DECIMAL`, which the driver returns as a
 * string (`decimalNumbers: false`); a plain `BIGINT` column arrives as a `bigint`.
 * `toBigInt` normalizes, exactly as `trial-balance.service.ts` does, and matters for
 * the same reason: a `Number()` here would reintroduce the precision loss the whole
 * money design exists to avoid.
 *
 * The detail read sums in memory instead — it already holds every line and every
 * allocation, and one traversal cannot disagree with itself. The expressions below
 * exist for the *list*, which has to filter on a derived status before it pages.
 */

const DOCUMENT_COLUMNS = [
  'id',
  'document_type',
  'sequence_number',
  'contact_id',
  'issue_date',
  'due_date',
  'payment_term_id',
  'tax_mode',
  'reference',
  'memo',
  'journal_id',
  'void_journal_id',
  'created_at',
  'updated_at',
] as const;

const LINE_COLUMNS = [
  'id',
  'line_number',
  'description',
  'quantity_micros',
  'unit_amount_minor',
  'account_id',
  'tax_rate_id',
  'catalog_item_id',
  'line_amount_minor',
  'tax_amount_minor',
] as const;

export interface DocumentRow {
  readonly id: Buffer;
  readonly document_type: 'credit_note' | 'invoice';
  readonly sequence_number: bigint | null;
  readonly contact_id: Buffer;
  readonly issue_date: string;
  readonly due_date: string | null;
  /** The term this document was raised under, contact-default or override (OB-136, D-108). */
  readonly payment_term_id: Buffer | null;
  readonly tax_mode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journal_id: Buffer | null;
  readonly void_journal_id: Buffer | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DocumentLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly description: string | null;
  readonly quantity_micros: bigint;
  readonly unit_amount_minor: bigint;
  readonly account_id: Buffer;
  readonly tax_rate_id: Buffer | null;
  /** The catalog item this line was selected from, provenance only (D-CAT-2). */
  readonly catalog_item_id: Buffer | null;
  readonly line_amount_minor: bigint;
  readonly tax_amount_minor: bigint;
}

/** A document plus the three sums a summary needs, from one statement. */
export interface DocumentPageRow extends DocumentRow {
  readonly net: string | number | bigint;
  readonly tax: string | number | bigint;
  readonly allocated: string | number | bigint;
}

export interface NewDocumentRow {
  readonly createdByUserId: Buffer;
  readonly documentType: 'credit_note' | 'invoice';
  readonly contactId: Buffer;
  readonly issueDate: string;
  readonly dueDate: string | null;
  /** Null on a credit note (OB-136) — nothing about one falls due or earns a discount. */
  readonly paymentTermId: Buffer | null;
  readonly taxMode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
}

export interface DocumentPatch {
  readonly contactId?: Buffer;
  readonly issueDate?: string;
  readonly dueDate?: string;
  readonly taxMode?: 'exclusive' | 'inclusive';
  readonly reference?: string | null;
  readonly memo?: string | null;
}

/** A line as the service has priced it: ids as bytes, both roundings already made. */
export interface NewDocumentLineRow {
  readonly lineNumber: number;
  readonly description: string;
  readonly quantityMicros: bigint;
  readonly unitAmountMinor: bigint;
  readonly accountId: Buffer;
  readonly taxRateId: Buffer | null;
  /** The catalog item this line was selected from, or null for a free-form line (D-CAT-2). */
  readonly catalogItemId: Buffer | null;
  readonly lineAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
  /** `(dimension, value)` pairs, the axis already resolved from the value (D-18). */
  readonly dimensions: readonly ResolvedLineTag[];
}

export interface TaxRateRow {
  readonly id: Buffer;
  readonly name: string;
  readonly rate_ppm: number;
  readonly tax_account_id: Buffer;
  /** Which documents may cite the rate (D-35). Checked in `resolveLines`. */
  readonly applies_to: TaxRateApplicability;
  readonly is_active: number;
}

export interface AllocationRow {
  readonly id: Buffer;
  readonly invoice_id: Buffer;
  readonly payment_id: Buffer | null;
  readonly credit_note_id: Buffer | null;
  // The third source `chk_ar_allocations_one_source` permits (D-106): a settlement
  // discount's own posted journal. Selected so a discounted invoice can be read
  // individually — omitting it made `getInvoice` throw on any invoice ever discounted.
  readonly discount_journal_id: Buffer | null;
  readonly amount_minor: bigint;
  readonly allocated_on: string;
  readonly created_at: Date;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied document id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function documentIdBytes(documentId: string): Buffer | undefined {
  return tryUuidToBuffer(documentId);
}

export function newDocumentId(): Buffer {
  return newUuidBuffer();
}

export async function insertDocument(
  db: TenantDatabase,
  id: Buffer,
  input: NewDocumentRow,
): Promise<void> {
  await db
    .insertInto('ar_documents')
    .values({
      id,
      document_type: input.documentType,
      contact_id: input.contactId,
      issue_date: input.issueDate,
      due_date: input.dueDate,
      payment_term_id: input.paymentTermId,
      tax_mode: input.taxMode,
      reference: input.reference,
      memo: input.memo,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectDocumentById(
  db: TenantDatabase,
  kind: ArDocumentKind,
  id: Buffer,
): Promise<DocumentRow | undefined> {
  return (
    db
      .selectFrom('ar_documents')
      .select(DOCUMENT_COLUMNS)
      .where('ar_documents.id', '=', id)
      // The type is part of the identity, not a filter: an invoice id handed to
      // `getCreditNote` must be a miss and not a credit note with a due date. One
      // table holds both (D-39 is about the *document* being its own thing, not
      // about the storage), so the predicate is what keeps the two resources
      // separate — and it produces the same 404 a cross-org id produces (A7).
      .where('ar_documents.document_type', '=', kind.documentType)
      .executeTakeFirst()
  );
}

/**
 * The same read, taking an exclusive row lock.
 *
 * This is the serialization point for every write to a document, and for the
 * approval and the void. Two callers approving one invoice both reach this
 * statement; the second blocks until the first commits and then sees a row that
 * already carries a journal, which is what turns "two approvals" into one journal,
 * one number, and one refusal.
 *
 * It only works because `ar_documents` is in `0999_app_grants`'s mutable allowlist
 * — MySQL requires `UPDATE`/`DELETE` alongside `SELECT` for a locking read, which
 * is exactly why the journal tables cannot be locked (D-14) and why the sequence
 * counters are their own tables.
 */
export async function selectDocumentByIdForUpdate(
  db: TenantDatabase,
  kind: ArDocumentKind,
  id: Buffer,
): Promise<DocumentRow | undefined> {
  return db
    .selectFrom('ar_documents')
    .select(DOCUMENT_COLUMNS)
    .where('ar_documents.id', '=', id)
    .where('ar_documents.document_type', '=', kind.documentType)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Applies the header patch, and always writes `updated_at`.
 *
 * `ON UPDATE CURRENT_TIMESTAMP(3)` only fires when some column's value actually
 * changes, so an edit that replaced only the *lines* would leave the header's
 * `updated_at` at the moment the document was created — and a list labelled by last
 * edit would be wrong in exactly the case a user notices. The same reason
 * `updateDraftRow` writes it explicitly.
 */
export async function updateDocumentRow(
  db: TenantDatabase,
  id: Buffer,
  patch: DocumentPatch,
  now: Date,
): Promise<void> {
  await db
    .updateTable('ar_documents')
    .set({
      ...(patch.contactId === undefined ? {} : { contact_id: patch.contactId }),
      ...(patch.issueDate === undefined ? {} : { issue_date: patch.issueDate }),
      ...(patch.dueDate === undefined ? {} : { due_date: patch.dueDate }),
      ...(patch.taxMode === undefined ? {} : { tax_mode: patch.taxMode }),
      ...(patch.reference === undefined ? {} : { reference: patch.reference }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      updated_at: now,
    })
    .where('ar_documents.id', '=', id)
    .execute();
}

/**
 * Writes the two columns that make a document approved, together.
 *
 * `chk_ar_documents_approved` asserts `(journal_id IS NULL) = (sequence_number IS
 * NULL)`, so this pair cannot be written apart: a number without a journal, or a
 * journal without a number, is refused by the database rather than avoided by this
 * code. That is what makes a partial approve unrepresentable rather than merely
 * unlikely (D-38).
 */
export async function markApproved(
  db: TenantDatabase,
  id: Buffer,
  sequenceNumber: bigint,
  journalId: Buffer,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('ar_documents')
    .set({ sequence_number: sequenceNumber, journal_id: journalId, updated_at: now })
    .where('ar_documents.id', '=', id)
    // Belt to the row lock's braces: an approval can only ever move a document out
    // of the draft state, so a row that already carries a journal is not updated
    // even if the lock above were somehow lost.
    .where('ar_documents.journal_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

export async function markVoided(
  db: TenantDatabase,
  id: Buffer,
  voidJournalId: Buffer,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('ar_documents')
    .set({ void_journal_id: voidJournalId, updated_at: now })
    .where('ar_documents.id', '=', id)
    .where('ar_documents.void_journal_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Deletes a document and, through `ON DELETE CASCADE`, its lines and their tags.
 *
 * Only ever called for a draft, and that restriction is the service's — the schema
 * cannot express "not once a journal exists", because MySQL has no CHECK over a
 * `DELETE`. Returns the row count so the caller can tell "deleted" from "was not
 * there", which is exact for a `DELETE` and not knowable from an `UPDATE`.
 */
export async function deleteDocumentRow(db: TenantDatabase, id: Buffer): Promise<number> {
  const result = await db
    .deleteFrom('ar_documents')
    .where('ar_documents.id', '=', id)
    .where('ar_documents.journal_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}

export async function selectDocumentLines(
  db: TenantDatabase,
  documentId: Buffer,
): Promise<readonly DocumentLineRow[]> {
  return db
    .selectFrom('ar_document_lines')
    .select(LINE_COLUMNS)
    .where('ar_document_lines.document_id', '=', documentId)
    .orderBy('ar_document_lines.line_number')
    .execute();
}

/** The tags on a set of document lines, keyed by line id. */
export async function selectLineDimensions(
  db: TenantDatabase,
  lineIds: readonly bigint[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const tags = new Map<string, string[]>();
  if (lineIds.length === 0) return tags;

  const rows = await db
    .selectFrom('ar_document_line_dimensions')
    .select(['document_line_id', 'dimension_value_id'])
    .where('ar_document_line_dimensions.document_line_id', 'in', lineIds)
    .orderBy('ar_document_line_dimensions.dimension_id')
    .execute();

  for (const row of rows) {
    const key = row.document_line_id.toString();
    const existing = tags.get(key);
    if (existing === undefined) {
      tags.set(key, [bufferToUuid(row.dimension_value_id)]);
    } else {
      existing.push(bufferToUuid(row.dimension_value_id));
    }
  }

  return tags;
}

/**
 * Replaces a document's lines wholesale.
 *
 * Delete-then-insert rather than a diff, because `lines` on the wire is a whole set
 * (see `updateInvoiceRequestSchema`) and a diff would have to invent stable line
 * identities to compare against. The tags go with the lines through
 * `ON DELETE CASCADE`, so nothing here has to remember them.
 *
 * The line ids are read back rather than derived from the insert's `insertId`:
 * mysql2 returns the id of the *first* row of a multi-row insert, and deriving the
 * rest by adding one assumes a contiguous auto-increment block — true today and not
 * true under `innodb_autoinc_lock_mode = 2` with concurrent inserts, which is the
 * default in MySQL 8.
 */
export async function replaceDocumentLines(
  db: TenantDatabase,
  documentId: Buffer,
  lines: readonly NewDocumentLineRow[],
): Promise<void> {
  await db
    .deleteFrom('ar_document_lines')
    .where('ar_document_lines.document_id', '=', documentId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('ar_document_lines')
    .values(
      lines.map((line) => ({
        document_id: documentId,
        line_number: line.lineNumber,
        description: line.description,
        quantity_micros: line.quantityMicros,
        unit_amount_minor: line.unitAmountMinor,
        account_id: line.accountId,
        tax_rate_id: line.taxRateId,
        catalog_item_id: line.catalogItemId,
        line_amount_minor: line.lineAmountMinor,
        tax_amount_minor: line.taxAmountMinor,
      })),
    )
    .execute();

  const tagged = lines.filter((line) => line.dimensions.length > 0);
  if (tagged.length === 0) return;

  const idsByLineNumber = new Map(
    (await selectDocumentLines(db, documentId)).map((row) => [row.line_number, row.id]),
  );

  await db
    .insertInto('ar_document_line_dimensions')
    .values(
      tagged.flatMap((line) =>
        line.dimensions.map((tag) => ({
          // Present by construction: the lines were just inserted under this
          // document, and `uq_ar_document_lines_document_line` makes the number
          // unique within it. `?? 0n` would attach a tag to another document's
          // line, so the impossible case throws instead.
          document_line_id: idsByLineNumber.get(line.lineNumber) ?? missingLine(line.lineNumber),
          dimension_id: tag.dimensionId,
          dimension_value_id: tag.dimensionValueId,
        })),
      ),
    )
    .execute();
}

/**
 * Rewrites one line's two computed amounts, leaving its inputs and its tags alone.
 *
 * The narrow update a repricing needs (a `taxMode` change on a draft): the quantity,
 * the unit amount and the rate are unchanged, so replacing the line would issue a
 * new id and re-insert its tags for a change to neither.
 */
export async function updateLineAmounts(
  db: TenantDatabase,
  lineId: bigint,
  lineAmountMinor: bigint,
  taxAmountMinor: bigint,
): Promise<void> {
  await db
    .updateTable('ar_document_lines')
    .set({ line_amount_minor: lineAmountMinor, tax_amount_minor: taxAmountMinor })
    .where('ar_document_lines.id', '=', lineId)
    .execute();
}

/**
 * The next number in this org's series for this document type, taken `FOR UPDATE`
 * (D-36).
 *
 * `allocateSequenceNumber` in `posting.repository.ts` is the pattern and D-14 is
 * the argument, applied to documents: the number is what a customer, an auditor and
 * a bank statement cite, and a gap in it is indistinguishable from a deleted
 * document. `AUTO_INCREMENT` leaves gaps on rollback, so the counter is a row held
 * for the life of the transaction that issues from it — a rolled-back approval
 * therefore consumes nothing.
 *
 * The insert-then-lock shape exists because the counter row is created lazily: an
 * org has no row until its first document of a type, and `ON DUPLICATE KEY UPDATE`
 * setting the key to itself makes the create idempotent under contention rather
 * than a duplicate-key error for whichever caller arrives second.
 *
 * The key is `(org_id, document_type)`, so issuing an invoice number does not
 * serialize against issuing a credit note number — the two are separate series to
 * the people who read them (D-36).
 */
export async function allocateDocumentNumber(
  db: TenantDatabase,
  documentType: 'credit_note' | 'invoice',
): Promise<bigint> {
  await db
    .insertInto('document_sequences')
    .values({ document_type: documentType, next_value: 1n })
    .onDuplicateKeyUpdate({ document_type: documentType })
    .execute();

  const counter = await db
    .selectFrom('document_sequences')
    .select('next_value')
    .where('document_sequences.document_type', '=', documentType)
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('document_sequences')
    .set({ next_value: counter.next_value + 1n })
    .where('document_sequences.document_type', '=', documentType)
    .execute();

  return counter.next_value;
}

/**
 * The rates a set of lines cite, keyed by hex id.
 *
 * Read through the tenant wrapper, so another org's rate is not merely rejected —
 * it does not appear, and the caller reports it as unknown rather than letting
 * `fk_ar_document_lines_tax_rate` answer with errno 1452 and a 500 (A7).
 */
export async function selectTaxRates(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, TaxRateRow>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .selectFrom('tax_rates')
    .select(['id', 'name', 'rate_ppm', 'tax_account_id', 'applies_to', 'is_active'])
    .where('tax_rates.id', 'in', ids)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row]));
}

/** Which of `ids` are accounts of this org, as hex keys. */
export async function selectExistingAccountIds(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();

  const rows = await db
    .selectFrom('accounts')
    .select('id')
    .where('accounts.id', 'in', ids)
    .execute();
  return new Set(rows.map((row) => row.id.toString('hex')));
}

export async function selectContact(
  db: TenantDatabase,
  id: Buffer,
): Promise<{ readonly is_active: number; readonly is_customer: number } | undefined> {
  return db
    .selectFrom('contacts')
    .select(['is_active', 'is_customer'])
    .where('contacts.id', '=', id)
    .executeTakeFirst();
}

/**
 * The allocations against one document, whichever end of them it is.
 *
 * An invoice is the *target* of its allocations and a credit note is the *source*
 * of its own, which is one query with one column swapped rather than two, because
 * they are one mechanism (D-39): the same table answers "what has reduced this
 * invoice" and "what has this credit note been applied to".
 */
export async function selectAllocations(
  db: TenantDatabase,
  kind: ArDocumentKind,
  documentId: Buffer,
): Promise<readonly AllocationRow[]> {
  return db
    .selectFrom('ar_allocations')
    .select([
      'id',
      'invoice_id',
      'payment_id',
      'credit_note_id',
      'discount_journal_id',
      'amount_minor',
      'allocated_on',
      'created_at',
    ])
    .where(`ar_allocations.${kind.allocationColumn}`, '=', documentId)
    .orderBy('ar_allocations.allocated_on')
    .orderBy('ar_allocations.id')
    .execute();
}

/** The document numbers behind a set of ids, for naming the far end of an allocation. */
export async function selectDocumentNumbers(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, bigint | null>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .selectFrom('ar_documents')
    .select(['id', 'sequence_number'])
    .where('ar_documents.id', 'in', ids)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.sequence_number]));
}

// ---------------------------------------------------------------------------
// The computed numbers: totals and allocations, never stored (D-34)
// ---------------------------------------------------------------------------

/**
 * The three sums as correlated subqueries rather than joins.
 *
 * A `LEFT JOIN` to `ar_document_lines` *and* to `ar_allocations` in one statement
 * multiplies rows — a two-line invoice with three allocations produces six — and
 * both sums come back wrong in a way that looks plausible. Correlated subqueries
 * cannot fan out, and each reads an index that exists for it
 * (`idx_ar_document_lines_org_document`, `idx_ar_allocations_org_invoice`).
 *
 * The correlation is on `ar_documents.org_id` as well as the id, so the subquery is
 * confined to the same org as the row it decorates without this file restating the
 * scope `tenantDb` already applied to the outer query.
 */
const NET_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.line_amount_minor), 0) FROM ar_document_lines l
  WHERE l.org_id = ar_documents.org_id AND l.document_id = ar_documents.id
)`;

const TAX_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.tax_amount_minor), 0) FROM ar_document_lines l
  WHERE l.org_id = ar_documents.org_id AND l.document_id = ar_documents.id
)`;

const GROSS_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.line_amount_minor + l.tax_amount_minor), 0) FROM ar_document_lines l
  WHERE l.org_id = ar_documents.org_id AND l.document_id = ar_documents.id
)`;

/**
 * Written twice rather than once with the column interpolated, so both statements
 * are fixed text: the allocation table names its two ends differently and a
 * `sql.ref` built from a variable is one refactor away from being built from an
 * argument.
 */
const ALLOCATED_TO_INVOICE = sql<string>`(
  SELECT COALESCE(SUM(a.amount_minor), 0) FROM ar_allocations a
  WHERE a.org_id = ar_documents.org_id AND a.invoice_id = ar_documents.id
)`;

const ALLOCATED_FROM_CREDIT_NOTE = sql<string>`(
  SELECT COALESCE(SUM(a.amount_minor), 0) FROM ar_allocations a
  WHERE a.org_id = ar_documents.org_id AND a.credit_note_id = ar_documents.id
)`;

function allocatedExpression(kind: ArDocumentKind): RawBuilder<string> {
  return kind.allocationColumn === 'invoice_id' ? ALLOCATED_TO_INVOICE : ALLOCATED_FROM_CREDIT_NOTE;
}

/** `SUM` columns arrive as a DECIMAL string; plain `BIGINT` columns as a `bigint`. */
export function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

export interface DocumentFilters {
  readonly cursor?: string | undefined;
  readonly contactId?: Buffer | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly dueBefore?: string | undefined;
  readonly status?: 'approved' | 'draft' | 'paid' | 'part_paid' | 'void' | undefined;
  readonly unappliedOnly?: boolean | undefined;
}

/**
 * `(created_at, id)` — D-21's ordering, and the only one available (see
 * `invoicePageSchema`).
 *
 * The document number is what a person would sort by and it cannot be a keyset: a
 * draft has none until approval, so the column is NULL for exactly the rows a
 * drafts-included list has to page. `issue_date` is editable while a document is a
 * draft, and a keyset over a mutable column silently drops the rows that moved
 * behind the cursor — the failure D-21 chose keyset to eliminate, reached through a
 * mutable sort key instead of through `OFFSET`. `created_at` is neither null nor
 * editable, and `id` makes it total.
 *
 * Reads `idx_ar_documents_org_created`.
 */
const DOCUMENT_KEYSET: KeysetOrdering<DocumentPageRow> = [
  instantKey('ar_documents.created_at', (row) => row.created_at),
  uuidKey('ar_documents.id', (row) => row.id),
];

/**
 * One page of a type's documents, with the derived status filtered **in the
 * statement**.
 *
 * D-34's accepted cost, made concrete: "unpaid invoices" is a comparison against a
 * sum over another table rather than an index lookup on a status column. Filtering
 * after the page was fetched would be cheaper and wrong — a page of twenty rows
 * would come back holding however many of them happened to match, so the page size
 * would depend on the data and a client could not tell a short page from the end of
 * the list.
 */
export async function selectDocumentsPage(
  db: TenantDatabase,
  kind: ArDocumentKind,
  filters: DocumentFilters,
  limit: number,
): Promise<KeysetPage<DocumentPageRow>> {
  let query = db
    .selectFrom('ar_documents')
    .select([
      ...DOCUMENT_COLUMNS,
      NET_EXPRESSION.as('net'),
      TAX_EXPRESSION.as('tax'),
      allocatedExpression(kind).as('allocated'),
    ])
    .where('ar_documents.document_type', '=', kind.documentType);

  if (filters.contactId !== undefined) {
    query = query.where('ar_documents.contact_id', '=', filters.contactId);
  }
  if (filters.from !== undefined) {
    query = query.where('ar_documents.issue_date', '>=', filters.from);
  }
  if (filters.to !== undefined) {
    query = query.where('ar_documents.issue_date', '<=', filters.to);
  }
  if (filters.dueBefore !== undefined) {
    query = query.where('ar_documents.due_date', '<', filters.dueBefore);
  }
  if (filters.status !== undefined) {
    query = query.where(statusPredicate(kind, filters.status));
  }
  if (filters.unappliedOnly === true) {
    query = query.where(unappliedPredicate(kind));
  }

  const rows = await applyKeyset(query, DOCUMENT_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, DOCUMENT_KEYSET, limit);
}

/**
 * The status enum as a predicate over the columns that cause it (D-38).
 *
 * The same derivation `documentStatus` applies in memory, restated in SQL because a
 * list has to filter before it pages. The two are asserted equal by test rather than
 * kept in step by care: every case here is exercised through `listInvoices` and
 * compared against the status the detail read reports.
 */
function statusPredicate(
  kind: ArDocumentKind,
  status: 'approved' | 'draft' | 'paid' | 'part_paid' | 'void',
): Expression<SqlBool> {
  const allocated = allocatedExpression(kind);

  switch (status) {
    case 'draft':
      return sql<SqlBool>`ar_documents.journal_id IS NULL`;
    case 'void':
      return sql<SqlBool>`ar_documents.void_journal_id IS NOT NULL`;
    case 'approved':
      return sql<SqlBool>`ar_documents.journal_id IS NOT NULL
        AND ar_documents.void_journal_id IS NULL
        AND ${allocated} = 0`;
    case 'part_paid':
      return sql<SqlBool>`ar_documents.journal_id IS NOT NULL
        AND ar_documents.void_journal_id IS NULL
        AND ${allocated} > 0 AND ${allocated} < ${GROSS_EXPRESSION}`;
    case 'paid':
      return sql<SqlBool>`ar_documents.journal_id IS NOT NULL
        AND ar_documents.void_journal_id IS NULL
        AND ${allocated} > 0 AND ${allocated} >= ${GROSS_EXPRESSION}`;
  }
}

/** Approved, not void, and with something left on it — the "apply a credit" list. */
function unappliedPredicate(kind: ArDocumentKind): Expression<SqlBool> {
  return sql<SqlBool>`ar_documents.journal_id IS NOT NULL
    AND ar_documents.void_journal_id IS NULL
    AND ${allocatedExpression(kind)} < ${GROSS_EXPRESSION}`;
}

function missingLine(lineNumber: number): never {
  throw new Error(
    `Document line ${String(lineNumber)} was inserted and could not be read back; its tags ` +
      'cannot be attached to a line that is not there.',
  );
}
