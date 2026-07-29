import type { PaymentRail, PendingPaymentStatus } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { newUuidBuffer, orgScope as toOrgId, tenantDb, tryUuidToBuffer } from '../../db';

/**
 * Data access for the pending-payment queue (OB-111/112; ROADMAP D-63…D-68).
 *
 * `pending_payments` and `pending_payment_intents` are both in `0999_app_grants`'s
 * mutable allowlist (`0013_pay_bills`'s header: "everything here is pencil"), which
 * is what makes the locking reads below possible — the journal tables cannot do
 * this (D-14). Nothing here writes a journal or touches `payments`; the queue posts
 * no ledger fact (D-64), and issue materialises one through `recordPayment`, never
 * through this file.
 *
 * ## `committedForBill` is a locking read, and that is not decoration
 *
 * `allocations.repository.ts`'s header records the measured lesson this follows:
 * the bill is locked `FOR UPDATE` by the caller before this runs, but under
 * REPEATABLE READ a plain `SELECT` is served from the transaction's first
 * consistent snapshot, not a current one. A loser that blocked on the bill lock and
 * then summed with a plain read would still see the winner's just-committed intents
 * as absent, and D-68's "two concurrent builds cannot each spend the same
 * remainder" would not hold. `forShare` is what makes the read current.
 */

/** The resource token every miss in this module reports (A7). */
export const PENDING_PAYMENT_RESOURCE = 'pending_payment';

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied pending-payment id as bytes, or `undefined` when it is not a
 * UUID — routed through `assertFound` so a malformed id reaches the same 404 an
 * unknown one does (A7).
 */
export function pendingPaymentIdBytes(pendingPaymentId: string): Buffer | undefined {
  return tryUuidToBuffer(pendingPaymentId);
}

export function newPendingPaymentId(): Buffer {
  return newUuidBuffer();
}

// ---------------------------------------------------------------------------
// pending_payments
// ---------------------------------------------------------------------------

