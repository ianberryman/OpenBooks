import type { JournalLineInput } from '@openbooks/plugin-api';
import { fromMinorString, isZero, toMinorUnits } from '@openbooks/shared-types/money';

import type { RequestContext } from '../../context';
import { bufferToUuid } from '../../db';
import { assertFound, NotFoundError } from '../../errors';
import { createExternalRef, lookupExternalRef } from '../external-refs';
import { getInvoice } from '../invoices';
import { postJournal } from '../ledger';
import { recordPayment } from '../payments';

import {
  PROCESSOR_CONNECTION_RESOURCE as RESOURCE,
  advanceReconciledThrough,
  connectionIdBytes,
  orgScope,
  selectConnectionByIdForUpdate,
} from './connections.repository';

/**
 * The clearing-account posting model (OB-147; ROADMAP D-82, D-104) — called by the
 * webhook receiver and the polling backstop (OB-148), always inside `runAsAutomation`
 * so every write here carries `actor_type:'automation'` provenance (spec §6, J3).
 *
 * ## D-82: a processor is a clearing account, not a bank
 *
 * A charge clears AR into the connection's clearing account *immediately* — that is
 * `recordProcessorCharge` below, assembled entirely from seams that already exist
 * (`recordPayment`, `createExternalRef`, `postJournal`) rather than any new writing
 * machinery. A payout later moves the accumulated balance to the real bank, net of
 * fees and refunds, and *that* journal — debit bank, credit clearing — is posted by
 * the existing M4 pipeline when the payout statement line is cleared
 * (`clearBankStatementLine({method:'link_entry'})`), not by this file
 * (`recordProcessorPayout`'s own comment explains why).
 *
 * ## Two-level idempotency (D-85, F9)
 *
 * A webhook redelivers and a poll can report an object the webhook already
 * delivered, so a charge is guarded twice: `processor_events`' own unique key is
 * OB-148's event-level guard (a redelivery never reaches this file at all), and the
 * `external_refs` correlation on the charge's **object** id is this file's guard —
 * the same object arriving as two different deliveries collapses to the payment
 * already on file rather than a second one. Because journals are append-only and
 * cannot themselves be `SELECT … FOR UPDATE`'d (D-14), the check-then-`recordPayment`
 * step below runs under a lock on the `processor_connections` row instead
 * (ROADMAP's "PAY execution" note) — `selectConnectionByIdForUpdate` is exactly
 * `bank-accounts.repository.ts`'s locking-read shape, applied to the row two
 * concurrent deliveries of one charge both have to pass through.
 */

export interface RecordProcessorChargeInput {
  readonly connectionId: string;
  readonly invoiceId: string;
  readonly externalObjectId: string;
  readonly grossMinor: string;
  readonly feeMinor: string | null;
  readonly occurredAt: string;
}

export interface RecordProcessorChargeResult {
  readonly paymentId: string;
  readonly alreadyRecorded: boolean;
}

/**
 * Records one processor charge: clears AR into the clearing account, and posts
 * the per-charge fee (D-104) when the event carries one.
 *
 * All of it — the idempotency check, the payment, the correlation, the fee — is
 * one transaction, locked on the connection row from the first statement, so a
 * second delivery of the same charge either sees the first's committed
 * `external_refs` row and stops, or blocks until it does.
 */
export async function recordProcessorCharge(
  input: RecordProcessorChargeInput,
  ctx: RequestContext,
): Promise<RecordProcessorChargeResult> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const connectionBytes = assertFound(connectionIdBytes(input.connectionId), RESOURCE);
    // The serialization point (see the file header): every concurrent delivery
    // reporting a charge on this connection blocks here until the winner's
    // `external_refs` insert below has committed and is visible to the loser's
    // re-read of this same locked row's transaction.
    const connection = assertFound(
      await selectConnectionByIdForUpdate(trx, connectionBytes),
      RESOURCE,
    );

    const existingPaymentId = await findRecordedPayment(
      connection.processor,
      input.externalObjectId,
      ctx,
    );
    if (existingPaymentId !== undefined) {
      return { paymentId: existingPaymentId, alreadyRecorded: true };
    }

    const invoice = await getInvoice(input.invoiceId, ctx);
    const date = toCalendarDate(input.occurredAt);
    const clearingAccountId = bufferToUuid(connection.clearing_account_id);

    // Posts the AR↔clearing leg (`source:'payment'`) and auto-allocates on the
    // checkout-metadata invoice id — certain identity, not a guess (D-83).
    const payment = await recordPayment(
      {
        direction: 'received',
        contactId: invoice.contactId,
        date,
        amount: input.grossMinor,
        accountId: clearingAccountId,
        reference: input.externalObjectId,
        allocations: [
          { targetType: 'invoice', targetId: input.invoiceId, amount: input.grossMinor },
        ],
      },
      ctx,
    );

    // The correlation this idempotency check reads on the next delivery of the
    // same object (F9). Written after the payment, in the same transaction, so
    // a rollback of one cannot leave the other committed.
    await createExternalRef(
      {
        externalSystem: connection.processor,
        entityType: 'payment',
        externalId: input.externalObjectId,
        entityId: payment.id,
      },
      ctx,
    );

    if (input.feeMinor !== null && !isZero(fromMinorString(input.feeMinor))) {
      const feeAmount = toMinorUnits(fromMinorString(input.feeMinor));
      await postJournal(
        {
          date,
          source: 'clearing',
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
          memo: `processor fee ${input.externalObjectId}`,
          lines: feeJournalLines(
            bufferToUuid(connection.fee_account_id),
            clearingAccountId,
            feeAmount,
          ),
        },
        ctx,
      );
    }

    return { paymentId: payment.id, alreadyRecorded: false };
  });
}

