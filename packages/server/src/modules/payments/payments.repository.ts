import type {
  Allocation,
  Payment,
  PaymentDirection,
  PaymentSummary,
} from '@openbooks/shared-types';
import { sql, type SqlBool } from 'kysely';

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
import { InternalError } from '../../errors';

import type { SubledgerSide } from '../settings';

/**
 * Data access for payments (OB-064).
 *
 * Everything here goes through `tenantDb`, so `payments.org_id = ctx.orgId` is on
 * every statement before this file adds a predicate — which is what makes a
 * cross-org id a miss rather than a leak (A7), with `assertFound` in the service
 * turning the miss into the one error it is allowed to produce.
 *
 * ## Nothing in this file reads or writes a balance
 *
 * There is no `allocated_minor` on `payments` and there will not be one (D-34).
 * What a payment has left is `amount_minor` minus the allocations that point at
 * it, and `selectAllocatedByPayment` below is the only implementation of that
 * subtraction — one for the single read, the page, and the `unallocatedOnly`
 * filter, so a payment cannot show one figure in a list and another on its own
 * page.
 */

/** The resource token every miss in this module reports (A7). */
export const PAYMENT_RESOURCE = 'payment';

/** As stored: `payments.direction` is `received` | `paid`. */
export type PaymentDirectionRow = 'received' | 'paid';

/**
 * The wire says `made`, the column says `paid`, and neither is going to change.
 *
 * `paymentDirectionSchema` chose `made` because "payments made" reads as English
 * beside "payments received", and it is the word the permission catalog already
 * uses (`payments_made.write`, seeded in `0001_tenancy`). `0005_subledger` chose
 * `paid`. Both are settled contracts owned by other tickets, so the mapping lives
 * here, in two functions, rather than in each query that touches the column.
 */
export function toDirectionRow(direction: PaymentDirection): PaymentDirectionRow {
  return direction === 'received' ? 'received' : 'paid';
}

export function toWireDirection(direction: PaymentDirectionRow): PaymentDirection {
  return direction === 'received' ? 'received' : 'made';
}

/** Which subledger a payment settles. `received` clears invoices, `paid` clears bills. */
export function sideOf(direction: PaymentDirectionRow): SubledgerSide {
  return direction === 'received' ? 'receivable' : 'payable';
}

/** The counter row a payment's number comes from (`document_sequences`, D-36). */
export function sequenceKeyOf(direction: PaymentDirectionRow): 'payment_received' | 'payment_paid' {
  return direction === 'received' ? 'payment_received' : 'payment_paid';
}

const PAYMENT_COLUMNS = [
  'id',
  'direction',
  'sequence_number',
  'contact_id',
  'payment_date',
  'amount_minor',
  'bank_account_id',
  'reference',
  'memo',
  'journal_id',
  'void_journal_id',
  'created_at',
  'updated_at',
] as const;