const PENDING_PAYMENT_COLUMNS = [
  'id',
  'contact_id',
  'bank_account_id',
  'rail',
  'status',
  'issued_payment_id',
  'memo',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

export interface PendingPaymentRow {
  readonly id: Buffer;
  readonly contact_id: Buffer;
  readonly bank_account_id: Buffer;
  readonly rail: PaymentRail;
  readonly status: PendingPaymentStatus;
  readonly issued_payment_id: Buffer | null;
  readonly memo: string | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** `PendingPaymentRow` plus the vendor's display name, denormalized for the queue screen. */
export interface PendingPaymentWithVendorRow extends PendingPaymentRow {
  readonly vendor_name: string;
}

export interface NewPendingPaymentRow {
  readonly id: Buffer;
  readonly contactId: Buffer;
  readonly bankAccountId: Buffer;
  readonly rail: PaymentRail;
  readonly memo: string | null;
  readonly createdByUserId: Buffer;
}

export interface PendingPaymentPatch {
  readonly bankAccountId?: Buffer;
  readonly rail?: PaymentRail;
  readonly memo?: string | null;
  readonly status?: PendingPaymentStatus;
  readonly issuedPaymentId?: Buffer;
}

export async function insertPendingPayment(
  db: TenantDatabase,
  input: NewPendingPaymentRow,
): Promise<void> {
  await db
    .insertInto('pending_payments')
    .values({
      id: input.id,
      contact_id: input.contactId,
      bank_account_id: input.bankAccountId,
      rail: input.rail,
      memo: input.memo,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectPendingPaymentById(
  db: TenantDatabase,
  id: Buffer,
): Promise<PendingPaymentRow | undefined> {
  return db
    .selectFrom('pending_payments')
    .select(PENDING_PAYMENT_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the serialization point for every
 * write to a pending payment. Two callers editing, cancelling, or issuing one
 * pending payment both reach this statement; the second blocks until the first
 * commits and then reads its own committed `status`, which is what turns "two
 * issues of one pending payment" into one materialised `Payment` and a refusal.
 */
export async function selectPendingPaymentByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<PendingPaymentRow | undefined> {
  return db
    .selectFrom('pending_payments')
    .select(PENDING_PAYMENT_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function selectPendingPaymentWithVendor(
  db: TenantDatabase,
  id: Buffer,
): Promise<PendingPaymentWithVendorRow | undefined> {
  return db
    .selectFrom('pending_payments')
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'pending_payments.contact_id')
        .onRef('contacts.org_id', '=', 'pending_payments.org_id'),
    )
    .select([
      'pending_payments.id',
      'pending_payments.contact_id',
      'pending_payments.bank_account_id',
      'pending_payments.rail',
      'pending_payments.status',
      'pending_payments.issued_payment_id',
      'pending_payments.memo',
      'pending_payments.created_by_user_id',
      'pending_payments.created_at',
      'pending_payments.updated_at',
      'contacts.display_name as vendor_name',
    ])
    .where('pending_payments.id', '=', id)
    .executeTakeFirst();
}

export interface PendingPaymentFilter {
  readonly status?: PendingPaymentStatus;
}

/**
 * The queue as a list, oldest first — bounded per org rather than paged, matching
 * `pendingPaymentListSchema`'s own reasoning.
 */
export async function selectPendingPayments(
  db: TenantDatabase,
  filter?: PendingPaymentFilter,
): Promise<readonly PendingPaymentWithVendorRow[]> {
  let query = db
    .selectFrom('pending_payments')
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'pending_payments.contact_id')
        .onRef('contacts.org_id', '=', 'pending_payments.org_id'),
    )
    .select([
      'pending_payments.id',
      'pending_payments.contact_id',
      'pending_payments.bank_account_id',
      'pending_payments.rail',
      'pending_payments.status',
      'pending_payments.issued_payment_id',
      'pending_payments.memo',
      'pending_payments.created_by_user_id',
      'pending_payments.created_at',
      'pending_payments.updated_at',
      'contacts.display_name as vendor_name',
    ]);

  if (filter?.status !== undefined) {
    query = query.where('pending_payments.status', '=', filter.status);
  }

  return query.orderBy('pending_payments.created_at').orderBy('pending_payments.id').execute();
}

export async function updatePendingPaymentRow(
  db: TenantDatabase,
  id: Buffer,
  patch: PendingPaymentPatch,
): Promise<void> {
  await db
    .updateTable('pending_payments')
    .set({
      ...(patch.bankAccountId === undefined ? {} : { bank_account_id: patch.bankAccountId }),
      ...(patch.rail === undefined ? {} : { rail: patch.rail }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.issuedPaymentId === undefined ? {} : { issued_payment_id: patch.issuedPaymentId }),
    })
    .where('id', '=', id)
    .execute();
}

// ---------------------------------------------------------------------------
// pending_payment_intents
// ---------------------------------------------------------------------------

const PENDING_PAYMENT_INTENT_COLUMNS = [
  'id',
  'pending_payment_id',
  'bill_id',
  'pay_amount_minor',
  'discount_amount_minor',
  'discount_account_id',
  'applied_vendor_credit_id',
] as const;

export interface PendingPaymentIntentRow {
  readonly id: Buffer;
  readonly pending_payment_id: Buffer;
  readonly bill_id: Buffer;
  readonly pay_amount_minor: bigint;
  readonly discount_amount_minor: bigint | null;
  readonly discount_account_id: Buffer | null;
  readonly applied_vendor_credit_id: Buffer | null;
}

export interface NewPendingPaymentIntentRow {
  readonly billId: Buffer;
  readonly payAmountMinor: bigint;
  readonly discountAmountMinor: bigint | null;
  readonly discountAccountId: Buffer | null;
  readonly appliedVendorCreditId: Buffer | null;
}

export async function insertPendingPaymentIntents(
  db: TenantDatabase,
  pendingPaymentId: Buffer,
  intents: readonly NewPendingPaymentIntentRow[],
): Promise<void> {
  if (intents.length === 0) return;

  await db
    .insertInto('pending_payment_intents')
    .values(
      intents.map((intent) => ({
        id: newUuidBuffer(),
        pending_payment_id: pendingPaymentId,
        bill_id: intent.billId,
        pay_amount_minor: intent.payAmountMinor,
        discount_amount_minor: intent.discountAmountMinor,
        discount_account_id: intent.discountAccountId,
        applied_vendor_credit_id: intent.appliedVendorCreditId,
      })),
    )
    .execute();
}

export async function selectPendingPaymentIntents(
  db: TenantDatabase,
  pendingPaymentId: Buffer,
): Promise<readonly PendingPaymentIntentRow[]> {
  return db
    .selectFrom('pending_payment_intents')
    .select(PENDING_PAYMENT_INTENT_COLUMNS)
    .where('pending_payment_id', '=', pendingPaymentId)
    .execute();
}

/** Every pending payment's intents in one page, keyed by hex pending-payment id. */
export async function selectIntentsForPendingPayments(
  db: TenantDatabase,
  pendingPaymentIds: readonly Buffer[],
): Promise<ReadonlyMap<string, readonly PendingPaymentIntentRow[]>> {
  const byPendingPayment = new Map<string, PendingPaymentIntentRow[]>();
  if (pendingPaymentIds.length === 0) return byPendingPayment;

  const rows = await db
    .selectFrom('pending_payment_intents')
    .select(PENDING_PAYMENT_INTENT_COLUMNS)
    .where('pending_payment_id', 'in', pendingPaymentIds)
    .execute();

  for (const row of rows) {
    const key = row.pending_payment_id.toString('hex');
    const existing = byPendingPayment.get(key);
    if (existing === undefined) byPendingPayment.set(key, [row]);
    else existing.push(row);
  }

  return byPendingPayment;
}

/**
 * Replaces a pending payment's intents wholesale — the queue is pencil, and
 * `updatePendingPaymentRequestSchema` rebuilds the line set rather than patching
 * individual lines. Deleting first (inside the caller's transaction) is what makes
 * `committedForBill` below stop counting this payment's own old intents before the
 * new set is validated against it.
 */
export async function deletePendingPaymentIntents(
  db: TenantDatabase,
  pendingPaymentId: Buffer,
): Promise<void> {
  await db
    .deleteFrom('pending_payment_intents')
    .where('pending_payment_id', '=', pendingPaymentId)
    .execute();
}

// ---------------------------------------------------------------------------
// committed / available_to_pay (D-68)
// ---------------------------------------------------------------------------

/**
 * Σ `pay_amount_minor` over this bill's `open` pending intents — D-68's
 * `committed`, read under a lock.
 *
 * Called only after the caller has taken the bill row `FOR UPDATE`
 * (`allocations.repository.ts`'s `selectDocumentByIdForUpdate`, `side: 'payable'`).
 * That lock serializes writers; `forShare` here is what makes this *read* current
 * rather than served from the transaction's earlier snapshot — see the file header.
 */
export async function committedForBill(db: TenantDatabase, billId: Buffer): Promise<bigint> {
  const rows = await db
    .selectFrom('pending_payment_intents')
    .innerJoin('pending_payments', (join) =>
      join
        .onRef('pending_payments.id', '=', 'pending_payment_intents.pending_payment_id')
        .onRef('pending_payments.org_id', '=', 'pending_payment_intents.org_id'),
    )
    .select('pending_payment_intents.pay_amount_minor')
    .where('pending_payment_intents.bill_id', '=', billId)
    .where('pending_payments.status', '=', 'open')
    .forShare()
    .execute();

  return rows.reduce((total, row) => total + row.pay_amount_minor, 0n);
}

/**
 * The same sum, batched over several bills and with no lock — for `listPayableBills`,
 * which is a read of the Pay Bills window and takes no bill lock (there is nothing to
 * serialize against: it commits no intent and builds no pending payment).
 */
export async function committedTotals(
  db: TenantDatabase,
  billIds: readonly Buffer[],
): Promise<ReadonlyMap<string, bigint>> {
  const totals = new Map<string, bigint>();
  if (billIds.length === 0) return totals;

  const rows = await db
    .selectFrom('pending_payment_intents')
    .innerJoin('pending_payments', (join) =>
      join
        .onRef('pending_payments.id', '=', 'pending_payment_intents.pending_payment_id')
        .onRef('pending_payments.org_id', '=', 'pending_payment_intents.org_id'),
    )
    .select(['pending_payment_intents.bill_id', 'pending_payment_intents.pay_amount_minor'])
    .where('pending_payment_intents.bill_id', 'in', billIds)
    .where('pending_payments.status', '=', 'open')
    .execute();

  for (const row of rows) {
    const key = row.bill_id.toString('hex');
    totals.set(key, (totals.get(key) ?? 0n) + row.pay_amount_minor);
  }

  return totals;
}

// ---------------------------------------------------------------------------
// References the service resolves before writing
// ---------------------------------------------------------------------------

export async function selectBankAccountById(
  db: TenantDatabase,
  id: Buffer,
): Promise<{ readonly id: Buffer } | undefined> {
  return db.selectFrom('bank_accounts').select('id').where('id', '=', id).executeTakeFirst();
}

/** One bill candidate for the Pay Bills window, before the computed columns. */
export interface PayableBillCandidateRow {
  readonly id: Buffer;
  readonly contact_id: Buffer;
  readonly vendor_name: string;
  readonly reference: string | null;
  readonly issue_date: string;
  readonly due_date: string | null;
}

/**
 * Every approved, non-void bill in the org — `listPayableBills`'s starting set.
 * `outstanding`, `committed` and `availableToPay` are computed by the caller
 * (D-34, D-68): none of the three is stored, so none of the three can be a
 * `WHERE` clause here, matching `toSummaryPage`'s reasoning for `part_paid`/`paid`.
 */
export async function selectPayableBillCandidates(
  db: TenantDatabase,
): Promise<readonly PayableBillCandidateRow[]> {
  return db
    .selectFrom('ap_documents')
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'ap_documents.contact_id')
        .onRef('contacts.org_id', '=', 'ap_documents.org_id'),
    )
    .select([
      'ap_documents.id',
      'ap_documents.contact_id',
      'contacts.display_name as vendor_name',
      'ap_documents.reference',
      'ap_documents.issue_date',
      'ap_documents.due_date',
    ])
    .where('ap_documents.document_type', '=', 'bill')
    .where('ap_documents.journal_id', 'is not', null)
    .where('ap_documents.void_journal_id', 'is', null)
    .orderBy('ap_documents.created_at')
    .orderBy('ap_documents.id')
    .execute();
}
