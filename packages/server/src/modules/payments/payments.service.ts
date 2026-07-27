import type {
  CreatePaymentRequest,
  ListPaymentsQuery,
  Payment,
  PaymentDirection,
  PaymentPage,
  UpdatePaymentRequest,
  VoidDocumentRequest,
} from '@openbooks/shared-types';
import {
  createPaymentRequestSchema,
  listPaymentsQuerySchema,
  paymentDirectionSchema,
  updatePaymentRequestSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, resolvePageLimit, tryUuidToBuffer, uuidToBuffer } from '../../db';
import { PreconditionFailedError, assertFound, parseInput } from '../../errors';
import { postJournal, reverseJournal } from '../ledger';
import { resolveControlAccount } from '../settings';
import { requirePermission } from '../permissions';

import { applyAllocations } from './allocate';
import { deleteAllocationsForPayment, selectAllocations } from './allocations.repository';
import { positiveMinorUnits, requireRecordingUser } from './input';
import {
  PAYMENT_RESOURCE as RESOURCE,
  allocateSequenceNumber,
  insertPayment,
  missingAfterWrite,
  newPaymentId,
  orgScope,
  paymentIdBytes,
  selectAllocatedByPayment,
  selectPaymentById,
  selectPaymentByIdForUpdate,
  selectPaymentsPage,
  sequenceKeyOf,
  sideOf,
  toDirectionRow,
  toPayment,
  toPaymentSummary,
  toWireDirection,
  updatePaymentRow,
  type PaymentDirectionRow,
  type PaymentFilters,
} from './payments.repository';

/**
 * Payments: money that moved (OB-064; ROADMAP D-37).
 *
 * Read `index.ts` for what this module is, and `allocate.ts` for the mechanism
 * that decides what a payment settles. Four things are uniform across the
 * operations below and are stated once here:
 *
 * 1. **The permission depends on the direction**, so `payments_received.*` and
 *    `payments_made.*` are checked rather than one payments code. That is what the
 *    seeded `ar_only` and `ap_only` roles are: an AR clerk records customer
 *    receipts and may not record vendor payments.
 *
 * 2. **A payment always posts a journal, and it posts it through `postJournal`.**
 *    `payments.journal_id` is `NOT NULL` in `0005_subledger` precisely so this is
 *    structural: a payment row that posted nothing would be financial state held
 *    outside the ledger, which is the one thing no module may do (spec §2.1). The
 *    balance check, the period lock (A4) and the actor provenance all live in the
 *    posting service, and nothing here re-implements any of them.
 *
 * 3. **Nothing here stores what a payment has left.** `settlement` is
 *    `amount_minor` minus the allocations pointing at it, computed on read (D-34).
 *    An unallocated remainder is a credit balance on the contact — the whole of
 *    C4 — and it is a subtraction rather than a column.
 *
 * 4. **A miss is `assertFound`.** `tenantDb` has already confined every read to
 *    the context's org, so a cross-org id returns no row and reaches the same line
 *    a nonexistent id reaches (A7).
 *
 * ## Why the direction is read before the permission on an existing payment
 *
 * `requirePermission` runs first everywhere else in this codebase, because a
 * caller without authority should learn nothing about the surface they cannot use.
 * Here the *authority itself* depends on the row: which of the two permissions
 * governs a payment is decided by its direction, and on `getPayment` the direction
 * is not in the request. So those operations read the row first, through
 * `tenantDb`, and check authority against what they found.
 *
 * What that gives away is bounded and is the boundary A7 draws: the read is
 * org-scoped, so a payment in another org is a 404 either way, and what a
 * permission failure can distinguish is a row inside the caller's *own*
 * organization — which is exactly what a 403 is for. Nothing of the row is
 * returned before the check.
 */

