import type { JournalLineInput } from '@openbooks/plugin-api';
import type { ExternalRefEntityType } from '@openbooks/shared-types';
import { fromMinorString, isZero, toMinorUnits } from '@openbooks/shared-types/money';

import type { RequestContext } from '../../context';
import { bufferToUuid } from '../../db';
import { assertFound, NotFoundError } from '../../errors';
import { createExternalRef, lookupExternalRef } from '../external-refs';
import { getInvoice } from '../invoices';
import { postJournal } from '../ledger';
import { recordPayment } from '../payments';
import { resolveControlAccount } from '../settings';

import {
  PROCESSOR_CONNECTION_RESOURCE as RESOURCE,
  advanceReconciledThrough,
  connectionIdBytes,
  orgScope,
  selectConnectionByIdForUpdate,
} from './connections.repository';

/**
 * The clearing-account posting model (OB-147/OB-149; ROADMAP D-82, D-84, D-104) —
 * called by the webhook receiver and the polling backstop (OB-148), always inside
 * `runAsAutomation` so every write here carries `actor_type:'automation'` provenance
 * (spec §6, J3).
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

    const existingPaymentId = await findRecordedRef(
      connection.processor,
      'payment',
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

export interface RecordProcessorRefundInput {
  readonly connectionId: string;
  /**
   * The invoice the refunded charge paid, when the event still carries it
   * (D-83's certain identity) — `null` when the processor's refund event does
   * not repeat the checkout metadata. Used only to tag the journal's lines with
   * the customer contact (`getInvoice(invoiceId).contactId`); a `null` posts the
   * same journal with no contact tag rather than failing, because the refund
   * amount and the accounts it moves between are not in doubt either way.
   */
  readonly invoiceId: string | null;
  readonly externalObjectId: string;
  readonly grossMinor: string;
  readonly occurredAt: string;
}

export interface RecordProcessorRefundResult {
  /**
   * The posted journal's id. There is no `payments` row behind a refund (see
   * this function's own header for why), so this names the journal instead of
   * a payment — `external_refs`' own comment is explicit that `entity_id` is a
   * correlation, not a foreign key, so pointing a `'payment'`-typed ref at a
   * journal id is exactly the shape D-58 sanctions.
   */
  readonly paymentId: string;
  readonly alreadyRecorded: boolean;
}

/**
 * Records a processor refund as the opposite of `recordProcessorCharge` (D-84,
 * J7): the same two accounts move, in the same amount, the other way.
 *
 * ## Why this is a raw `postJournal`, not `recordPayment({direction:'made'})`
 *
 * A refund undoes an AR clearance, so the naive read is "the opposite of
 * `recordPayment({direction:'received'})` is `recordPayment({direction:'made'})`."
 * That is wrong: `'made'` clears the **payable** control account
 * (`resolveControlAccount(trx, 'payable')`, `payments.service.ts`'s own
 * `journalLines`), because a `'made'` payment is what settles a bill — this is
 * still an *AR* event, so the control account never changes side, only which of
 * its two lines is the debit. Posting through `recordPayment` at all would also
 * mean a `payments` row, `payments.repository.ts`'s sequence numbers, and the
 * `payments_received.write`/`payments_made.write` permission split — machinery
 * built for a distinct settlement a client applies to invoices, not for a
 * processor's own reversal of clearing it has already posted. `postJournal`
 * directly, `source:'clearing'` (the same source the per-charge fee already
 * uses — no new value, D-104), is the leaner and the correct shape.
 *
 * ## The accounting, spelled out (self-review this against `recordProcessorCharge`)
 *
 * A charge posted **debit clearing, credit AR** (`recordPayment`'s `'received'`
 * journal: `journalLines('received', ...)` debits the bank/clearing side and
 * credits the control account — AR is a debit-normal asset, so crediting it is
 * the "cleared" direction). A refund is the mirror: **debit AR, credit
 * clearing** — clearing loses the cash going back to the customer (a credit,
 * asset down) and AR is reinstated (a debit, asset up) for the amount that is
 * no longer collected. The processor's own fee is **not** reversed here (D-84:
 * "the processor often retains its fee") — only the two lines below post; the
 * per-charge fee journal `recordProcessorCharge` posted earlier stands
 * unaltered.
 *
 * ## Idempotency (D-85, F9) — identical shape to `recordProcessorCharge`
 *
 * The connection row is locked first (append-only journals cannot themselves be
 * locked, D-14), then `external_refs` on the refund's own `externalObjectId` is
 * the object-level guard: a second delivery of the same refund event finds the
 * ref this call wrote and returns it rather than posting twice.
 */
export async function recordProcessorRefund(
  input: RecordProcessorRefundInput,
  ctx: RequestContext,
): Promise<RecordProcessorRefundResult> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const connectionBytes = assertFound(connectionIdBytes(input.connectionId), RESOURCE);
    const connection = assertFound(
      await selectConnectionByIdForUpdate(trx, connectionBytes),
      RESOURCE,
    );

    const existingPaymentId = await findRecordedRef(
      connection.processor,
      'payment',
      input.externalObjectId,
      ctx,
    );
    if (existingPaymentId !== undefined) {
      return { paymentId: existingPaymentId, alreadyRecorded: true };
    }

    const date = toCalendarDate(input.occurredAt);
    const clearingAccountId = bufferToUuid(connection.clearing_account_id);
    const receivableAccountId = bufferToUuid(await resolveControlAccount(trx, 'receivable'));
    const contactId =
      input.invoiceId === null ? undefined : (await getInvoice(input.invoiceId, ctx)).contactId;

    const posted = await postJournal(
      {
        date,
        source: 'clearing',
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        memo: `processor refund ${input.externalObjectId}`,
        lines: refundJournalLines(
          receivableAccountId,
          clearingAccountId,
          toMinorUnits(fromMinorString(input.grossMinor)),
          contactId,
        ),
      },
      ctx,
    );

    await createExternalRef(
      {
        externalSystem: connection.processor,
        entityType: 'payment',
        externalId: input.externalObjectId,
        entityId: posted.journalId,
      },
      ctx,
    );

    return { paymentId: posted.journalId, alreadyRecorded: false };
  });
}

