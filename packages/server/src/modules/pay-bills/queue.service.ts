import type {
  CreatePendingPaymentRequest,
  PayableBill,
  PayableBillList,
  PayBillsRequest,
  PendingPayment,
  PendingPaymentIntent,
  PendingPaymentIntentInput,
  PendingPaymentList,
  PendingPaymentStatus,
  UpdatePendingPaymentRequest,
} from '@openbooks/shared-types';
import {
  createPendingPaymentRequestSchema,
  payBillsRequestSchema,
  updatePendingPaymentRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, tryUuidToBuffer } from '../../db';
import {
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
  parseInput,
} from '../../errors';
import { requirePermission } from '../permissions';

import type { ApDocumentLineRow } from '../bills/ap-documents.repository';
import {
  selectAccounts,
  selectAllocatedTotals,
  selectLinesForDocuments,
} from '../bills/ap-documents.repository';
import {
  allocatedToDocument,
  documentTotal,
  selectDocumentById,
  selectDocumentByIdForUpdate,
} from '../payments/allocations.repository';
import { positiveMinorUnits, requireRecordingUser } from '../payments/input';

import type {
  NewPendingPaymentIntentRow,
  PendingPaymentIntentRow,
  PendingPaymentWithVendorRow,
} from './queue.repository';
import {
  PENDING_PAYMENT_RESOURCE,
  committedForBill,
  committedTotals,
  deletePendingPaymentIntents,
  insertPendingPayment,
  insertPendingPaymentIntents,
  newPendingPaymentId,
  orgScope,
  pendingPaymentIdBytes,
  selectBankAccountById,
  selectIntentsForPendingPayments,
  selectPayableBillCandidates,
  selectPendingPaymentByIdForUpdate,
  selectPendingPaymentIntents,
  selectPendingPaymentWithVendor,
  selectPendingPayments,
  updatePendingPaymentRow,
} from './queue.repository';

/**
 * The pending-payment queue (OB-111; ROADMAP D-63, D-64, D-68).
 *
 * ## Posts no journal, ever
 *
 * A pending payment is pencil (D-64): it reserves a bill's `committed` and nothing
 * else. Nothing in this file calls `postJournal`, imports it, or writes a
 * `Payment` — that only happens at issue (`issue.service.ts`, OB-112), through
 * `recordPayment`. Every write here is gated on `pending_payments.write`/`.read`
 * and never on `journals.post` or `disbursements.issue` (D-109's separation of
 * duties: a clerk builds the queue, a controller releases it).
 *
 * ## The over-commit guard (D-68)
 *
 * `committedForBill` sums Σ `pay_amount_minor` over a bill's `open` pending
 * intents, and it is read under the *same* `FOR UPDATE` lock on the bill that
 * `applyAllocations` takes for the identical reason (`allocate.ts`'s file header):
 * two concurrent builds against one bill must not each see the same remainder
 * available. The lock and the guard both live in `resolveIntents` below, and every
 * write path that touches a bill's intents — build, and the wholesale intent
 * replacement on edit — funnels through it.
 */

const RESOURCE = PENDING_PAYMENT_RESOURCE;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function buildPendingPayment(
  input: CreatePendingPaymentRequest,
  ctx: RequestContext = getContext('buildPendingPayment()'),
): Promise<PendingPayment> {
  await requirePermission(ctx, 'pending_payments.write');
  const request = parseInput(createPendingPaymentRequestSchema, input);
  const author = requireRecordingUser(ctx);

  const contactId = assertFound(tryUuidToBuffer(request.contactId), 'contact');
  const bankAccountId = assertFound(tryUuidToBuffer(request.bankAccountId), 'bank_account');

  return orgScope(ctx).transaction(async (trx) => {
    assertFound(await selectBankAccountById(trx, bankAccountId), 'bank_account');

    const intents = await resolveIntents(trx, contactId, request.intents);

    const id = newPendingPaymentId();
    await insertPendingPayment(trx, {
      id,
      contactId,
      bankAccountId,
      rail: request.rail,
      memo: request.memo ?? null,
      createdByUserId: author,
    });
    await insertPendingPaymentIntents(trx, id, intents);

    return readPendingPayment(trx, id);
  });
}

/**
 * A batch Pay Bills run: one pending payment per vendor, built independently
 * (D-63). Each call to `buildPendingPayment` opens its own transaction, so a
 * refusal on one vendor's bills leaves every pending payment already built by
 * this call committed rather than rolled back with it.
 */
export async function payBills(
  input: PayBillsRequest,
  ctx: RequestContext = getContext('payBills()'),
): Promise<PendingPaymentList> {
  const request = parseInput(payBillsRequestSchema, input);

  const pendingPayments: PendingPayment[] = [];
  for (const payment of request.payments) {
    pendingPayments.push(await buildPendingPayment(payment, ctx));
  }

  return { pendingPayments };
}

