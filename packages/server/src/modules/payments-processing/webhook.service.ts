import type { NormalizedProcessorEvent, ProcessorKind } from '@openbooks/plugin-api';

import type { RequestContext } from '../../context';
import { assertFound, ValidationError } from '../../errors';

import {
  PROCESSOR_CONNECTION_RESOURCE as RESOURCE,
  connectionIdBytes,
  orgScope,
} from './connections.repository';
import { loadConnectionProvider } from './connections.service';
import {
  recordProcessorCharge,
  recordProcessorChargeback,
  recordProcessorPayout,
  recordProcessorRefund,
} from './posting.service';
import type { ProcessorEventOutcome } from './processor-events.repository';
import { insertProcessorEventIfNew, markProcessorEvent } from './processor-events.repository';

/**
 * The webhook receiver (OB-148; ROADMAP D-85, F9) — the public route's one call.
 * `transport/routes/processing-webhook.ts` maps the HTTP request to
 * `HandleWebhookInput` and this request's `runAsAutomation` context; everything
 * from signature verification on is here, per spec §2.4 (transport holds no
 * business logic).
 *
 * ## Two-level idempotency, and where each level lives
 *
 * `recordNormalizedEvent` is shared between this file's `handleProcessorWebhook`
 * and the polling backstop (`poll.job.ts`) — a redriven event and a freshly
 * delivered one go through the identical dedup path, which is the point: a poll
 * catching what a webhook missed must not become a second way to double-post.
 *
 *  1. **Event-level** (`processor_events.uq_processor_events_external`,
 *     `processor-events.repository.ts`): a redelivery of the same
 *     `externalEventId` loses the unique-key race and this file never attempts
 *     to dispatch it a second time — cheap, and first.
 *  2. **Object-level** (`external_refs`, `posting.service.ts`): a poll and a
 *     webhook can report the *same charge/refund/payout* under two different
 *     `externalEventId`s, so `recordProcessorCharge`/`recordProcessorRefund`/
 *     `recordProcessorChargeback` each re-check `external_refs` on the object's
 *     own id before posting, under a lock on the connection row (journals
 *     cannot themselves be `SELECT … FOR UPDATE`'d, D-14). This file takes no
 *     lock of its own — the domain functions already do, and locking twice
 *     would only risk a self-deadlock for no additional guarantee.
 *
 * ## A processing failure does not become a 5xx
 *
 * Once the signature verifies, a `processor_events` row exists at
 * `status:'received'` for this delivery — durable proof it arrived — before any
 * dispatch is attempted. If the dispatch itself then throws (an invoice
 * deleted out from under a charge, a database hiccup), the row is marked
 * `failed` with `processing_error` and this function returns normally rather
 * than rethrowing: Stripe/Square redeliver on a non-2xx, but redelivery would
 * hit the same `external_event_id` and be turned back at the event-level guard
 * without ever retrying the dispatch, so a 5xx here would only cost the
 * processor a wasted retry budget, not buy this system a second attempt. The
 * real recovery path for a delivery that failed once is the D-85 polling
 * backstop's *balance* reconciliation noticing the clearing account disagrees
 * with the processor — advisory, logged, not auto-corrected (`poll.job.ts`) —
 * not an event redrive, because the redrive shares this same event-level guard
 * and would refuse the identical row. Flagged here as a known, accepted
 * limitation rather than a silent one: a stuck `failed` row needs an operator
 * or a future status-aware redrive to clear, neither built in this ticket.
 */

export interface HandleWebhookInput {
  readonly connectionId: string;
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string;
}

export interface HandleWebhookResult {
  readonly status: 'processed' | 'ignored' | 'duplicate' | 'failed';
}

/**
 * Verifies the inbound delivery's signature and hands the normalised event to
 * `recordNormalizedEvent`.
 *
 * A signature that does not verify throws `ValidationError` (400) — the
 * provider's own `verifyAndParseWebhook` throws a plain `Error` (`fake.ts`'s
 * shape, matched by the real Stripe/Square adapters), and an unrecognised
 * `Error` reaching `transport/errors.ts` would otherwise become an opaque 500
 * (`normalize`'s fallback). The caller has no session to retry with a corrected
 * signature — a 400 is what tells Stripe/Square this delivery, not this
 * server, is what needs fixing.
 */