export interface RecordProcessorChargebackInput {
  readonly connectionId: string;
  readonly externalObjectId: string;
  readonly grossMinor: string;
  readonly occurredAt: string;
}

export interface RecordProcessorChargebackResult {
  readonly journalId: string;
  readonly alreadyRecorded: boolean;
}

/**
 * Codes a chargeback at the moment it hits the payout stream (D-84: "recorded
 * and coded when it hits the payout; the full dispute lifecycle
 * [opened/evidence/won/lost] is deferred"). One journal, moving the disputed
 * amount out of the clearing account into a loss/cost bucket — there is no
 * "open dispute" state, no evidence workflow, and no reversal if the dispute is
 * later won; a won dispute is a new event this lean v1 does not model, exactly
 * as D-84 scopes it.
 *
 * ## Which account the loss codes to — a flagged, not a pinned, choice
 *
 * `processor_connections` nominates exactly two accounts (D-103):
 * `clearing_account_id` and `fee_account_id`. There is no third,
 * chargeback-specific account in the `0011_payment_processing` schema, and
 * D-103's "nominate, don't invent" rules out creating one in this file. This
 * function therefore debits the connection's own `fee_account_id` — the
 * processor's already-nominated cost-of-processing account — reusing it as the
 * generic "money this processor relationship cost us" bucket a chargeback loss
 * also is. The visible consequence: chargeback losses and ordinary per-charge
 * fees land on the same P&L line. If that conflation turns out to matter, the
 * fix is a dedicated `chargeback_account_id` column on `processor_connections`
 * — a schema change, and per CLAUDE.md's own note on schema work, the
 * orchestrator's to make, not this ticket's.
 *
 * ## Idempotency (D-85, F9)
 *
 * Same shape as the charge and the refund: the connection row is locked first,
 * then `external_refs` is the object-level guard on the dispute's own
 * `externalObjectId`. `entityType:'journal'` here rather than `'payment'` — a
 * chargeback is a loss, not a settlement of an invoice, so `'journal'` (also a
 * valid `ExternalRefEntityType`) names what this call actually produced instead
 * of borrowing the refund/charge's label for something that is not a payment.
 */
export async function recordProcessorChargeback(
  input: RecordProcessorChargebackInput,
  ctx: RequestContext,
): Promise<RecordProcessorChargebackResult> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const connectionBytes = assertFound(connectionIdBytes(input.connectionId), RESOURCE);
    const connection = assertFound(
      await selectConnectionByIdForUpdate(trx, connectionBytes),
      RESOURCE,
    );

    const existingJournalId = await findRecordedRef(
      connection.processor,
      'journal',
      input.externalObjectId,
      ctx,
    );
    if (existingJournalId !== undefined) {
      return { journalId: existingJournalId, alreadyRecorded: true };
    }

    const date = toCalendarDate(input.occurredAt);
    const clearingAccountId = bufferToUuid(connection.clearing_account_id);
    const feeAccountId = bufferToUuid(connection.fee_account_id);

    const posted = await postJournal(
      {
        date,
        source: 'clearing',
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        memo: `processor chargeback ${input.externalObjectId}`,
        lines: feeJournalLines(
          feeAccountId,
          clearingAccountId,
          toMinorUnits(fromMinorString(input.grossMinor)),
        ),
      },
      ctx,
    );

    await createExternalRef(
      {
        externalSystem: connection.processor,
        entityType: 'journal',
        externalId: input.externalObjectId,
        entityId: posted.journalId,
      },
      ctx,
    );

    return { journalId: posted.journalId, alreadyRecorded: false };
  });
}

// ---------------------------------------------------------------------------
// Small resolutions
// ---------------------------------------------------------------------------

/**
 * The OpenBooks entity this processor object already produced, or `undefined`
 * when it is genuinely new. Generalises `recordProcessorCharge`'s original
 * `findRecordedPayment` over `entityType`, so the refund's `'payment'` lookup
 * and the chargeback's `'journal'` lookup share one implementation.
 *
 * `lookupExternalRef` throws `NotFoundError` on a miss (A7 — a cross-org and a
 * nonexistent ref are the same 404), which is the right contract for every
 * other caller in this codebase, where a miss is terminal. Here a miss is the
 * expected, common case — "this object has not been recorded yet" — so this is
 * the one place that catches it deliberately rather than letting it propagate;
 * any other error still does.
 */
async function findRecordedRef(
  processor: string,
  entityType: ExternalRefEntityType,
  externalObjectId: string,
  ctx: RequestContext,
): Promise<string | undefined> {
  try {
    const ref = await lookupExternalRef(
      { externalSystem: processor, entityType, externalId: externalObjectId },
      ctx,
    );
    return ref.entityId;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/** Debit the receivable control account, credit the clearing account (D-84, J7). */
function refundJournalLines(
  receivableAccountId: string,
  clearingAccountId: string,
  amount: bigint,
  contactId: string | undefined,
): readonly JournalLineInput[] {
  return [
    {
      accountId: receivableAccountId,
      side: 'debit',
      amount,
      ...(contactId === undefined ? {} : { contactId }),
    },
    {
      accountId: clearingAccountId,
      side: 'credit',
      amount,
      ...(contactId === undefined ? {} : { contactId }),
    },
  ];
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