/**
 * Records a payment, optionally applying it in the same call.
 *
 * ## The order of operations
 *
 *   1. direction, parsed on its own — the one field authority depends on
 *   2. permission for that direction
 *   3. the rest of the payload
 *   4. one transaction: post the journal (period lock, sequence, balance), take a
 *      payment number, insert the row, apply any allocations, read it back
 *
 * Step 1 is a departure from "permission before parsing" and a small one: an
 * unauthorized caller learns that `direction` exists and takes one of two values,
 * which the permission catalog they were refused with already told them.
 *
 * ## Why the allocations are in this transaction and not a second call
 *
 * `createPaymentRequestSchema` argues it: two calls leave a window in which the
 * money is recorded and unapplied, and a client that failed between them would
 * have created the very orphan credit that makes people distrust the feature. The
 * allocations go through the same `applyAllocations` the allocate endpoints use,
 * so a payment applied at record time and one applied a week later are refused —
 * or accepted — by identical code.
 *
 * ## What the journal is
 *
 * Received: debit the bank account the money arrived in, credit the receivables
 * control account. Made: the mirror. Both lines carry the contact, because "what
 * is still outstanding with this customer" is a question about the ledger as well
 * as about the subledger, and a line without a contact answers it with a gap.
 *
 * The allocation that may follow posts nothing (D-37). This posting is what
 * cleared the control account; the allocation only says which invoice it was for.
 */
export async function recordPayment(
  input: CreatePaymentRequest,
  ctx: RequestContext = getContext('recordPayment()'),
): Promise<Payment> {
  const direction = parseInput(paymentDirectionSchema, directionOf(input));
  await requirePaymentWrite(ctx, direction);

  const request = parseInput(createPaymentRequestSchema, input);
  const amount = positiveMinorUnits(request.amount, 'amount');
  const author = requireRecordingUser(ctx);
  const row = toDirectionRow(direction);

  const contactId = assertFound(tryUuidToBuffer(request.contactId), 'contact');
  const bankAccountId = assertFound(tryUuidToBuffer(request.accountId), 'account');

  return orgScope(ctx).transaction(async (trx) => {
    const controlAccountId = await resolveControlAccount(trx, sideOf(row));

    // The accounts' existence and activity, the contact's, the balance, the period
    // lock and the journal sequence are all `postJournal`'s. It is called, never
    // re-implemented — a second write path into the ledger would skip all five.
    const posted = await postJournal(
      {
        date: request.date,
        ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        lines: journalLines(row, {
          bankAccountId: request.accountId,
          controlAccountId: bufferToUuid(controlAccountId),
          contactId: request.contactId,
          amount,
        }),
      },
      ctx,
    );

    const sequenceNumber = await allocateSequenceNumber(trx, sequenceKeyOf(row));
    const id = newPaymentId();

    await insertPayment(trx, {
      id,
      direction: row,
      sequenceNumber,
      contactId,
      paymentDate: request.date,
      amountMinor: amount,
      bankAccountId,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
      journalId: uuidToBuffer(posted.journalId),
      createdByUserId: author,
    });

    if (request.allocations !== undefined && request.allocations.length > 0) {
      await applyAllocations(
        trx,
        {
          side: sideOf(row),
          kind: 'payment',
          id,
          contactId,
          available: amount,
          label: 'payment',
        },
        request.allocations,
        // The allocations default to the payment's own date rather than to today,
        // so recording last week's receipt and applying it in the same call does
        // not date the settlement to the day someone got round to the paperwork
        // (`allocationDateSchema`, D-40).
        request.date,
        author,
      );
    }

    return readPayment(trx, id);
  });
}

export async function getPayment(
  paymentId: string,
  ctx: RequestContext = getContext('getPayment()'),
): Promise<Payment> {
  const db = orgScope(ctx);
  const id = assertFound(paymentIdBytes(paymentId), RESOURCE);
  const row = assertFound(await selectPaymentById(db, id), RESOURCE);

  await requirePaymentRead(ctx, toWireDirection(row.direction));

  return readPayment(db, id);
}

/**
 * One page of the org's payments, oldest first (D-21).
 *
 * ## Why an unfiltered list needs both permissions
 *
 * A list spanning both subledgers is a read of both, so it requires the authority
 * to read both; a caller holding one side filters by `direction` and gets their
 * side. The alternative — silently returning only the rows the caller may see —
 * is the shape `hasPermission`'s own commentary warns against: it turns a missing
 * permission into an empty result the client cannot distinguish from real
 * emptiness, and an AR clerk would see a payments list that quietly omits half the
 * business without ever being told.
 */
