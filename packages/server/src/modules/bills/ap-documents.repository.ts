import type { TaxRateApplicability } from '@openbooks/shared-types';

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

/**
 * Data access for `ap_documents` and everything hanging off it (OB-063).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate: a cross-org document id matches
 * nothing and the service's `assertFound` turns that into the one error a miss is
 * allowed to produce (A7).
 *
 * These tables are in `0999_app_grants`'s mutable allowlist, which is what makes
 * `selectDocumentByIdForUpdate` and `claimDocumentNumber` possible at all — the
 * journal tables cannot be locked, because MySQL requires `UPDATE`/`DELETE`
 * alongside `SELECT` for a locking read and withholding exactly those is how
 * immutability is enforced (D-14). The migration's own header says so: "because
 * these tables are mutable, the app user *can* take a locking read on them".
 *
 * ## Nothing here writes a journal
 *
 * `openbooks/no-journal-writes` confines `journals` and `journal_lines` to
 * `posting.repository.ts`, and this module never reaches for them. Approving
 * calls `postJournal`, voiding calls `reverseJournal`, and the only thing written
 * back here is the pair of id columns that record which journals happened
 * (`journal_id`, `void_journal_id`) — which is the whole of D-38's lifecycle.
 */

/** The two documents this module owns. `document_type` carries the direction. */
export type ApDocumentType = 'bill' | 'vendor_credit';

/**
 * The resource token a miss reports (A7).
 *
 * One token per document type, so "no such bill" and "no such vendor credit" are
 * the honest answers — and, more importantly, so asking for a vendor credit by a
 * bill's id is a miss rather than a document of the wrong kind. Every read below
 * filters on `document_type`, which is what makes the two id spaces disjoint to a
 * caller even though they share a table.
 */
export const AP_DOCUMENT_RESOURCE: Readonly<Record<ApDocumentType, string>> = {
  bill: 'bill',
  vendor_credit: 'vendor_credit',
};

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
  'created_by_user_id',
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
  'line_amount_minor',
  'tax_amount_minor',
] as const;

export interface ApDocumentRow {
  readonly id: Buffer;
  readonly document_type: ApDocumentType;
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
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ApDocumentLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly description: string | null;
  readonly quantity_micros: bigint;
  readonly unit_amount_minor: bigint;
  readonly account_id: Buffer;
  readonly tax_rate_id: Buffer | null;
  readonly line_amount_minor: bigint;
  readonly tax_amount_minor: bigint;
}

export interface NewApDocumentRow {
  readonly documentType: ApDocumentType;
  readonly createdByUserId: Buffer;
  readonly contactId: Buffer;
  readonly issueDate: string;
  readonly dueDate: string | null;
  /** Null on a vendor credit (OB-136) — nothing about one falls due or earns a discount. */
  readonly paymentTermId: Buffer | null;
  readonly taxMode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
}

export interface ApDocumentPatch {
  readonly contactId?: Buffer;
  readonly issueDate?: string;
  readonly dueDate?: string | null;
  readonly taxMode?: 'exclusive' | 'inclusive';
  readonly reference?: string | null;
  readonly memo?: string | null;
}