export interface RecordProcessorPayoutInput {
  readonly connectionId: string;
  readonly externalObjectId: string;
  readonly netMinor: string;
  readonly occurredAt: string;
}

export interface RecordProcessorPayoutResult {
  readonly alreadyRecorded: boolean;
}

/**
 * Advances the connection's D-85 backstop cursor to a payout's `occurredAt` —
 * nothing else.
 *
 * Per D-82, the journal that actually reconciles a payout — debit bank, credit
 * clearing — is posted when the real bank deposit is cleared through the
 * **existing** M4 pipeline (`clearBankStatementLine({method:'link_entry'})`,
 * linking the statement line to that journal), not here: a payout is an
 * ordinary bank statement line, and inventing a second posting path for the
 * same movement would be exactly the "no new match machinery" D-103 refuses.
 * `netMinor` is accepted (the pinned webhook/poll contract carries it) but
 * unused by this function for that reason — there is nothing for it to post.
 *
 * `alreadyRecorded` compares against the cursor already on file rather than
 * against `external_refs`: a payout has no invoice to auto-allocate and no
 * second write to guard against here, only a cursor that must not move
 * backwards on a reordered or redelivered event.
 */
export async function recordProcessorPayout(
  input: RecordProcessorPayoutInput,
  ctx: RequestContext,
): Promise<RecordProcessorPayoutResult> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const connectionBytes = assertFound(connectionIdBytes(input.connectionId), RESOURCE);
    const connection = assertFound(
      await selectConnectionByIdForUpdate(trx, connectionBytes),
      RESOURCE,
    );

    const occurredAt = new Date(input.occurredAt);
    const alreadyRecorded =
      connection.reconciled_through !== null && connection.reconciled_through >= occurredAt;

    if (!alreadyRecorded) {
      await advanceReconciledThrough(trx, connectionBytes, occurredAt);
    }

    return { alreadyRecorded };
  });
}

// ---------------------------------------------------------------------------
// Small resolutions
// ---------------------------------------------------------------------------

/**
 * The OpenBooks payment this processor object already produced, or `undefined`
 * when it is genuinely new.
 *
 * `lookupExternalRef` throws `NotFoundError` on a miss (A7 — a cross-org and a
 * nonexistent ref are the same 404), which is the right contract for every
 * other caller in this codebase, where a miss is terminal. Here a miss is the
 * expected, common case — "this charge has not been recorded yet" — so this is
 * the one place that catches it deliberately rather than letting it propagate;
 * any other error still does.
 */
async function findRecordedPayment(
  processor: string,
  externalObjectId: string,
  ctx: RequestContext,
): Promise<string | undefined> {
  try {
    const ref = await lookupExternalRef(
      { externalSystem: processor, entityType: 'payment', externalId: externalObjectId },
      ctx,
    );
    return ref.entityId;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/** The `YYYY-MM-DD` a processor's ISO-8601 `occurredAt` posts as (D-13's `CalendarDate`). */
function toCalendarDate(occurredAt: string): string {
  return new Date(occurredAt).toISOString().slice(0, 10);
}

/** Debit the fee-expense account, credit the clearing account (D-104, J4). */
function feeJournalLines(
  feeAccountId: string,
  clearingAccountId: string,
  feeAmount: bigint,
): readonly JournalLineInput[] {
  return [
    { accountId: feeAccountId, side: 'debit', amount: feeAmount },
    { accountId: clearingAccountId, side: 'credit', amount: feeAmount },
  ];
}