export async function listPayments(
  query: ListPaymentsQuery,
  ctx: RequestContext = getContext('listPayments()'),
): Promise<PaymentPage> {
  const filters = parseInput(listPaymentsQuerySchema, query);

  if (filters.direction === undefined) {
    await requirePermission(ctx, 'payments_received.read');
    await requirePermission(ctx, 'payments_made.read');
  } else {
    await requirePaymentRead(ctx, filters.direction);
  }

  const db = orgScope(ctx);
  const limit = resolvePageLimit(filters.limit);

  const contactId =
    filters.contactId === undefined ? undefined : tryUuidToBuffer(filters.contactId);
  if (filters.contactId !== undefined && contactId === undefined) {
    // A malformed contact filter matches nothing, which is what an unknown one
    // does. Answering with an empty page keeps a filter's failure mode uniform —
    // and A7 requires that a contact in another org be indistinguishable from one
    // that does not exist, which an empty page is.
    return { items: [], nextCursor: null };
  }

  const page = await selectPaymentsPage(
    db,
    {
      ...(filters.direction === undefined ? {} : { direction: toDirectionRow(filters.direction) }),
      ...(contactId === undefined ? {} : { contactId }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.from === undefined ? {} : { from: filters.from }),
      ...(filters.to === undefined ? {} : { to: filters.to }),
      ...(filters.unallocatedOnly === undefined
        ? {}
        : { unallocatedOnly: filters.unallocatedOnly }),
      ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
    } satisfies PaymentFilters,
    limit,
  );

  const allocated = await selectAllocatedByPayment(
    db,
    page.rows.map((row) => row.id),
  );

  return {
    items: page.rows.map((row) =>
      toPaymentSummary(row, allocated.get(row.id.toString('hex')) ?? 0n),
    ),
    nextCursor: page.nextCursor,
  };
}

/**
 * The text a human wrote about a payment, and nothing else.
 *
 * `amount`, `date`, `accountId` and `direction` are absent from
 * `updatePaymentRequestSchema` and absent here: each is a fact the posted journal
 * carries, and a journal is never edited (spec §2.2, D-16). A payment recorded for
 * the wrong amount is voided and recorded again — the same answer D-38 gives for a
 * document approved in error.
 */
export async function updatePayment(
  paymentId: string,
  input: UpdatePaymentRequest,
  ctx: RequestContext = getContext('updatePayment()'),
): Promise<Payment> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const id = assertFound(paymentIdBytes(paymentId), RESOURCE);
    const row = assertFound(await selectPaymentById(trx, id), RESOURCE);

    await requirePaymentWrite(ctx, toWireDirection(row.direction));
    const request = parseInput(updatePaymentRequestSchema, input);

    await updatePaymentRow(trx, id, {
      // `null` clears, absent leaves alone. `.nullish()` makes both expressible and
      // only `undefined` means absent — JSON cannot send `undefined`, so a client
      // clearing a field sends `null` and gets exactly that.
      ...(request.reference === undefined ? {} : { reference: request.reference }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
    });

    return readPayment(trx, id);
  });
}

/**
 * Voids a payment: reverses its journal, and unwinds what it had settled.
 *
 * ## Void is a reversal, never a deletion (D-16, D-38)
 *
 * The payment row stays, its journal stays, and a second journal reverses it. Both
 * remain visible, and `status` reads `void` because `void_journal_id` is set —
 * derived, like every other status in this subsystem.
 *
 * ## Why the allocations are deleted rather than left in place
 *
 * The money did not move, so nothing it settled is settled. That has to be true of
 * *what is outstanding*, and outstanding is a sum over allocation rows (D-34) — so
 * either the rows go, or every reader of that sum has to know to exclude the ones
 * whose payment was voided. The second is how a subledger drifts from its ledger:
 * the reversing journal has already put the amount back on the control account, so
 * an allocation that survived would leave the invoice looking settled while the
 * ledger says it is owed, which is C2 being false with nothing obviously broken.
 *
 * Deleting is available to us for the reason `0005_subledger` gives: an allocation
 * posted no journal, so removing one restates no financial statement. What is lost
 * is the record that this payment had once been applied to that invoice, and that
 * is the accepted cost — the payment itself remains, with its reversal beside it.
 *
 * The reversal takes its own date (`voidDocumentRequestSchema`) because the
 * payment's period is frequently closed by the time an error is found, and a
 * reversal in the current period leaves the closed period's statements intact.
 */
