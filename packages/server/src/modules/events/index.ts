/**
 * The event bus and transactional outbox (OB-100; ROADMAP D-56).
 *
 * `emitEvent` (`outbox.ts`) is the durable half: one `event_log` row per
 * committed domain event, written in the same transaction as the state change it
 * describes, numbered by a per-org `FOR UPDATE` counter exactly as
 * `posting.repository.ts` numbers a journal. That row exists if and only if the
 * change it names committed (F7), and its `position` gives per-org events a total
 * order (F8). The four subledger services and the reconciliation service call it
 * once each, after their own state write, from inside the transaction they
 * already hold open.
 *
 * `InProcessEventBus` and `registerEventRelay` (`bus.ts`) are the notification
 * half M6 consumes — see that file's header for why nothing in M5 calls either.
 * The change feed a client or integrator actually reads (OB-101) is a keyset
 * page over `event_log` itself, not this bus.
 */
export { emitEvent } from './outbox';
export { InProcessEventBus, registerEventRelay } from './bus';
export type { EventRelayDeps } from './bus';