export interface PaymentRow {
  readonly id: Buffer;
  readonly direction: PaymentDirectionRow;
  readonly sequence_number: bigint;
  readonly contact_id: Buffer;
  readonly payment_date: string;
  readonly amount_minor: bigint;
  readonly bank_account_id: Buffer;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journal_id: Buffer;
  readonly void_journal_id: Buffer | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewPaymentRow {
  readonly id: Buffer;
  readonly direction: PaymentDirectionRow;
  readonly sequenceNumber: bigint;
  readonly contactId: Buffer;
  readonly paymentDate: string;
  readonly amountMinor: bigint;
  readonly bankAccountId: Buffer;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly journalId: Buffer;
  readonly createdByUserId: Buffer;
}

export interface PaymentPatch {
  readonly reference?: string | null;
  readonly memo?: string | null;
  readonly voidJournalId?: Buffer;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied payment id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function paymentIdBytes(paymentId: string): Buffer | undefined {
  return tryUuidToBuffer(paymentId);
}

export function newPaymentId(): Buffer {
  return newUuidBuffer();
}

/**
 * The next number in one of the six `document_sequences` series (D-36, D-14).
 *
 * The counter row is taken `FOR UPDATE` and incremented inside the caller's
 * transaction, which is what makes the series gapless: `AUTO_INCREMENT` consumes a
 * value on a rollback, and a gap in a numbered series is indistinguishable from a
 * deleted row — the ambiguity an append-only system exists to remove. The upsert
 * is what creates the row on an org's first payment; the `org_id` in the duplicate
 * branch is a no-op that makes the statement idempotent rather than an error.
 *
 * Payments are numbered even though the wire contract does not publish the number
 * (`payments.ts`: "a payment is not a numbered document"). The column is
 * `NOT NULL` in `0005_subledger`, which explains why: adding the number later
 * means inventing one for every payment already recorded.
 */
export async function allocateSequenceNumber(
  db: TenantDatabase,
  documentType: 'payment_received' | 'payment_paid',
): Promise<bigint> {
  await db
    .insertInto('document_sequences')
    .values({ document_type: documentType, next_value: 1n })
    .onDuplicateKeyUpdate({ org_id: db.orgId })
    .execute();

  const row = await db
    .selectFrom('document_sequences')
    .select('next_value')
    .where('document_type', '=', documentType)
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('document_sequences')
    .set({ next_value: row.next_value + 1n })
    .where('document_type', '=', documentType)
    .execute();

  return row.next_value;
}

export async function insertPayment(db: TenantDatabase, input: NewPaymentRow): Promise<void> {
  await db
    .insertInto('payments')
    .values({
      id: input.id,
      direction: input.direction,
      sequence_number: input.sequenceNumber,
      contact_id: input.contactId,
      payment_date: input.paymentDate,
      amount_minor: input.amountMinor,
      bank_account_id: input.bankAccountId,
      reference: input.reference,
      memo: input.memo,
      journal_id: input.journalId,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectPaymentById(
  db: TenantDatabase,
  id: Buffer,
): Promise<PaymentRow | undefined> {
  return db.selectFrom('payments').select(PAYMENT_COLUMNS).where('id', '=', id).executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * Used by the void path and by an allocation whose source is this payment: both
 * decide what they may do from a sum over rows that another transaction can be
 * inserting, so the decision has to be made under a lock or two callers each see
 * room for the same money. Possible at all because `payments` is in
 * `0999_app_grants`'s mutable allowlist — the journal tables are not, which is why
 * nothing in this codebase locks a journal row (D-14).
 */
export async function selectPaymentByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<PaymentRow | undefined> {
  return db
    .selectFrom('payments')
    .select(PAYMENT_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function updatePaymentRow(
  db: TenantDatabase,
  id: Buffer,
  patch: PaymentPatch,
): Promise<void> {
  await db
    .updateTable('payments')
    .set({
      ...(patch.reference === undefined ? {} : { reference: patch.reference }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      ...(patch.voidJournalId === undefined ? {} : { void_journal_id: patch.voidJournalId }),
    })
    .where('id', '=', id)
    .execute();

  // The affected-row count is deliberately not consulted, for the reason
  // `updateContactRow` states: mysql2 does not set `CLIENT_FOUND_ROWS`, so an
  // UPDATE that matches a row and changes nothing reports zero affected rows,
  // exactly like one that matched nothing. Existence is established by the
  // caller's locking read, which every caller of this performs anyway.
}

/**
 * `(created_at, id)` — the ordering `paymentPageSchema` declares, and D-21's
 * general rule.
 *
 * `payment_date` is what a user would sort on and it is the wrong keyset for the
 * reason the contract gives: payments are recorded in whatever order the paperwork
 * surfaces, so a back-dated one lands behind a cursor that has already passed its
 * date and appears on no page at all. `created_at` cannot move under a cursor.
 *
 * Unlike `contacts`, there is no `(org_id, created_at, id)` index behind this —
 * `0005_subledger` indexes payments by `(org_id, contact_id, payment_date)` and
 * `(org_id, payment_date, id)`. A page is therefore a filesort today. Recorded
 * rather than worked around: the fix is an index, which belongs to whoever owns
 * the schema, and choosing a different keyset to suit the indexes that exist would
 * trade a correct list for a fast one.
 */
const PAYMENT_KEYSET: KeysetOrdering<PaymentRow> = [
  instantKey('payments.created_at', (row) => row.created_at),
  uuidKey('payments.id', (row) => row.id),
];

export interface PaymentFilters {
  readonly direction?: PaymentDirectionRow | undefined;
  readonly contactId?: Buffer | undefined;
  readonly status?: 'recorded' | 'void' | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly unallocatedOnly?: boolean | undefined;
  readonly cursor?: string | undefined;
}

export async function selectPaymentsPage(
  db: TenantDatabase,
  filters: PaymentFilters,
  limit: number,
): Promise<KeysetPage<PaymentRow>> {
  let query = db.selectFrom('payments').select(PAYMENT_COLUMNS);

  if (filters.direction !== undefined) {
    query = query.where('direction', '=', filters.direction);
  }
  if (filters.contactId !== undefined) {
    query = query.where('contact_id', '=', filters.contactId);
  }
  if (filters.status !== undefined) {
    query =
      filters.status === 'void'
        ? query.where('void_journal_id', 'is not', null)
        : query.where('void_journal_id', 'is', null);
  }
  // The range filters `payment_date`, not `created_at`: the question a date range
  // answers is "what moved in March", which is about the money and not about when
  // somebody typed it in. That it disagrees with the keyset column is the point of
  // the keyset note above.
  if (filters.from !== undefined) {
    query = query.where('payment_date', '>=', filters.from);
  }
  if (filters.to !== undefined) {
    query = query.where('payment_date', '<=', filters.to);
  }
  if (filters.unallocatedOnly === true) {
    query = query.where(UNALLOCATED);
  }

  // The filters go on before the keyset predicate so the two compose against the
  // same result set: a page of "received only" has to end where the next page of
  // "received only" begins, not where the unfiltered list did.
  const rows = await applyKeyset(query, PAYMENT_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, PAYMENT_KEYSET, limit);
}

/**
 * "Has credit left on it" — D-37's credit balance, as a predicate.
 *
 * Two correlated subqueries rather than a join, because a payment settles one side
 * or the other and joining both allocation tables to one row would multiply it.
 * Void payments are excluded here rather than left to the caller: a reversed
 * payment has nothing available to apply (`toSettlement` says the same thing about
 * the same payment), and a screen listing credit to apply must not offer money the
 * ledger has already taken back.
 *
 * No values are interpolated — every identifier is fixed text — so there is
 * nothing here to parameterize.
 */
const UNALLOCATED = sql<SqlBool>`payments.void_journal_id IS NULL AND payments.amount_minor > (
  COALESCE((
    SELECT SUM(ar_allocations.amount_minor) FROM ar_allocations
    WHERE ar_allocations.org_id = payments.org_id AND ar_allocations.payment_id = payments.id
  ), 0)
  + COALESCE((
    SELECT SUM(ap_allocations.amount_minor) FROM ap_allocations
    WHERE ap_allocations.org_id = payments.org_id AND ap_allocations.payment_id = payments.id
  ), 0)
)`;

/**
 * How much has been applied *from* each of the given payments, in minor units.
 *
 * One grouped query per allocation table rather than one per payment: a page of
 * fifty payments would otherwise be a hundred round trips to answer a question
 * that is two `GROUP BY`s. A payment appears in at most one of the two tables —
 * a received payment settles invoices — but both are summed rather than switching
 * on direction, so a row that somehow reached the wrong table is visible in the
 * arithmetic instead of silently ignored.
 */
export async function selectAllocatedByPayment(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, bigint>> {
  const totals = new Map<string, bigint>();
  if (ids.length === 0) return totals;

  const add = (id: Buffer, amount: bigint): void => {
    const key = id.toString('hex');
    totals.set(key, (totals.get(key) ?? 0n) + amount);
  };

  const receivable = await db
    .selectFrom('ar_allocations')
    .select(['payment_id', sumOf('ar_allocations.amount_minor').as('total')])
    .where('payment_id', 'in', ids)
    .groupBy('payment_id')
    .execute();

  const payable = await db
    .selectFrom('ap_allocations')
    .select(['payment_id', sumOf('ap_allocations.amount_minor').as('total')])
    .where('payment_id', 'in', ids)
    .groupBy('payment_id')
    .execute();

  for (const row of [...receivable, ...payable]) {
    if (row.payment_id === null) continue;
    add(row.payment_id, toBigInt(row.total));
  }

  return totals;
}

/**
 * `SUM` over a `BIGINT` column, which MySQL widens to `DECIMAL` and mysql2 returns
 * as a string. Normalized through `BigInt` by `toBigInt` at every call site — a
 * `Number()` here would reintroduce exactly the precision loss D-13 exists to
 * avoid, on a total rather than on an amount.
 */
function sumOf(column: string) {
  return sql<string>`COALESCE(SUM(${sql.ref(column)}), 0)`;
}

export function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/**
 * What is left on a payment, computed on read and stored nowhere (D-34, D-37).
 *
 * `outstanding` on a payment reads as "unallocated credit still available", which
 * is the same subtraction an invoice's "still owed" is — one definition, four
 * readings (`documentSettlementSchema`).
 *
 * A voided payment reports zero on both, and that is not a special case bolted on:
 * its journal has been reversed, so no money moved, and `createAllocations`
 * refuses to apply it. Reporting the full amount as available credit would
 * contradict that refusal and invite a screen to offer money the ledger has
 * already taken back.
 */
export function toSettlement(
  row: PaymentRow,
  allocated: bigint,
): { readonly allocated: string; readonly outstanding: string } {
  if (row.void_journal_id !== null) {
    return { allocated: '0', outstanding: '0' };
  }
  return {
    allocated: allocated.toString(),
    outstanding: (row.amount_minor - allocated).toString(),
  };
}

export function toPaymentSummary(row: PaymentRow, allocated: bigint): PaymentSummary {
  return {
    id: bufferToUuid(row.id),
    direction: toWireDirection(row.direction),
    contactId: bufferToUuid(row.contact_id),
    date: row.payment_date,
    amount: row.amount_minor.toString(),
    accountId: bufferToUuid(row.bank_account_id),
    reference: row.reference,
    status: row.void_journal_id === null ? 'recorded' : 'void',
    settlement: toSettlement(row, allocated),
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so this is a lossless rendering of a real instant.
    createdAt: row.created_at.toISOString(),
  };
}

export function toPayment(
  row: PaymentRow,
  allocated: bigint,
  allocations: readonly Allocation[],
): Payment {
  return {
    ...toPaymentSummary(row, allocated),
    memo: row.memo,
    allocations: [...allocations],
    journalId: bufferToUuid(row.journal_id),
    voidJournalId: row.void_journal_id === null ? null : bufferToUuid(row.void_journal_id),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * A payment that was written and could not be read back inside the same
 * transaction — a fault, not a client situation, so it is an `InternalError`.
 *
 * The service reads every payment back from inside the writing transaction rather
 * than assembling the response in memory, which is `readBack` in
 * `posting.service.ts`'s argument and is worth more here than usual: a payment's
 * settlement is derived from rows in a second table that the same transaction has
 * just inserted, so an in-memory answer would be this code's belief about its own
 * writes rather than a report of them.
 */
export function missingAfterWrite(): InternalError {
  return new InternalError(
    'The payment written by this transaction could not be read back inside it.',
  );
}