/**
 * Edits an `open` pending payment. `intents`, when supplied, replaces the set
 * wholesale (`updatePendingPaymentRequestSchema`) — the old rows are deleted
 * before the new set is validated, so a line moved from one bill to another on the
 * same edit sees the room it just freed rather than a false `bill_over_committed`
 * against itself.
 */
export async function updatePendingPayment(
  pendingPaymentId: string,
  input: UpdatePendingPaymentRequest,
  ctx: RequestContext = getContext('updatePendingPayment()'),
): Promise<PendingPayment> {
  await requirePermission(ctx, 'pending_payments.write');
  const request = parseInput(updatePendingPaymentRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(pendingPaymentIdBytes(pendingPaymentId), RESOURCE);
    const row = assertFound(await selectPendingPaymentByIdForUpdate(trx, id), RESOURCE);
    assertOpen(row);

    const bankAccountId =
      request.bankAccountId === undefined
        ? undefined
        : assertFound(tryUuidToBuffer(request.bankAccountId), 'bank_account');
    if (bankAccountId !== undefined) {
      assertFound(await selectBankAccountById(trx, bankAccountId), 'bank_account');
    }

    if (request.intents !== undefined) {
      await deletePendingPaymentIntents(trx, id);
      const intents = await resolveIntents(trx, row.contact_id, request.intents);
      await insertPendingPaymentIntents(trx, id, intents);
    }

    await updatePendingPaymentRow(trx, id, {
      ...(bankAccountId === undefined ? {} : { bankAccountId }),
      ...(request.rail === undefined ? {} : { rail: request.rail }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
    });

    return readPendingPayment(trx, id);
  });
}

/**
 * Cancels an `open` pending payment. Flipping `status` rather than deleting the
 * row is what frees the bills it named while keeping the record — `committedForBill`
 * counts only `open` intents, so a cancelled payment's stop counting the moment
 * this commits. No ledger correction is needed because none was ever posted (D-64):
 * a pending payment is pencil, and erasing pencil restates nothing.
 */
