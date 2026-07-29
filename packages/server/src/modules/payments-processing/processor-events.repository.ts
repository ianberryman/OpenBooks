import type { NormalizedProcessorEvent, ProcessorKind } from '@openbooks/plugin-api';

import type { TenantDatabase } from '../../db';
import { isDuplicateEntryError, newUuidBuffer } from '../../db';

/**
 * `processor_events` (OB-148; ROADMAP D-85, F9; migration `0011_payment_processing`)
 * — the webhook/poll event log and the first of the two idempotency guards a
 * processor delivery passes through. See `posting.service.ts`'s file header for the
 * second (`external_refs`, object-level) and why both are needed.
 *
 * `status` lifecycle: `received` on insert, `processed` once a charge/refund/payout/
 * dispute has posted, `ignored` for a `fee` event (folded into the charge, D-104),
 * `failed` with `processing_error` set otherwise. Read `webhook.service.ts` for who
 * drives the transitions.
 */

export type ProcessorEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

/** Every status but the one `insertProcessorEventIfNew` itself writes. */
export type ProcessorEventOutcome = Exclude<ProcessorEventStatus, 'received'>;

export interface NewProcessorEventRow {
  readonly connectionId: Buffer;
  readonly processor: ProcessorKind;
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly eventType: NormalizedProcessorEvent['kind'];
  readonly payload: NormalizedProcessorEvent;
}

/** `VARCHAR(512)` on the schema — an operator message is truncated, never rejected. */
const PROCESSING_ERROR_MAX_LENGTH = 512;

/**
 * Inserts a `processor_events` row at `status:'received'`, or recognises a
 * redelivery through `uq_processor_events_external` — `(org_id, processor,
 * external_event_id)` — and returns `false` without inserting.
 *
 * This is the event-level guard (F9): a webhook redelivery, or a poll re-fetching
 * an event the webhook already captured, loses the race to this unique key and is
 * turned back here, before it ever reaches `posting.service.ts`'s
 * `external_refs`/connection-lock guard one layer in.
 *
 * `payload` is the normalised event verbatim, JSON-stringified — every money
 * field on `NormalizedProcessorEvent` is already a cents string (D-13), so this
 * is a plain `JSON.stringify` with no `bigint` to special-case, unlike the event
 * outbox's own serializer (`modules/events/outbox.ts`).
 */
export async function insertProcessorEventIfNew(
  db: TenantDatabase,
  input: NewProcessorEventRow,
): Promise<boolean> {
  try {
    await db
      .insertInto('processor_events')
      .values({
        id: newUuidBuffer(),
        connection_id: input.connectionId,
        processor: input.processor,
        external_event_id: input.externalEventId,
        external_object_id: input.externalObjectId,
        event_type: input.eventType,
        status: 'received',
        payload: JSON.stringify(input.payload),
        processing_error: null,
        processed_at: null,
      })
      .execute();
    return true;
  } catch (error) {
    if (isDuplicateEntryError(error)) return false;
    throw error;
  }
}

/**
 * Records the outcome of processing an event this same request already inserted
 * (`insertProcessorEventIfNew` returned `true`) — filtered on the unique key's
 * own two non-org columns, which is enough: `uq_processor_events_external`
 * guarantees at most one row per `(org_id, processor, external_event_id)` inside
 * this org's scope.
 */
export async function markProcessorEvent(
  db: TenantDatabase,
  processor: ProcessorKind,
  externalEventId: string,
  status: ProcessorEventOutcome,
  processingError?: string,
): Promise<void> {
  const truncatedError =
    processingError === undefined ? null : processingError.slice(0, PROCESSING_ERROR_MAX_LENGTH);

  await db
    .updateTable('processor_events')
    .set({ status, processed_at: new Date(), processing_error: truncatedError })
    .where('processor', '=', processor)
    .where('external_event_id', '=', externalEventId)
    .execute();
}