export async function handleProcessorWebhook(
  input: HandleWebhookInput,
  ctx: RequestContext,
): Promise<HandleWebhookResult> {
  const { connection, provider } = await loadConnectionProvider(input.connectionId, ctx);

  let event: NormalizedProcessorEvent;
  try {
    event = await provider.verifyAndParseWebhook({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
    });
  } catch (error) {
    throw new ValidationError(
      `Processor webhook signature verification failed: ${errorMessage(error)}`,
    );
  }

  return recordNormalizedEvent(input.connectionId, connection.processor, event, ctx);
}

/**
 * Records one normalised event through the two-level guard above, dispatching
 * by `event.kind` to the matching `posting.service.ts` function. Exported for
 * `poll.job.ts`'s redrive, which is this function's second and only other
 * caller (see this file's header).
 */
export async function recordNormalizedEvent(
  connectionId: string,
  processor: ProcessorKind,
  event: NormalizedProcessorEvent,
  ctx: RequestContext,
): Promise<HandleWebhookResult> {
  const db = orgScope(ctx);
  const connectionBytes = assertFound(connectionIdBytes(connectionId), RESOURCE);

  const isNew = await insertProcessorEventIfNew(db, {
    connectionId: connectionBytes,
    processor,
    externalEventId: event.externalEventId,
    externalObjectId: event.externalObjectId,
    eventType: event.kind,
    payload: event,
  });
  if (!isNew) return { status: 'duplicate' };

  try {
    const outcome = await dispatch(connectionId, event, ctx);
    await markProcessorEvent(db, processor, event.externalEventId, outcome);
    return { status: outcome };
  } catch (error) {
    await markProcessorEvent(db, processor, event.externalEventId, 'failed', errorMessage(error));
    return { status: 'failed' };
  }
}

/**
 * Dispatches one event to the posting model, returning what
 * `recordNormalizedEvent` records the `processor_events` row as. `fee` is
 * folded into the charge (D-104: the per-charge fee posts inside
 * `recordProcessorCharge` itself) and every standalone `fee` delivery is
 * therefore `'ignored'` here rather than posted a second time.
 */
async function dispatch(
  connectionId: string,
  event: NormalizedProcessorEvent,
  ctx: RequestContext,
): Promise<ProcessorEventOutcome> {
  switch (event.kind) {
    case 'fee':
      return 'ignored';

    case 'charge': {
      if (event.invoiceId === null) {
        // D-83: the checkout session carries the invoice id for certain
        // identity. A charge with none is not a guess this system is willing
        // to make (unlike the inferred bank-feed match), so it fails loudly
        // rather than posting to an invoice it invented.
        throw new Error(
          `processor charge ${event.externalObjectId} carried no invoiceId in its checkout ` +
            'session metadata (D-83); there is nothing to allocate it to.',
        );
      }
      await recordProcessorCharge(
        {
          connectionId,
          invoiceId: event.invoiceId,
          externalObjectId: event.externalObjectId,
          grossMinor: event.grossMinor,
          feeMinor: event.feeMinor,
          occurredAt: event.occurredAt,
        },
        ctx,
      );
      return 'processed';
    }

    case 'refund':
      await recordProcessorRefund(
        {
          connectionId,
          invoiceId: event.invoiceId,
          externalObjectId: event.externalObjectId,
          grossMinor: event.grossMinor,
          occurredAt: event.occurredAt,
        },
        ctx,
      );
      return 'processed';

    case 'payout':
      await recordProcessorPayout(
        {
          connectionId,
          externalObjectId: event.externalObjectId,
          // A payout's net is what the D-82 cursor cares about; `netMinor` is
          // only `null` outside a payout event (plugin-api `providers.ts`), so
          // this falls back to `grossMinor` purely defensively — an adapter
          // reporting a payout with no net figure at all.
          netMinor: event.netMinor ?? event.grossMinor,
          occurredAt: event.occurredAt,
        },
        ctx,
      );
      return 'processed';

    case 'dispute':
      await recordProcessorChargeback(
        {
          connectionId,
          externalObjectId: event.externalObjectId,
          grossMinor: event.grossMinor,
          occurredAt: event.occurredAt,
        },
        ctx,
      );
      return 'processed';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