export async function cancelPendingPayment(
  pendingPaymentId: string,
  ctx: RequestContext = getContext('cancelPendingPayment()'),
): Promise<PendingPayment> {
  await requirePermission(ctx, 'pending_payments.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(pendingPaymentIdBytes(pendingPaymentId), RESOURCE);
    const row = assertFound(await selectPendingPaymentByIdForUpdate(trx, id), RESOURCE);
    assertOpen(row);

    await updatePendingPaymentRow(trx, id, { status: 'cancelled' });

    return readPendingPayment(trx, id);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPendingPayment(
  pendingPaymentId: string,
  ctx: RequestContext = getContext('getPendingPayment()'),
): Promise<PendingPayment> {
  await requirePermission(ctx, 'pending_payments.read');
  const id = assertFound(pendingPaymentIdBytes(pendingPaymentId), RESOURCE);

  return readPendingPayment(orgScope(ctx), id);
}

export interface PendingPaymentFilter {
  readonly status?: PendingPaymentStatus;
}

export async function listPendingPayments(
  ctx: RequestContext = getContext('listPendingPayments()'),
  filter?: PendingPaymentFilter,
): Promise<PendingPaymentList> {
  await requirePermission(ctx, 'pending_payments.read');
  const db = orgScope(ctx);

  const rows = await selectPendingPayments(db, filter);
  const intentsByPendingPayment = await selectIntentsForPendingPayments(
    db,
    rows.map((row) => row.id),
  );

  return {
    pendingPayments: rows.map((row) =>
      toPendingPayment(row, intentsByPendingPayment.get(row.id.toString('hex')) ?? []),
    ),
  };
}

/**
 * The Pay Bills window: every approved, non-void, not-fully-paid bill with its
 * payability computed on read (D-34, D-68). `gross`/`outstanding` come from the
 * bill's own lines and allocations, exactly as `ap-documents.service.ts`'s
 * `settlementOf` derives them for a bill on its own; `committed` and
 * `availableToPay` add the queue's reservation on top. None of the four is stored.
 *
 * A read, so it takes no bill lock: nothing here commits an intent, and a client
 * refreshing the window is not a party to the race `resolveIntents` guards against.
 */
export async function listPayableBills(
  ctx: RequestContext = getContext('listPayableBills()'),
): Promise<PayableBillList> {
  await requirePermission(ctx, 'pending_payments.read');
  const db = orgScope(ctx);

  const candidates = await selectPayableBillCandidates(db);
  const ids = candidates.map((row) => row.id);

  const [linesByDocument, allocatedByDocument, committedByBill] = await Promise.all([
    selectLinesForDocuments(db, ids),
    selectAllocatedTotals(db, ids, 'bill'),
    committedTotals(db, ids),
  ]);

  const bills: PayableBill[] = [];

  for (const row of candidates) {
    const hex = row.id.toString('hex');
    const gross = grossOf(linesByDocument.get(hex) ?? []);
    const outstanding = gross - (allocatedByDocument.get(hex) ?? 0n);

    // "Not-fully-paid": a bill the allocations already cover in full has nothing
    // left to queue, whatever an open pending payment still commits against it.
    if (outstanding <= 0n) continue;

    const committed = committedByBill.get(hex) ?? 0n;

    bills.push({
      billId: bufferToUuid(row.id),
      contactId: bufferToUuid(row.contact_id),
      vendorName: row.vendor_name,
      reference: row.reference,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      gross: gross.toString(),
      outstanding: outstanding.toString(),
      committed: committed.toString(),
      availableToPay: (outstanding - committed).toString(),
    });
  }

  return { bills };
}

// ---------------------------------------------------------------------------
// Intent resolution — the D-68 guard, shared by build and edit
// ---------------------------------------------------------------------------

interface IntentRequest {
  readonly index: number;
  readonly intent: PendingPaymentIntentInput;
  readonly billId: Buffer;
  readonly payAmount: bigint;
}

/**
 * Validates and locks every intent's bill, then converts the batch to rows ready
 * to insert. Called by both `buildPendingPayment` and `updatePendingPayment`'s
 * wholesale intent replacement, so the guard is the same code regardless of which
 * one is asking.
 */
async function resolveIntents(
  trx: TenantDatabase,
  contactId: Buffer,
  intents: readonly PendingPaymentIntentInput[],
): Promise<readonly NewPendingPaymentIntentRow[]> {
  const requests: IntentRequest[] = intents.map((intent, index) => ({
    index,
    intent,
    billId: assertFound(tryUuidToBuffer(intent.billId), 'bill'),
    payAmount: positiveMinorUnits(intent.payAmount, `intents.${String(index)}.payAmount`),
  }));

  assertNoDuplicateBill(requests);

  // Discount accounts, resolved once for the whole batch rather than once per
  // intent — `resolveLines`'s reason (`ap-documents.service.ts`) for batching a
  // reference lookup: the accounts are checked by reading them so an unknown or
  // cross-org id is the 404 A7 requires, rather than a foreign-key 500.
  const discountAccountIds = collectIds(intents, (intent) => intent.discountAccountId);
  const accounts = await selectAccounts(trx, discountAccountIds);
  if (discountAccountIds.some((accountId) => !accounts.has(accountId.toString('hex')))) {
    throw new NotFoundError('account');
  }

  // Ascending id order before any lock is taken — `lockTargets`'s deadlock
  // argument in `allocate.ts`: a total order over the locks a transaction takes
  // cannot produce a cycle, so two concurrent builds touching the same two bills
  // in opposite orders do not deadlock each other.
  const ordered = [...requests].sort((left, right) => Buffer.compare(left.billId, right.billId));
  for (const request of ordered) {
    await assertAvailable(trx, contactId, request.billId, request.payAmount);
  }

  const rows: NewPendingPaymentIntentRow[] = [];
  for (const request of requests) {
    rows.push({
      billId: request.billId,
      payAmountMinor: request.payAmount,
      discountAmountMinor:
        request.intent.discountAmount === undefined
          ? null
          : positiveMinorUnits(
              request.intent.discountAmount,
              `intents.${String(request.index)}.discountAmount`,
            ),
      discountAccountId:
        request.intent.discountAccountId === undefined
          ? null
          : assertFound(tryUuidToBuffer(request.intent.discountAccountId), 'account'),
      appliedVendorCreditId:
        request.intent.appliedVendorCreditId === undefined
          ? null
          : await resolveVendorCreditId(trx, request.intent.appliedVendorCreditId),
    });
  }

  return rows;
}

function assertNoDuplicateBill(requests: readonly IntentRequest[]): void {
  const seen = new Set<string>();
  for (const request of requests) {
    const key = request.billId.toString('hex');
    if (seen.has(key)) {
      throw new ValidationError('A pending payment settles each bill once.', [
        {
          path: `intents.${String(request.index)}.billId`,
          message:
            'This bill already appears in an earlier intent on this pending payment. Combine ' +
            'the two lines into one rather than queuing the same bill twice.',
        },
      ]);
    }
    seen.add(key);
  }
}

/**
 * Locks the bill, checks it is this pending payment's vendor, and refuses if
 * `payAmount` would exceed what D-68 calls `availableToPay`.
 *
 * `outstanding` is derived exactly as `ap-documents.service.ts`'s `settlementOf`
 * derives it for a bill on its own — a draft or void bill reports zero regardless
 * of its lines, so an intent against one is refused here as "nothing left to
 * commit" rather than needing a second precondition to say the same thing.
 */
async function assertAvailable(
  trx: TenantDatabase,
  contactId: Buffer,
  billId: Buffer,
  payAmount: bigint,
): Promise<void> {
  const document = assertFound(await selectDocumentByIdForUpdate(trx, 'payable', billId), 'bill');
  // A vendor-credit id shares this table and this id space; asking for a bill by
  // one is a miss rather than a document of the wrong kind, matching the AP
  // module's own reasoning for keeping the two disjoint to a caller.
  if (document.document_type !== 'bill') throw new NotFoundError('bill');

  if (!document.contact_id.equals(contactId)) {
    throw new PreconditionFailedError(
      'bill_contact_mismatch',
      'This bill belongs to a different vendor than this pending payment. A pending payment ' +
        'settles one vendor’s bills — a Payment carries one contact and its allocations refuse ' +
        'to cross contacts (D-63), so queuing this bill here would commit money against it that ' +
        'issue could never actually apply.',
    );
  }

  const gross = await documentTotal(trx, 'payable', billId);
  const allocated = await allocatedToDocument(trx, 'payable', billId);
  const settled = document.journal_id === null || document.void_journal_id !== null;
  const outstanding = settled ? 0n : gross - allocated;

  const committed = await committedForBill(trx, billId);
  const available = outstanding - committed;

  if (payAmount > available) {
    throw new PreconditionFailedError(
      'bill_over_committed',
      `This bill has ${available.toString()} minor units available to pay and this pending ` +
        `payment queues ${payAmount.toString()}. Another open pending payment already commits ` +
        'the rest — cancel it or reduce this amount (D-68).',
    );
  }
}

async function resolveVendorCreditId(trx: TenantDatabase, vendorCreditId: string): Promise<Buffer> {
  const id = assertFound(tryUuidToBuffer(vendorCreditId), 'vendor_credit');
  const document = assertFound(await selectDocumentById(trx, 'payable', id), 'vendor_credit');
  if (document.document_type !== 'vendor_credit') throw new NotFoundError('vendor_credit');
  return id;
}

function assertOpen(row: { readonly status: PendingPaymentStatus }): void {
  if (row.status === 'open') return;

  throw new PreconditionFailedError(
    'pending_payment_not_open',
    `This pending payment is ${row.status}, so it can no longer be edited or cancelled. Only an ` +
      'open pending payment is pencil; one that has been issued is a real Payment and the ' +
      'correction is a void, and one already cancelled has nothing left to change.',
  );
}

function collectIds(
  intents: readonly PendingPaymentIntentInput[],
  of: (intent: PendingPaymentIntentInput) => string | undefined,
): readonly Buffer[] {
  const ids = new Map<string, Buffer>();
  for (const intent of intents) {
    const value = of(intent);
    if (value === undefined) continue;
    const bytes = tryUuidToBuffer(value);
    if (bytes !== undefined) ids.set(bytes.toString('hex'), bytes);
  }
  return [...ids.values()];
}

function grossOf(lines: readonly ApDocumentLineRow[]): bigint {
  return lines.reduce((total, line) => total + line.line_amount_minor + line.tax_amount_minor, 0n);
}

// ---------------------------------------------------------------------------
// View assembly
// ---------------------------------------------------------------------------

async function readPendingPayment(db: TenantDatabase, id: Buffer): Promise<PendingPayment> {
  const row = assertFound(await selectPendingPaymentWithVendor(db, id), RESOURCE);
  const intents = await selectPendingPaymentIntents(db, id);
  return toPendingPayment(row, intents);
}

function toPendingPayment(
  row: PendingPaymentWithVendorRow,
  intents: readonly PendingPaymentIntentRow[],
): PendingPayment {
  const totalAmount = intents.reduce((total, intent) => total + intent.pay_amount_minor, 0n);

  return {
    id: bufferToUuid(row.id),
    contactId: bufferToUuid(row.contact_id),
    vendorName: row.vendor_name,
    bankAccountId: bufferToUuid(row.bank_account_id),
    rail: row.rail,
    status: row.status,
    issuedPaymentId: row.issued_payment_id === null ? null : bufferToUuid(row.issued_payment_id),
    memo: row.memo,
    intents: intents.map(toPendingPaymentIntent),
    totalAmount: totalAmount.toString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toPendingPaymentIntent(row: PendingPaymentIntentRow): PendingPaymentIntent {
  return {
    id: bufferToUuid(row.id),
    billId: bufferToUuid(row.bill_id),
    payAmount: row.pay_amount_minor.toString(),
    discountAmount:
      row.discount_amount_minor === null ? null : row.discount_amount_minor.toString(),
    discountAccountId:
      row.discount_account_id === null ? null : bufferToUuid(row.discount_account_id),
    appliedVendorCreditId:
      row.applied_vendor_credit_id === null ? null : bufferToUuid(row.applied_vendor_credit_id),
  };
}
