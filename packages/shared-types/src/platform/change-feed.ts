import { z } from 'zod';

import { pageCursorSchema, pageQueryShape } from '../wire';

/**
 * The change feed (OB-097; ROADMAP D-56, D-57) — a resumable, tenant-scoped read over the
 * append-only `event_log`, not a second store (D-57). Replay is re-reading from an earlier
 * position; there is no denormalized feed table that could drift from the log.
 *
 * `position` is the per-org monotonic counter D-56 assigns as each event is relayed — a
 * `BIGINT`, so it crosses the wire as a string for `sequenceNumber`'s reason in
 * `journals.ts` (D-13's argument applied to an identifier rather than to money). It is
 * distinct from `nextCursor`: `position` is a visible fact about one event, `nextCursor` is
 * an opaque token a client stores and replays verbatim, exactly as `pagination.ts` argues
 * for every other list. Reusing `pageCursorSchema`/`pageQueryShape` here is that same cursor
 * applied to a keyset over `event_log` instead of over a table's `(created_at, id)`.
 *
 * `.meta({ id })` (OB-104) on the event and actor shapes and on the page, now that
 * `GET /v1/change-feed` gives them a route. `changeFeedQuerySchema` stays un-ided — a
 * querystring is emitted as individual `parameters`, so a component for it would be
 * $ref'd by nothing.
 */

/**
 * Who or what caused the event, mirroring the provenance `postedJournalSchema` already
 * carries (spec §6) — a change-feed event is not only journals, so this is declared once
 * here rather than imported from `journals.ts`.
 */
export const changeFeedActorSchema = z
  .strictObject({
    actorType: z.enum(['user', 'automation', 'agent']),
    actorId: z.string().meta({
      description:
        'The acting user, API key, or agent session. A string rather than `z.uuid()`: an ' +
        'automation actor is not always keyed by a UUID the way a user row is.',
    }),
    invocationMode: z
      .enum(['interactive', 'scheduled'])
      .optional()
      .meta({
        description:
          'Whether a human was present. Absent for `user`/`automation` actors; set for `agent` ' +
          'callers only, `postedJournalSchema`’s `invocationMode` restated per event rather ' +
          'than as a nullable column read back verbatim.',
      }),
  })
  .meta({
    id: 'ChangeFeedActor',
    description: 'Who or what caused a change-feed event.',
  });

export type ChangeFeedActor = z.infer<typeof changeFeedActorSchema>;

/**
 * One row of the feed. `payload` is deliberately opaque here — `z.record(z.string(),
 * z.unknown())` rather than a union of every event's shape — because the feed's own
 * contract is the envelope (`eventId`, `position`, `name`, `actor`), and an integrator
 * narrows `payload` against `name` using each event's own published shape (`OpenBooksEvent`
 * in `plugin-api`), which grows additively (D-56) without this envelope ever changing.
 */
export const changeFeedEventSchema = z
  .strictObject({
    eventId: z.uuid(),
    position: z.string().meta({
      description:
        'This event’s position in the org’s total order (D-56). Monotonic and unique within ' +
        'the org; a `BIGINT` carried as a string for the reason `sequenceNumber` is in ' +
        '`journals.ts`.',
    }),
    name: z.string().meta({
      description: 'The event name, e.g. `invoice.approved.v1`. Versioned in the name itself.',
    }),
    occurredAt: z.iso.datetime(),
    actor: changeFeedActorSchema,
    payload: z.record(z.string(), z.unknown()).meta({
      description:
        'The event’s own body, opaque to this envelope. Narrow it against `name` using the ' +
        'published shape for that event.',
    }),
  })
  .meta({
    id: 'ChangeFeedEvent',
    description: 'One row of the resumable, tenant-scoped change feed (D-56, D-57).',
  });

export type ChangeFeedEvent = z.infer<typeof changeFeedEventSchema>;

/**
 * `limit`/`cursor` spread from `pageQueryShape` rather than restated: the feed's cursor is
 * the same opaque, server-owned token every other list uses (`pageCursorSchema`), applied
 * to a keyset over `event_log`'s position instead of over `(created_at, id)`. There is no
 * page offset — a change feed is followed forward from a cursor, never jumped into by page
 * number.
 */
export const changeFeedQuerySchema = z.strictObject({
  ...pageQueryShape,
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ChangeFeedQuery = z.input<typeof changeFeedQuerySchema>;

/**
 * Local and inline rather than through `pageSchema` — `oauth.ts`'s `oauthClientPageSchema`
 * reasoning applied here too. `events`, not `items`: the one list on the platform surface
 * that is not a resource collection so much as a log, and the name says so.
 */
export const changeFeedPageSchema = z
  .strictObject({
    events: z.array(changeFeedEventSchema),
    nextCursor: pageCursorSchema.nullable(),
  })
  .meta({
    id: 'ChangeFeedPage',
    description: 'One page of the org’s change feed, oldest first.',
  });

export type ChangeFeedPage = z.infer<typeof changeFeedPageSchema>;
