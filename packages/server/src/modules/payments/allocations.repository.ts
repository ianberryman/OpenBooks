import type { Allocation, SubledgerDocumentType } from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import { bufferToUuid, newUuidBuffer, tryUuidToBuffer } from '../../db';

import type { SubledgerSide } from '../settings';

/**
 * Data access for allocations — the rows that say what settled what (OB-064;
 * ROADMAP D-37, D-39).
 *
 * ## Two tables, one mechanism
 *
 * `ar_allocations` and `ap_allocations` are mirror images: an amount, a date, a
 * target document, and exactly one source that is either a payment or a credit
 * document. Everything below is written twice, once per side, and dispatched on
 * `SubledgerSide` rather than being made generic over the table name. That is a
 * deliberate cost: Kysely's builder types resolve through the concrete table, and
 * a function generic over `'ar_allocations' | 'ap_allocations'` produces a union
 * of overload sets TypeScript then declines to call — the same problem
 * `withOrgScope` in `tenant.ts` documents. Two legible query bodies are worth more
 * than one clever one, and the pair is short.
 *
 * ## What is *not* here
 *
 * No journal. An allocation moves nothing in the ledger (D-37): a payment's
 * journal has already debited the bank and credited the control account, so a
 * second posting on allocate would double-count and put the subledger out of
 * agreement with the ledger — which is precisely what C2 exists to catch. This
 * file inserts and deletes ordinary mutable rows, and that is the whole of it.
 *
 * No stored outstanding, either. `documentTotal` minus `allocatedToDocument` is
 * what a document has left (D-34), computed on every read.
 */

/** The resource token an allocation miss reports (A7). */
export const ALLOCATION_RESOURCE = 'allocation';

/** The resource token a document miss reports. One token for all four types. */
export const DOCUMENT_RESOURCE = 'document';

export function allocationIdBytes(allocationId: string): Buffer | undefined {
  return tryUuidToBuffer(allocationId);
}

export function documentIdBytes(documentId: string): Buffer | undefined {
  return tryUuidToBuffer(documentId);
}

export interface DocumentRow {
  readonly id: Buffer;
  readonly document_type: SubledgerDocumentType;
  readonly contact_id: Buffer;
  readonly issue_date: string;
  readonly sequence_number: bigint | null;
  readonly journal_id: Buffer | null;
  readonly void_journal_id: Buffer | null;
}

const DOCUMENT_COLUMNS = [
  'id',
  'document_type',
  'contact_id',
  'issue_date',
  'sequence_number',
  'journal_id',
  'void_journal_id',
] as const;

