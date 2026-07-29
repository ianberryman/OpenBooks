import type { ActorProvenance } from './actor';
import type { CalendarDate, Instant, MinorUnits } from './primitives';

/**
 * Envelope for every published event.
 *
 * Publishers do not mint `eventId` or `occurredAt` — see `OpenBooksEventInput`.
 * The M5 change feed replays from these same records, so identity and ordering
 * have to be assigned in one place or two publishers will disagree about what
 * "the same event" means.
 */
export interface EventEnvelope<TName extends string, TPayload> {
  readonly name: TName;
  readonly eventId: string;
  readonly orgId: string;
  readonly occurredAt: Instant;
  /** Who caused it (spec §6). Carried on the envelope so no payload has to repeat it. */
  readonly actor: ActorProvenance;
  readonly payload: TPayload;
}

export interface JournalPostedV1Payload {
  readonly journalId: string;
  readonly date: CalendarDate;
  readonly lineCount: number;
  /** One side's total; debits equal credits by construction (spec §11). */
  readonly total: MinorUnits;
  readonly accountIds: readonly string[];
}

export type JournalPostedV1 = EventEnvelope<'journal.posted.v1', JournalPostedV1Payload>;

export interface JournalReversedV1Payload {
  /** The reversing journal — the new row. */
  readonly journalId: string;
  /** The journal it reverses (D-02). */
  readonly reversesJournalId: string;
  readonly date: CalendarDate;
}

export type JournalReversedV1 = EventEnvelope<'journal.reversed.v1', JournalReversedV1Payload>;

/**
 * The four subledger writes and one banking assertion the outbox (OB-100, D-56)
 * carries beside the two journal events above. Each names the journal it posted
 * to — a subscriber that only cares about money moving can key off `journalId`
 * and ignore which subledger produced it — except `ReconciliationFinalisedV1`,
 * which posts nothing: finalising is an assertion about a window already posted,
 * not a new entry (D-50).
 */
export interface InvoiceApprovedV1Payload {
  readonly invoiceId: string;
  readonly contactId: string;
  readonly journalId: string;
  readonly total: MinorUnits;
  readonly date: CalendarDate;
}

export type InvoiceApprovedV1 = EventEnvelope<'invoice.approved.v1', InvoiceApprovedV1Payload>;

export interface CreditNoteApprovedV1Payload {
  readonly creditNoteId: string;
  readonly contactId: string;
  readonly journalId: string;
  readonly total: MinorUnits;
  readonly date: CalendarDate;
}

export type CreditNoteApprovedV1 = EventEnvelope<
  'credit_note.approved.v1',
  CreditNoteApprovedV1Payload
>;

export interface BillApprovedV1Payload {
  readonly billId: string;
  readonly contactId: string;
  readonly journalId: string;
  readonly total: MinorUnits;
  readonly date: CalendarDate;
}

export type BillApprovedV1 = EventEnvelope<'bill.approved.v1', BillApprovedV1Payload>;

export interface PaymentRecordedV1Payload {
  readonly paymentId: string;
  readonly contactId: string;
  /** Which way the money moved (D-37): a receipt or a disbursement. */
  readonly direction: 'received' | 'made';
  readonly journalId: string;
  readonly amount: MinorUnits;
  readonly date: CalendarDate;
}

export type PaymentRecordedV1 = EventEnvelope<'payment.recorded.v1', PaymentRecordedV1Payload>;

export interface ReconciliationFinalisedV1Payload {
  readonly sessionId: string;
  readonly bankAccountId: string;
  /** The session's `end_date` (D-51): the window this assertion covers, through this date. */
  readonly clearedThrough: CalendarDate;
}

export type ReconciliationFinalisedV1 = EventEnvelope<
  'reconciliation.finalised.v1',
  ReconciliationFinalisedV1Payload
>;

/**
 * Additive only.
 *
 * A new event is a new member of this union. A semantic change to an existing
 * payload is a new `.v2` type published alongside the `.v1` until subscribers
 * migrate; the `.v1` is not edited. Removing a member is a breaking change and
 * does not happen inside 0.x — spec §8 puts integrators on the other end of this
 * union, and they are the ones who pay for a removal.
 *
 * The version lives in the name rather than in a field so that narrowing on
 * `name` yields the payload type for free, and so that a subscriber left behind
 * by a `.v2` fails to compile instead of receiving a payload it misreads.
 */
export type OpenBooksEvent =
  | JournalPostedV1
  | JournalReversedV1
  | InvoiceApprovedV1
  | CreditNoteApprovedV1
  | BillApprovedV1
  | PaymentRecordedV1
  | ReconciliationFinalisedV1;

export type OpenBooksEventName = OpenBooksEvent['name'];

export type EventOf<TName extends OpenBooksEventName> = Extract<OpenBooksEvent, { name: TName }>;

// `Omit` over a union collapses it to the common members; distributing keeps the
// discriminant, which is the whole point of the union.
type DistributiveOmit<T, TKeys extends PropertyKey> = T extends unknown ? Omit<T, TKeys> : never;

export type OpenBooksEventInput = DistributiveOmit<OpenBooksEvent, 'eventId' | 'occurredAt'>;

export type EventHandler<TName extends OpenBooksEventName> = (
  event: EventOf<TName>,
) => Promise<void>;

export interface EventBus {
  /**
   * Called after the originating transaction commits. An event announcing a
   * journal that was rolled back is worse than a late event, and there is no way
   * for a subscriber to tell the difference after the fact.
   */
  publish(event: OpenBooksEventInput): Promise<void>;
  /**
   * Async to match `QueueProvider.subscribe`, so an in-process bus and a
   * queue-backed one register identically and the self-host/hosted split stays a
   * configuration choice rather than a code path (D-07).
   */
  subscribe<TName extends OpenBooksEventName>(
    name: TName,
    handler: EventHandler<TName>,
  ): Promise<void>;
}