export async function voidPayment(
  paymentId: string,
  input: VoidDocumentRequest,
  ctx: RequestContext = getContext('voidPayment()'),
): Promise<Payment> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const id = assertFound(paymentIdBytes(paymentId), RESOURCE);
    const found = assertFound(await selectPaymentById(trx, id), RESOURCE);

    await requirePaymentWrite(ctx, toWireDirection(found.direction));
    const request = parseInput(voidDocumentRequestSchema, input);

    // Locked only now, after the caller has been shown to be entitled to touch it:
    // an exclusive lock taken for a request that is about to be refused would let
    // an unauthorized caller stall a legitimate one.
    const payment = assertFound(await selectPaymentByIdForUpdate(trx, id), RESOURCE);

    if (payment.void_journal_id !== null) {
      throw new PreconditionFailedError(
        'payment_already_void',
        'This payment has already been voided. Its journal is reversed and its allocations are ' +
          'gone; voiding it again would post a second reversal for money that moved once.',
      );
    }

    const reversal = await reverseJournal(
      {
        journalId: bufferToUuid(payment.journal_id),
        date: request.date,
        ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
      },
      ctx,
    );

    await deleteAllocationsForPayment(trx, id);
    await updatePaymentRow(trx, id, { voidJournalId: uuidToBuffer(reversal.journalId) });

    return readPayment(trx, id);
  });
}

// ---------------------------------------------------------------------------
// Shared with `allocations.service.ts`
// ---------------------------------------------------------------------------

/**
 * The permission a write to a payment of this direction needs.
 *
 * Two literal `requirePermission` calls rather than one on a computed key, so the
 * enforcement points stay greppable: `test/enforcement/permission-matrix.test.ts`
 * reads the codes any service enforces out of the source, and a key assembled at
 * runtime would be an enforcement point that no matrix could see.
 */
export async function requirePaymentWrite(
  ctx: RequestContext,
  direction: PaymentDirection,
): Promise<void> {
  if (direction === 'received') {
    await requirePermission(ctx, 'payments_received.write');
    return;
  }
  await requirePermission(ctx, 'payments_made.write');
}

export async function requirePaymentRead(
  ctx: RequestContext,
  direction: PaymentDirection,
): Promise<void> {
  if (direction === 'received') {
    await requirePermission(ctx, 'payments_received.read');
    return;
  }
  await requirePermission(ctx, 'payments_made.read');
}

/**
 * A payment with its settlement and its allocations, read back from the database.
 *
 * Every operation above returns through here, including the writes, so what a
 * caller receives is what the database holds rather than what this code believes
 * it wrote — `readBack` in `posting.service.ts`'s argument, and it carries extra
 * weight here because the settlement is derived from rows in another table that
 * the same transaction may have just inserted or deleted.
 */
export async function readPayment(db: TenantDatabase, id: Buffer): Promise<Payment> {
  const row = await selectPaymentById(db, id);
  if (row === undefined) throw missingAfterWrite();

  const allocated = (await selectAllocatedByPayment(db, [id])).get(id.toString('hex')) ?? 0n;
  const allocations = await selectAllocations(db, sideOf(row.direction), {
    kind: 'payment',
    id,
  });

  return toPayment(row, allocated, allocations);
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

/**
 * The direction out of an unvalidated payload.
 *
 * `unknown` in and out: `recordPayment` is typed against `CreatePaymentRequest`,
 * and spec §12 says an MCP tool and the workflow engine reach the same service
 * with no schema in front of them — so the value has to be treated as untrusted
 * even though the signature says otherwise. Reaching into a possibly-undefined
 * `input` with a property access would throw a `TypeError` where a
 * `validation_failed` belongs.
 */
function directionOf(input: unknown): unknown {
  return typeof input === 'object' && input !== null && 'direction' in input
    ? (input as { readonly direction: unknown }).direction
    : undefined;
}

interface JournalSides {
  readonly bankAccountId: string;
  readonly controlAccountId: string;
  readonly contactId: string;
  readonly amount: bigint;
}

function journalLines(direction: PaymentDirectionRow, sides: JournalSides) {
  const bank = {
    accountId: sides.bankAccountId,
    amount: sides.amount,
    contactId: sides.contactId,
  } as const;
  const control = {
    accountId: sides.controlAccountId,
    amount: sides.amount,
    contactId: sides.contactId,
  } as const;

  return direction === 'received'
    ? [
        { ...bank, side: 'debit' as const },
        { ...control, side: 'credit' as const },
      ]
    : [
        { ...control, side: 'debit' as const },
        { ...bank, side: 'credit' as const },
      ];
}