export async function selectDocumentById(
  db: TenantDatabase,
  side: SubledgerSide,
  id: Buffer,
): Promise<DocumentRow | undefined> {
  return side === 'receivable'
    ? db.selectFrom('ar_documents').select(DOCUMENT_COLUMNS).where('id', '=', id).executeTakeFirst()
    : db
        .selectFrom('ap_documents')
        .select(DOCUMENT_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the serialization point for C3.
 *
 * Over-allocation cannot be a constraint: it compares a `SUM` across sibling rows
 * against a `SUM` across another table's rows, and MySQL has no CHECK that can
 * read either (`0005_subledger` says so at the table). So the rule is "read what
 * is outstanding, decide, insert", and a check-then-act is only a rule if nothing
 * can change the answer in between.
 *
 * Locking the *document* row is what serializes two allocators, and it is possible
 * at all because these tables are mutable (`0999_app_grants`): the app user may
 * take a locking read on a document, which it famously may not on a journal
 * (D-14). It also orders an allocation against a concurrent void or approval of
 * the same document, which is the other reason it is taken first and is the half
 * the AR and AP services own.
 *
 * **It is not on its own what makes C3 hold** — see the note below on why every
 * sum here is a locking read. That was measured: with this lock in place and a
 * plain sum, two allocators still settled the same invoice twice.
 */
export async function selectDocumentByIdForUpdate(
  db: TenantDatabase,
  side: SubledgerSide,
  id: Buffer,
): Promise<DocumentRow | undefined> {
  return side === 'receivable'
    ? db
        .selectFrom('ar_documents')
        .select(DOCUMENT_COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
    : db
        .selectFrom('ap_documents')
        .select(DOCUMENT_COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
}

/**
 * ## Every sum below is a locking read, and that is not decoration
 *
 * This was found by the parked-transaction test in
 * `test/payments/over-allocation-race.test.ts` and it is worth writing down,
 * because the code it replaces looked obviously correct.
 *
 * Taking the document row `FOR UPDATE` is necessary and **not sufficient**. It
 * serializes two allocators, so the loser resumes after the winner commits — and
 * then recomputes what is outstanding from a plain `SELECT SUM(...)`, which under
 * InnoDB's REPEATABLE READ is served from the *consistent snapshot the loser's
 * transaction established at its first non-locking read*, before the winner
 * committed. The loser therefore sees no allocation, finds the whole invoice
 * outstanding, and allocates it a second time. Measured: with `FOR UPDATE` on the
 * document and a plain sum, the loser blocked for the full contention wait and
 * then **succeeded**, leaving a 100.00 invoice carrying 200.00 of settlement.
 *
 * A locking read is always a *current* read, so `FOR SHARE` here is what makes the
 * recomputation see the winner's row. The lock strength is shared rather than
 * exclusive because these rows are only being read: the exclusive lock that
 * serializes writers is the one on the document.
 *
 * The cost, measured and accepted: a locking read of an equality range on a
 * non-unique index takes a next-key lock, so while the allocation tables are
 * nearly empty the gap covers most of the index and allocations to *different*
 * documents serialize too. It shrinks as rows accumulate, it never affects
 * correctness, and the alternative is the over-allocation above. There is no
 * gap-free current read of a range in REPEATABLE READ.
 */

/**
 * A document's gross total: the sum of its lines' net and tax.
 *
 * Summed rather than read from a header column, because there is no header column
 * — `0005_subledger` stores the two *rounded line amounts* D-35 permits and no
 * total, on the grounds that "a total is an aggregate; a rounded line amount is a
 * decision". This is the only place in this module that decides what a document is
 * for, and both the target check and the credit-note-as-source check go through
 * it, so an invoice and a credit note cannot come to be totalled differently.
 */
export async function documentTotal(
  db: TenantDatabase,
  side: SubledgerSide,
  documentId: Buffer,
): Promise<bigint> {
  const rows =
    side === 'receivable'
      ? await db
          .selectFrom('ar_document_lines')
          .select(['line_amount_minor', 'tax_amount_minor'])
          .where('document_id', '=', documentId)
          .forShare()
          .execute()
      : await db
          .selectFrom('ap_document_lines')
          .select(['line_amount_minor', 'tax_amount_minor'])
          .where('document_id', '=', documentId)
          .forShare()
          .execute();

  return rows.reduce((total, row) => total + row.line_amount_minor + row.tax_amount_minor, 0n);
}

/**
 * How much has been applied *to* a document — what reduces what it owes.
 *
 * The sum is over every allocation naming it as the target, whatever the source
 * was. That is D-39's payoff in one line: a credit note reduces an invoice
 * through the same rows a payment does, so "what is outstanding" has one
 * definition and the aging report has one thing to sum.
 */
export async function allocatedToDocument(
  db: TenantDatabase,
  side: SubledgerSide,
  documentId: Buffer,
): Promise<bigint> {
  const rows =
    side === 'receivable'
      ? await db
          .selectFrom('ar_allocations')
          .select('amount_minor')
          .where('invoice_id', '=', documentId)
          .forShare()
          .execute()
      : await db
          .selectFrom('ap_allocations')
          .select('amount_minor')
          .where('bill_id', '=', documentId)
          .forShare()
          .execute();

  return sumAmounts(rows);
}

/**
 * How much has been applied *from* a credit note or a vendor credit — what it has
 * left to give.
 *
 * The mirror of `allocatedToDocument` over the other foreign key, and the reason a
 * credit note needs no special treatment anywhere else: its availability is the
 * same subtraction a payment's is (`toSettlement`), over a different column.
 */
export async function allocatedFromDocument(
  db: TenantDatabase,
  side: SubledgerSide,
  documentId: Buffer,
): Promise<bigint> {
  const rows =
    side === 'receivable'
      ? await db
          .selectFrom('ar_allocations')
          .select('amount_minor')
          .where('credit_note_id', '=', documentId)
          .forShare()
          .execute()
      : await db
          .selectFrom('ap_allocations')
          .select('amount_minor')
          .where('vendor_credit_id', '=', documentId)
          .forShare()
          .execute();

  return sumAmounts(rows);
}

/**
 * How much has been applied *from* one payment, as a current read.
 *
 * `selectAllocatedByPayment` answers the same question for a page of payments and
 * answers it with a `GROUP BY` and no lock, which is right for a read. This one is
 * for the decision path, where the answer is about to be compared against the
 * payment's amount — see the note above on why a plain sum is not safe there even
 * under the payment's own row lock.
 *
 * Both tables, because a payment appears in exactly one of them by service rule
 * and a row that reached the wrong one should show up in the arithmetic rather
 * than be silently ignored.
 */
export async function allocatedFromPayment(db: TenantDatabase, paymentId: Buffer): Promise<bigint> {
  const receivable = await db
    .selectFrom('ar_allocations')
    .select('amount_minor')
    .where('payment_id', '=', paymentId)
    .forShare()
    .execute();

  const payable = await db
    .selectFrom('ap_allocations')
    .select('amount_minor')
    .where('payment_id', '=', paymentId)
    .forShare()
    .execute();

  return sumAmounts(receivable) + sumAmounts(payable);
}

function sumAmounts(rows: readonly { readonly amount_minor: bigint }[]): bigint {
  return rows.reduce((total, row) => total + row.amount_minor, 0n);
}

export interface NewAllocationRow {
  readonly targetId: Buffer;
  readonly paymentId: Buffer | null;
  readonly creditDocumentId: Buffer | null;
  /** The discount's own posted journal — the third source, D-106. */
  readonly discountJournalId: Buffer | null;
  readonly amountMinor: bigint;
  readonly allocatedOn: string;
  readonly createdByUserId: Buffer;
}

export async function insertAllocation(
  db: TenantDatabase,
  side: SubledgerSide,
  input: NewAllocationRow,
): Promise<Buffer> {
  const id = newUuidBuffer();

  if (side === 'receivable') {
    await db
      .insertInto('ar_allocations')
      .values({
        id,
        invoice_id: input.targetId,
        payment_id: input.paymentId,
        credit_note_id: input.creditDocumentId,
        discount_journal_id: input.discountJournalId,
        amount_minor: input.amountMinor,
        allocated_on: input.allocatedOn,
        created_by_user_id: input.createdByUserId,
      })
      .execute();
  } else {
    await db
      .insertInto('ap_allocations')
      .values({
        id,
        bill_id: input.targetId,
        payment_id: input.paymentId,
        vendor_credit_id: input.creditDocumentId,
        discount_journal_id: input.discountJournalId,
        amount_minor: input.amountMinor,
        allocated_on: input.allocatedOn,
        created_by_user_id: input.createdByUserId,
      })
      .execute();
  }

  return id;
}

/**
 * Removes one allocation. An ordinary delete, and it is allowed to be one.
 *
 * `0005_subledger` argues it at the table: the allocation posted no journal, so
 * removing it restates no financial statement. What it changes is what is
 * outstanding, and that is computed (D-34), so there is nothing else to correct.
 * The alternative — a signed reversing row, as the ledger uses — would make every
 * outstanding calculation sum signed amounts and every over-allocation check
 * reason about which rows cancel.
 */
export async function deleteAllocationById(
  db: TenantDatabase,
  side: SubledgerSide,
  id: Buffer,
): Promise<void> {
  if (side === 'receivable') {
    await db.deleteFrom('ar_allocations').where('id', '=', id).execute();
    return;
  }
  await db.deleteFrom('ap_allocations').where('id', '=', id).execute();
}

/**
 * Removes every allocation made from one payment, both sides.
 *
 * Called when a payment is voided. Both tables are cleared rather than the one the
 * direction implies, so a row that somehow reached the wrong table is removed
 * rather than left pointing at money the ledger has reversed.
 */
export async function deleteAllocationsForPayment(
  db: TenantDatabase,
  paymentId: Buffer,
): Promise<void> {
  await db.deleteFrom('ar_allocations').where('payment_id', '=', paymentId).execute();
  await db.deleteFrom('ap_allocations').where('payment_id', '=', paymentId).execute();
}

/**
 * Removes the allocation a discount journal made, both sides — `deleteAllocationsForPayment`'s
 * mirror for the third source (D-106).
 *
 * Called when a `discount` bank-clearing entry is undone (`clearing.service.ts`):
 * the journal is reversed there, never deleted (D-16), and this is what brings the
 * document's `outstanding` back up by the discount amount — without it, a reversed
 * discount journal would leave the allocation that used it still counting toward
 * `allocatedToDocument`, understating what is actually owed.
 */
export async function deleteAllocationsForDiscountJournal(
  db: TenantDatabase,
  discountJournalId: Buffer,
): Promise<void> {
  await db
    .deleteFrom('ar_allocations')
    .where('discount_journal_id', '=', discountJournalId)
    .execute();
  await db
    .deleteFrom('ap_allocations')
    .where('discount_journal_id', '=', discountJournalId)
    .execute();
}

/** Which rows a read of the allocation views wants. */
export type AllocationFilter =
  | { readonly kind: 'ids'; readonly ids: readonly Buffer[] }
  | { readonly kind: 'payment'; readonly id: Buffer }
  | { readonly kind: 'creditDocument'; readonly id: Buffer };

interface AllocationViewRow {
  readonly id: Buffer;
  readonly amount_minor: bigint;
  readonly allocated_on: string;
  readonly created_at: Date;
  readonly payment_id: Buffer | null;
  readonly credit_document_id: Buffer | null;
  readonly credit_document_number: bigint | null;
  /** The discount's own journal — the third source, D-106. */
  readonly discount_journal_id: Buffer | null;
  readonly target_id: Buffer;
  readonly target_number: bigint | null;
}

/**
 * Allocations with both ends named, which is the shape `allocationSchema` asks
 * for: the same object is embedded on a payment (where the client knows the
 * source) and on an invoice (where it knows the target), so a shape that dropped
 * the known end would be two shapes.
 *
 * The document table is joined twice — once as the target, once as the credit
 * note or vendor credit that may be the source — and both joins carry
 * `org_id` alongside the id, which is the composite-key tenancy pattern the schema
 * is built on. The `org_id` predicate `tenantDb` injects lands on the allocation
 * table only, so a join without it would be the one statement in the module that
 * could reach across orgs.
 */
export async function selectAllocations(
  db: TenantDatabase,
  side: SubledgerSide,
  filter: AllocationFilter,
): Promise<readonly Allocation[]> {
  const rows =
    side === 'receivable'
      ? await selectReceivableAllocations(db, filter)
      : await selectPayableAllocations(db, filter);

  return rows.map((row) => toAllocation(row, side));
}

async function selectReceivableAllocations(
  db: TenantDatabase,
  filter: AllocationFilter,
): Promise<readonly AllocationViewRow[]> {
  let query = db
    .selectFrom('ar_allocations')
    .innerJoin('ar_documents as target', (join) =>
      join
        .onRef('target.id', '=', 'ar_allocations.invoice_id')
        .onRef('target.org_id', '=', 'ar_allocations.org_id'),
    )
    .leftJoin('ar_documents as source', (join) =>
      join
        .onRef('source.id', '=', 'ar_allocations.credit_note_id')
        .onRef('source.org_id', '=', 'ar_allocations.org_id'),
    )
    .select([
      'ar_allocations.id',
      'ar_allocations.amount_minor',
      'ar_allocations.allocated_on',
      'ar_allocations.created_at',
      'ar_allocations.payment_id',
      'ar_allocations.credit_note_id as credit_document_id',
      'source.sequence_number as credit_document_number',
      'ar_allocations.discount_journal_id',
      'ar_allocations.invoice_id as target_id',
      'target.sequence_number as target_number',
    ]);

  if (filter.kind === 'ids') {
    if (filter.ids.length === 0) return [];
    query = query.where('ar_allocations.id', 'in', filter.ids);
  } else if (filter.kind === 'payment') {
    query = query.where('ar_allocations.payment_id', '=', filter.id);
  } else {
    query = query.where('ar_allocations.credit_note_id', '=', filter.id);
  }

  return query
    .orderBy('ar_allocations.allocated_on')
    .orderBy('ar_allocations.created_at')
    .orderBy('ar_allocations.id')
    .execute();
}

async function selectPayableAllocations(
  db: TenantDatabase,
  filter: AllocationFilter,
): Promise<readonly AllocationViewRow[]> {
  let query = db
    .selectFrom('ap_allocations')
    .innerJoin('ap_documents as target', (join) =>
      join
        .onRef('target.id', '=', 'ap_allocations.bill_id')
        .onRef('target.org_id', '=', 'ap_allocations.org_id'),
    )
    .leftJoin('ap_documents as source', (join) =>
      join
        .onRef('source.id', '=', 'ap_allocations.vendor_credit_id')
        .onRef('source.org_id', '=', 'ap_allocations.org_id'),
    )
    .select([
      'ap_allocations.id',
      'ap_allocations.amount_minor',
      'ap_allocations.allocated_on',
      'ap_allocations.created_at',
      'ap_allocations.payment_id',
      'ap_allocations.vendor_credit_id as credit_document_id',
      'source.sequence_number as credit_document_number',
      'ap_allocations.discount_journal_id',
      'ap_allocations.bill_id as target_id',
      'target.sequence_number as target_number',
    ]);

  if (filter.kind === 'ids') {
    if (filter.ids.length === 0) return [];
    query = query.where('ap_allocations.id', 'in', filter.ids);
  } else if (filter.kind === 'payment') {
    query = query.where('ap_allocations.payment_id', '=', filter.id);
  } else {
    query = query.where('ap_allocations.vendor_credit_id', '=', filter.id);
  }

  return query
    .orderBy('ap_allocations.allocated_on')
    .orderBy('ap_allocations.created_at')
    .orderBy('ap_allocations.id')
    .execute();
}

/**
 * Where one allocation lives, for the operations that are handed only its id.
 *
 * Both tables are consulted because an allocation id is a UUID and says nothing
 * about which side it belongs to. Two reads rather than a union query: the union
 * would have to reconcile two column names for the same idea, and this is the
 * uncommon path.
 */
export async function findAllocation(
  db: TenantDatabase,
  id: Buffer,
): Promise<
  | {
      readonly side: SubledgerSide;
      readonly paymentId: Buffer | null;
      readonly creditDocumentId: Buffer | null;
      readonly discountJournalId: Buffer | null;
      readonly targetId: Buffer;
    }
  | undefined
> {
  const receivable = await db
    .selectFrom('ar_allocations')
    .select(['payment_id', 'credit_note_id', 'discount_journal_id', 'invoice_id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (receivable !== undefined) {
    return {
      side: 'receivable',
      paymentId: receivable.payment_id,
      creditDocumentId: receivable.credit_note_id,
      discountJournalId: receivable.discount_journal_id,
      targetId: receivable.invoice_id,
    };
  }

  const payable = await db
    .selectFrom('ap_allocations')
    .select(['payment_id', 'vendor_credit_id', 'discount_journal_id', 'bill_id'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (payable === undefined) return undefined;

  return {
    side: 'payable',
    paymentId: payable.payment_id,
    creditDocumentId: payable.vendor_credit_id,
    discountJournalId: payable.discount_journal_id,
    targetId: payable.bill_id,
  };
}

function toAllocation(row: AllocationViewRow, side: SubledgerSide): Allocation {
  const fromPayment = row.payment_id !== null;
  const fromDiscount = row.discount_journal_id !== null;

  return {
    id: bufferToUuid(row.id),
    sourceType: fromPayment
      ? 'payment'
      : fromDiscount
        ? 'discount'
        : side === 'receivable'
          ? 'credit_note'
          : 'vendor_credit',
    // `chk_ar_allocations_one_source` makes exactly one of the three non-null, so
    // the fallback is unreachable rather than defensive — and it is written as the
    // target's own id rather than as an empty string so a row that somehow broke
    // the constraint is visibly wrong instead of quietly malformed.
    sourceId: bufferToUuid(
      row.payment_id ?? row.discount_journal_id ?? row.credit_document_id ?? row.target_id,
    ),
    // Null for a payment or a discount, which is the contract: "a payment is money
    // moving, not a numbered document" (D-36 numbers the four document types and
    // nothing else) — a discount's journal is likewise not one of those four.
    // The number the schema does give a payment is internal, so it is not published
    // here.
    sourceNumber: fromPayment || fromDiscount ? null : numberOf(row.credit_document_number),
    targetType: side === 'receivable' ? 'invoice' : 'bill',
    targetId: bufferToUuid(row.target_id),
    targetNumber: numberOf(row.target_number),
    amount: row.amount_minor.toString(),
    date: row.allocated_on,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * A document number as a label rather than as a count (`documentNumberSchema`), or
 * null while the document has none — which an allocation's ends never are, since
 * only an approved document may be allocated.
 */
function numberOf(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