/** A line as the service priced it: ids as bytes, both roundings already applied. */
export interface NewApDocumentLineRow {
  readonly lineNumber: number;
  readonly description: string | null;
  readonly quantityMicros: bigint;
  readonly unitAmountMinor: bigint;
  readonly accountId: Buffer;
  readonly taxRateId: Buffer | null;
  readonly lineAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
  /** `(dimension, value)` pairs, the axis already resolved from the value (D-18). */
  readonly dimensions: readonly { readonly dimensionId: Buffer; readonly valueId: Buffer }[];
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

export interface ContactRow {
  readonly id: Buffer;
  readonly is_vendor: number;
  readonly is_active: number;
}

export interface AccountRow {
  readonly id: Buffer;
  readonly code: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly is_active: number;
}

export interface AllocationRow {
  readonly id: Buffer;
  readonly bill_id: Buffer;
  readonly payment_id: Buffer | null;
  readonly vendor_credit_id: Buffer | null;
  // The third source `chk_ap_allocations_one_source` permits (D-106): a settlement
  // discount's own posted journal. Selected so a discounted bill can be read
  // individually — omitting it made `getBill` throw on any bill ever discounted.
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

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export async function insertDocument(
  db: TenantDatabase,
  id: Buffer,
  input: NewApDocumentRow,
): Promise<void> {
  await db
    .insertInto('ap_documents')
    .values({
      id,
      document_type: input.documentType,
      created_by_user_id: input.createdByUserId,
      contact_id: input.contactId,
      issue_date: input.issueDate,
      due_date: input.dueDate,
      payment_term_id: input.paymentTermId,
      tax_mode: input.taxMode,
      reference: input.reference,
      memo: input.memo,
    })
    .execute();
}

export async function selectDocumentById(
  db: TenantDatabase,
  id: Buffer,
  documentType: ApDocumentType,
): Promise<ApDocumentRow | undefined> {
  return db
    .selectFrom('ap_documents')
    .select(DOCUMENT_COLUMNS)
    .where('ap_documents.id', '=', id)
    .where('ap_documents.document_type', '=', documentType)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * This is the serialization point for every write to a document, and for the
 * approval. Two callers approving one bill both reach this statement; the second
 * blocks until the first commits, and then sees `journal_id` set — which is what
 * turns "two approvals of one bill" into one journal, one number, and one
 * refusal. It only works because `ap_documents` is in `0999_app_grants`'s mutable
 * allowlist (D-14 explains why the ledger tables cannot do this).
 */
export async function selectDocumentByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
  documentType: ApDocumentType,
): Promise<ApDocumentRow | undefined> {
  return db
    .selectFrom('ap_documents')
    .select(DOCUMENT_COLUMNS)
    .where('ap_documents.id', '=', id)
    .where('ap_documents.document_type', '=', documentType)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Applies the header patch, and always writes `updated_at`.
 *
 * `ON UPDATE CURRENT_TIMESTAMP(3)` only fires when some column's value actually
 * changes, so an edit that replaced only the *lines* would leave the header's
 * `updated_at` at the moment the document was created — and a list sorted or
 * labelled by last edit would then be wrong in exactly the case a user notices.
 * The same reason `updateDraftRow` writes it by hand.
 */
export async function updateDocumentRow(
  db: TenantDatabase,
  id: Buffer,
  patch: ApDocumentPatch,
  now: Date,
): Promise<void> {
  await db
    .updateTable('ap_documents')
    .set({
      ...(patch.contactId === undefined ? {} : { contact_id: patch.contactId }),
      ...(patch.issueDate === undefined ? {} : { issue_date: patch.issueDate }),
      ...(patch.dueDate === undefined ? {} : { due_date: patch.dueDate }),
      ...(patch.taxMode === undefined ? {} : { tax_mode: patch.taxMode }),
      ...(patch.reference === undefined ? {} : { reference: patch.reference }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      updated_at: now,
    })
    .where('ap_documents.id', '=', id)
    .execute();
}

/**
 * Records the approval: the number and the journal, together, in one statement.
 *
 * `chk_ap_documents_approved` requires `(journal_id IS NULL) = (sequence_number IS
 * NULL)`, so writing them in two statements would be inexpressible rather than
 * merely untidy — the first would violate the CHECK. That constraint is what makes
 * "approval is one transaction or it did not happen" a property of the schema
 * instead of a rule this file remembers.
 *
 * The `journal_id IS NULL` predicate is belt to the row lock's braces: the caller
 * holds the row `FOR UPDATE` and has already read it as a draft, so a zero here
 * cannot happen — and if it ever does, the caller reports a fault rather than
 * committing a journal whose document forgot to point at it.
 */
export async function approveDocumentRow(
  db: TenantDatabase,
  id: Buffer,
  sequenceNumber: bigint,
  journalId: Buffer,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('ap_documents')
    .set({ sequence_number: sequenceNumber, journal_id: journalId, updated_at: now })
    .where('ap_documents.id', '=', id)
    .where('ap_documents.journal_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/** Records the void: the reversing journal, never a deletion (D-16, D-38). */
export async function voidDocumentRow(
  db: TenantDatabase,
  id: Buffer,
  voidJournalId: Buffer,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('ap_documents')
    .set({ void_journal_id: voidJournalId, updated_at: now })
    .where('ap_documents.id', '=', id)
    .where('ap_documents.void_journal_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Discards a draft, and with it its lines and their tags.
 *
 * The `journal_id IS NULL` predicate is not a nicety: it is what makes discarding
 * an approved document impossible from this path, which the schema cannot say —
 * MySQL has no CHECK over another table's rows and this project runs no triggers,
 * so `0005_subledger` names the AP service as where the rule lives.
 *
 * Returns the row count so the caller can tell "discarded" from "was not there",
 * which is exact for a `DELETE`.
 */
export async function deleteDraftDocument(
  db: TenantDatabase,
  id: Buffer,
  documentType: ApDocumentType,
): Promise<number> {
  const result = await db
    .deleteFrom('ap_documents')
    .where('ap_documents.id', '=', id)
    .where('ap_documents.document_type', '=', documentType)
    .where('ap_documents.journal_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export async function selectDocumentLines(
  db: TenantDatabase,
  documentId: Buffer,
): Promise<readonly ApDocumentLineRow[]> {
  return db
    .selectFrom('ap_document_lines')
    .select(LINE_COLUMNS)
    .where('ap_document_lines.document_id', '=', documentId)
    .orderBy('ap_document_lines.line_number')
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
    .selectFrom('ap_document_line_dimensions')
    .select(['document_line_id', 'dimension_value_id'])
    .where('ap_document_line_dimensions.document_line_id', 'in', lineIds)
    .orderBy('ap_document_line_dimensions.dimension_id')
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
 * Delete-then-insert rather than a diff, because `lines` on the wire is a whole
 * set (`updateBillRequestSchema`) and a diff would have to invent stable line
 * identities to compare against. The tags go with the lines through
 * `ON DELETE CASCADE`, so nothing here has to remember them.
 *
 * The line ids are read back rather than derived from the insert's `insertId`:
 * mysql2 returns the id of the *first* row of a multi-row insert, and deriving the
 * rest by adding one assumes a contiguous auto-increment block — true today and
 * not true under `innodb_autoinc_lock_mode = 2` with concurrent inserts, which is
 * MySQL 8's default. `replaceDraftLines` states this at length; the same applies.
 */
export async function replaceDocumentLines(
  db: TenantDatabase,
  documentId: Buffer,
  lines: readonly NewApDocumentLineRow[],
): Promise<void> {
  await db
    .deleteFrom('ap_document_lines')
    .where('ap_document_lines.document_id', '=', documentId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('ap_document_lines')
    .values(
      lines.map((line) => ({
        document_id: documentId,
        line_number: line.lineNumber,
        description: line.description,
        quantity_micros: line.quantityMicros,
        unit_amount_minor: line.unitAmountMinor,
        account_id: line.accountId,
        tax_rate_id: line.taxRateId,
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
    .insertInto('ap_document_line_dimensions')
    .values(
      tagged.flatMap((line) =>
        line.dimensions.map((tag) => ({
          // Present by construction: the lines were just inserted under this
          // document, and `uq_ap_document_lines_document_line` makes the number
          // unique within it. `?? 0n` would file a tag against another document's
          // line, so the impossible case throws instead.
          document_line_id:
            idsByLineNumber.get(line.lineNumber) ?? missingDocumentLine(line.lineNumber),
          dimension_id: tag.dimensionId,
          dimension_value_id: tag.valueId,
        })),
      ),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// The number (D-36)
// ---------------------------------------------------------------------------

/**
 * Claims the next number for this org and this document type, gaplessly (D-36).
 *
 * `allocateSequenceNumber` in `posting.repository.ts` is the pattern and D-14 is
 * the argument: `AUTO_INCREMENT` leaves gaps on rollback, and a gap in a document
 * series is indistinguishable from a deleted document — precisely the ambiguity an
 * append-only system exists to remove. So the counter is a row taken `FOR UPDATE`
 * inside the issuing transaction and released only at commit.
 *
 * The insert-then-lock shape exists because the row may not be there: the first
 * bill an org ever approves has no counter, and `INSERT … ON DUPLICATE KEY UPDATE`
 * creates it or takes the lock on it in one statement without a race between a
 * check and an insert.
 *
 * `(org_id, document_type)` is the primary key, so this lock is **per series**:
 * approving a bill does not serialize against approving a vendor credit, and
 * neither serializes against an invoice. That narrowing is also what makes it safe
 * for the duplicate-reference check to ride on this lock — see `approveDocument`.
 */
export async function claimDocumentNumber(
  db: TenantDatabase,
  documentType: ApDocumentType,
): Promise<bigint> {
  await db
    .insertInto('document_sequences')
    .values({ document_type: documentType, next_value: 1n })
    .onDuplicateKeyUpdate({ org_id: db.orgId })
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
 * Approved, un-voided bills for one vendor carrying one reference (D-36).
 *
 * The read that answers "have we already entered this vendor's invoice number".
 * Drafts are excluded because a draft has not been entered yet in the sense that
 * matters — it has told the ledger nothing and can still be discarded — and voided
 * bills are excluded because re-entering a bill after voiding it is the legitimate
 * case this check must not block.
 *
 * The comparison is `=` on a `utf8mb4_0900_ai_ci` column, so it is already
 * case- and accent-insensitive: `INV-1001` and `inv-1001` are the same vendor
 * invoice, which is what a person holding the paper would say.
 *
 * ## `FOR UPDATE`, and it is not about locking
 *
 * A plain `SELECT` here is a **consistent read**, served from the read view
 * InnoDB created at this transaction's first plain read — which, in an approval,
 * is the statement that fetched the document's lines, long before the counter was
 * claimed. Under contention the winner commits *after* that read view exists, so
 * a plain read cannot see the winner's bill and the second approval slips through.
 *
 * That is not a hypothesis. It is what the first version of this query did, and
 * `approve-race.test.ts` caught it — the sequential duplicate test passed
 * throughout, which is exactly the failure mode CLAUDE.md's "prove contention,
 * don't assume it" warns about.
 *
 * `FOR UPDATE` makes it a *current* read, which is the only property needed here;
 * the locks it takes are incidental. They are also why the counter is claimed
 * before this runs — see `approveDocument`'s lock order.
 */
export async function selectApprovedWithReference(
  db: TenantDatabase,
  documentType: ApDocumentType,
  contactId: Buffer,
  reference: string,
  excludingId: Buffer,
): Promise<{ readonly id: Buffer; readonly sequence_number: bigint | null } | undefined> {
  return db
    .selectFrom('ap_documents')
    .select(['id', 'sequence_number'])
    .where('ap_documents.document_type', '=', documentType)
    .where('ap_documents.contact_id', '=', contactId)
    .where('ap_documents.reference', '=', reference)
    .where('ap_documents.journal_id', 'is not', null)
    .where('ap_documents.void_journal_id', 'is', null)
    .where('ap_documents.id', '!=', excludingId)
    .orderBy('ap_documents.sequence_number')
    .forUpdate()
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// References the service resolves before writing
// ---------------------------------------------------------------------------

export async function selectContact(
  db: TenantDatabase,
  id: Buffer,
): Promise<ContactRow | undefined> {
  return db
    .selectFrom('contacts')
    .select(['id', 'is_vendor', 'is_active'])
    .where('contacts.id', '=', id)
    .executeTakeFirst();
}

/**
 * Accounts by id, read through the tenant wrapper.
 *
 * The references are checked by *reading* them rather than by letting the foreign
 * keys refuse the insert. Both would refuse, and only this one produces the right
 * error: another org's account id arrives at the database as errno 1452 and
 * becomes a 500, where A7 requires the same 404 a nonexistent id gets. The foreign
 * keys stay as the backstop for the race between this read and the insert.
 */
export async function selectAccounts(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, AccountRow>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .selectFrom('accounts')
    .select(['id', 'code', 'type', 'is_active'])
    .where('accounts.id', 'in', ids)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row]));
}

/**
 * Tax rates by id, keyed by hex.
 *
 * Read straight from the table rather than through OB-066's service, and that is
 * deliberate rather than expedient: this runs inside the document's transaction,
 * needs no permission of its own beyond the one the caller already holds
 * (`resolveTagsForNewLine` makes the same argument for dimension values), and the
 * rates service owns *writing* rates, which this never does.
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

// ---------------------------------------------------------------------------
// Allocations — read only. OB-064 owns every write to these tables.
// ---------------------------------------------------------------------------

/**
 * The allocations touching this document, from either end (D-39).
 *
 * A bill is a *target* (`bill_id`) and a vendor credit is a *source*
 * (`vendor_credit_id`), and one query answers both because `documentSettlementSchema`
 * is one shape for both readings: on a bill `outstanding` is what is still owed, on
 * a vendor credit it is what is still available to apply. That is D-39's payoff —
 * one definition of "what is left", whatever reduced it.
 */
export async function selectAllocationsFor(
  db: TenantDatabase,
  documentId: Buffer,
  documentType: ApDocumentType,
): Promise<readonly AllocationRow[]> {
  const query = db
    .selectFrom('ap_allocations')
    .select([
      'id',
      'bill_id',
      'payment_id',
      'vendor_credit_id',
      'discount_journal_id',
      'amount_minor',
      'allocated_on',
      'created_at',
    ])
    .orderBy('ap_allocations.allocated_on')
    .orderBy('ap_allocations.id');

  return documentType === 'bill'
    ? query.where('ap_allocations.bill_id', '=', documentId).execute()
    : query.where('ap_allocations.vendor_credit_id', '=', documentId).execute();
}

/**
 * Allocated totals for a page of documents, keyed by hex id. Absent means zero.
 *
 * Summed in the application rather than by `SUM(…)` in SQL, and not for style: a
 * `SUM` over a `BIGINT` comes back as a `DECIMAL`, which mysql2 hands over as a
 * string, and the first person to write `Number(row.allocated)` reintroduces
 * exactly the ceiling D-13 exists to remove — on a column
 * `openbooks/no-float-money` cannot see, because by then it is a string. The row
 * count is bounded by the page size, so there is nothing to save.
 */
export async function selectAllocatedTotals(
  db: TenantDatabase,
  documentIds: readonly Buffer[],
  documentType: ApDocumentType,
): Promise<ReadonlyMap<string, bigint>> {
  const totals = new Map<string, bigint>();
  if (documentIds.length === 0) return totals;

  const query = db
    .selectFrom('ap_allocations')
    .select(['bill_id', 'vendor_credit_id', 'amount_minor']);

  const rows =
    documentType === 'bill'
      ? await query.where('ap_allocations.bill_id', 'in', documentIds).execute()
      : await query.where('ap_allocations.vendor_credit_id', 'in', documentIds).execute();

  for (const row of rows) {
    const key = documentType === 'bill' ? row.bill_id : row.vendor_credit_id;
    if (key === null) continue;
    const hex = key.toString('hex');
    totals.set(hex, (totals.get(hex) ?? 0n) + row.amount_minor);
  }

  return totals;
}

/**
 * The numbers of a set of documents, keyed by hex id.
 *
 * An allocation names both ends (`allocationSchema`), and one of them is always a
 * document this view is not: a bill's allocations may cite a vendor credit, and a
 * vendor credit's cite bills. Null for a draft, which cannot be allocated against
 * anyway — the column is NULL until approval (D-36).
 */
export async function selectDocumentNumbers(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, bigint | null>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .selectFrom('ap_documents')
    .select(['id', 'sequence_number'])
    .where('ap_documents.id', 'in', ids)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.sequence_number]));
}

/** The lines of several documents at once, keyed by document hex id. */
export async function selectLinesForDocuments(
  db: TenantDatabase,
  documentIds: readonly Buffer[],
): Promise<ReadonlyMap<string, readonly ApDocumentLineRow[]>> {
  const byDocument = new Map<string, ApDocumentLineRow[]>();
  if (documentIds.length === 0) return byDocument;

  const rows = await db
    .selectFrom('ap_document_lines')
    .select(LINE_COLUMNS)
    .select('document_id')
    .where('ap_document_lines.document_id', 'in', documentIds)
    .orderBy('ap_document_lines.line_number')
    .execute();

  for (const row of rows) {
    const key = row.document_id.toString('hex');
    const existing = byDocument.get(key);
    if (existing === undefined) byDocument.set(key, [row]);
    else existing.push(row);
  }

  return byDocument;
}

// ---------------------------------------------------------------------------
// Listing (D-21)
// ---------------------------------------------------------------------------

/**
 * `(created_at, id)` — D-21's ordering for everything that is not the journal
 * list, and the only total one available here.
 *
 * Not `(issue_date, sequence_number)`, which reads like the natural choice for a
 * numbered document: `sequence_number` is NULL on every draft, so the tuple is not
 * total across the list this function returns, and `issue_date` is editable while
 * a document is a draft — a keyset ordering over a mutable column silently drops
 * rows that move behind a cursor already past them (see `keyset.ts`). Both of
 * these columns are written once.
 *
 * Reads `idx_ap_documents_org_created`.
 */
const DOCUMENT_KEYSET: KeysetOrdering<ApDocumentRow> = [
  instantKey('ap_documents.created_at', (row) => row.created_at),
  uuidKey('ap_documents.id', (row) => row.id),
];

export interface ApDocumentFilters {
  readonly contactId?: Buffer | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly dueBefore?: string | undefined;
  readonly reference?: string | undefined;
  /** `undefined` means every lifecycle state. */
  readonly lifecycle?: 'draft' | 'approved' | 'void' | undefined;
  readonly cursor?: string | undefined;
}

/**
 * One page of this org's documents of one type.
 *
 * The `status` filter is split in two, and the split is D-34 showing through. Three
 * of the five statuses are properties of the row — `draft`, `void`, and
 * "approved, in some state of settlement" — and are predicates here. The other two,
 * `part_paid` and `paid`, are *computed* from the allocations against the document
 * and its own line totals, so they cannot be a `WHERE` clause without the
 * aggregation this design deliberately does not store. The service filters those
 * after assembling the page and says so on `listDocuments`.
 */
export async function selectDocumentsPage(
  db: TenantDatabase,
  documentType: ApDocumentType,
  filters: ApDocumentFilters,
  limit: number,
): Promise<KeysetPage<ApDocumentRow>> {
  let query = db
    .selectFrom('ap_documents')
    .select(DOCUMENT_COLUMNS)
    .where('ap_documents.document_type', '=', documentType);

  if (filters.contactId !== undefined) {
    query = query.where('ap_documents.contact_id', '=', filters.contactId);
  }
  if (filters.from !== undefined) {
    query = query.where('ap_documents.issue_date', '>=', filters.from);
  }
  if (filters.to !== undefined) {
    query = query.where('ap_documents.issue_date', '<=', filters.to);
  }
  if (filters.dueBefore !== undefined) {
    query = query.where('ap_documents.due_date', '<', filters.dueBefore);
  }
  if (filters.reference !== undefined) {
    query = query.where('ap_documents.reference', '=', filters.reference);
  }
  if (filters.lifecycle === 'draft') {
    query = query.where('ap_documents.journal_id', 'is', null);
  }
  if (filters.lifecycle === 'void') {
    query = query.where('ap_documents.void_journal_id', 'is not', null);
  }
  if (filters.lifecycle === 'approved') {
    query = query
      .where('ap_documents.journal_id', 'is not', null)
      .where('ap_documents.void_journal_id', 'is', null);
  }

  const rows = await applyKeyset(query, DOCUMENT_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, DOCUMENT_KEYSET, limit);
}

function missingDocumentLine(lineNumber: number): never {
  throw new Error(
    `AP document line ${String(lineNumber)} was inserted and could not be read back; its tags ` +
      'cannot be attached to a line that is not there.',
  );
}
