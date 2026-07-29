import { randomUUID } from 'node:crypto';

import type {
  EventBus,
  EventHandler,
  EventOf,
  OpenBooksEvent,
  OpenBooksEventInput,
  OpenBooksEventName,
  QueueProvider,
} from '@openbooks/plugin-api';

import type { Logger } from '../../logging';

/**
 * The in-process `EventBus` (`plugin-api`'s `publish`/`subscribe`, and M6's
 * `ModuleHost.events`).
 *
 * Nothing in M5 calls `publish`: the durable, ordered record of an event is
 * `event_log`, written by `emitEvent` (`outbox.ts`) inside the same transaction as
 * the state change it describes (F7/F8), and that guarantee does not depend on
 * anything below reading it. This bus is the *notification* seam spec §8 reserves
 * for M6's modules — a subscriber registered here sees an event at most once,
 * immediately, in whatever order `publish` happens to be called, with no record
 * kept of having delivered it. A module that needs "every event since I last
 * looked, in order, even across a restart" reads the change feed (OB-101)
 * instead; this bus is not that and is not meant to grow into it.
 *
 * `eventId`/`occurredAt` are stamped here rather than accepted from a caller,
 * mirroring `emitEvent`: `events.ts`'s header states a publisher never mints
 * either, and that holds independently of which of the two paths — the outbox
 * insert or this bus — a given call travels.
 */
type ErasedHandler = (event: OpenBooksEvent) => Promise<void>;

export class InProcessEventBus implements EventBus {
  readonly #handlers = new Map<OpenBooksEventName, Set<ErasedHandler>>();

  async publish(event: OpenBooksEventInput): Promise<void> {
    const handlers = this.#handlers.get(event.name);
    if (handlers === undefined || handlers.size === 0) return;

    const envelope = {
      ...event,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    } as OpenBooksEvent;

    for (const handler of handlers) {
      await handler(envelope);
    }
  }

  subscribe<TName extends OpenBooksEventName>(
    name: TName,
    handler: EventHandler<TName>,
  ): Promise<void> {
    const set = this.#handlers.get(name) ?? new Set<ErasedHandler>();
    // `#handlers` is keyed by `name`, and `publish` only ever calls a handler pulled
    // from the bucket matching `event.name` — so by the time this wrapper runs,
    // `event` is guaranteed (by that indexing, not by the type system) to satisfy
    // `EventOf<TName>` for the `TName` this handler was registered under. The cast
    // restates what the map's own structure already promises; `tenant.ts`'s
    // `withOrgScope` narrows a Kysely builder the same way, for the same reason —
    // TypeScript cannot see through the runtime dispatch that makes it true.
    set.add((event) => handler(event as EventOf<TName>));
    this.#handlers.set(name, set);
    return Promise.resolve();
  }
}

/**
 * What a worker-side relay needs once it exists.
 *
 * Exported now so `worker.ts` wiring — `registerEventRelay(queueProvider(), {
 * bus, logger })`, `registerDunningJob`'s shape exactly — is a one-line change
 * when M6 lands the first subscriber, rather than a seam invented at that point.
 */
export interface EventRelayDeps {
  readonly bus: EventBus;
  readonly logger: Logger;
}

/**
 * The seam a worker-side relay registers into, once something subscribes.
 *
 * Deliberately not registered from `worker.ts` or `api.ts`: those wire one job
 * per queue that has a consumer (`registerStatementImportJob`,
 * `registerDunningJob`), and this queue has none — nothing in M5 calls
 * `deps.bus.subscribe`. Registering a handler now would give the daily tick's
 * shape (a named queue, a `QueueProvider.subscribe`) with nothing to deliver,
 * which reads as wired while doing nothing — worse than the gap being visible.
 *
 * OB-101 (the change feed) and M6 (the first subscriber) are what turn this into
 * the real relay: read `event_log` in `position` order past the org's stored
 * `change_feed_cursors` row, call `bus.publish` for each, and advance the cursor
 * only after every handler resolves — at-least-once, per D-56, which is why a
 * subscriber must be idempotent rather than this relay being exactly-once. None
 * of that poll loop is implemented here; this function's signature is the
 * contract a caller can already build against, so that work is additive rather
 * than a second interface change.
 */
export function registerEventRelay(_queue: QueueProvider, _deps: EventRelayDeps): void {
  // Intentionally empty — see the header above.
}
