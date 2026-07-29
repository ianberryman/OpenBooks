import { isActorType, isInvocationMode } from '@openbooks/plugin-api';
import type {
  ChangeFeedActor,
  ChangeFeedEvent,
  ChangeFeedPage,
  ChangeFeedQuery,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { bufferToUuid, resolvePageLimit } from '../../db';
import { InternalError } from '../../errors';
import { requirePermission } from '../permissions';

import type { ChangeFeedRow } from './change-feed.repository';
import { orgScope, selectChangeFeedPage } from './change-feed.repository';

/**
 * The change feed: a resumable, tenant-scoped read over the `event_log` outbox
 * (OB-101; ROADMAP D-56, D-57). Not a second store — every call re-reads the same
 * append-only rows `modules/events/outbox.ts` writes, so replay is just reading
 * from an earlier `cursor` again (F8). No route lives here; OB-104 owns the HTTP
 * surface, and this is equally reachable from an MCP tool (M5) with no schema in
 * front of it, matching `listApiKeys`'s reasoning.
 *
 * `requirePermission` runs first, before anything else, matching every other
 * service in this tree.
 */

/**
 * How far back a consumer can resync before the rows it would ask for are gone
 * (D-57; spec §14). This is the operator's number, not a derived one — chosen here
 * at 90 days as the bound the feed is documented to honor.
 *
 * There is no pruning job yet: nothing in this codebase deletes from `event_log`
 * (it holds no `UPDATE`/`DELETE` grant for `openbooks_app`, `0999_app_grants`),
 * so today the feed simply reads whatever exists, for however long it exists.
 * Enforcing the bound — deleting or archiving rows older than it — is a later
 * cleanup concern, tracked separately from this read path.
 */
export const CHANGE_FEED_RETENTION_DAYS = 90;

/**
 * One page of the org's change feed, oldest first.
 *
 * `query` is accepted and used exactly as `listJournals` uses `ListJournalsQuery`:
 * `resolvePageLimit` and the cursor decoder inside `applyKeyset` are the
 * validation for every list endpoint, not a second parse against
 * `changeFeedQuerySchema` here — that schema exists for the published artifact,
 * not to gate this call.
 */
export async function readChangeFeed(
  query: ChangeFeedQuery,
  ctx: RequestContext,
): Promise<ChangeFeedPage> {
  await requirePermission(ctx, 'integrations.read');

  const limit = resolvePageLimit(query.limit);
  const page = await selectChangeFeedPage(orgScope(ctx), limit, query.cursor);

  return { events: page.rows.map(toChangeFeedEvent), nextCursor: page.nextCursor };
}

function toChangeFeedEvent(row: ChangeFeedRow): ChangeFeedEvent {
  return {
    eventId: bufferToUuid(row.id),
    // A BIGINT, stringified — `changeFeedEventSchema.position`'s own reasoning,
    // the same one `journal-list.service.ts` gives for `sequenceNumber`.
    position: row.position.toString(),
    name: row.name,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so this is a lossless rendering of a real instant —
    // matching `toJournalSummary`'s `postedAt`.
    occurredAt: row.occurred_at.toISOString(),
    actor: toChangeFeedActor(row),
    payload: toChangeFeedPayload(row.payload),
  };
}

/**
 * `event_log.actor_type`/`actor_id` are plain `VARCHAR`, deliberately wider than
 * this project's ledger actor vocabulary (`0010_platform`'s own comment on the
 * table: a future subsystem may publish with an actor shape `journals`' `ENUM`
 * cannot hold). Today's only writer, `emitEvent` (OB-100), always takes a
 * `plugin-api` `ActorProvenance`, so every row this ticket can read back does
 * satisfy the narrower wire vocabulary — `isActorType`/`isInvocationMode` check
 * that invariant rather than assert it, and report the one way it could be wrong
 * (a future publisher outrunning this feed's contract) as an `InternalError`
 * instead of silently mis-typing the response.
 */
function toChangeFeedActor(row: ChangeFeedRow): ChangeFeedActor {
  if (!isActorType(row.actor_type)) {
    throw new InternalError(
      `event_log.actor_type held an unrecognized value: "${row.actor_type}".`,
    );
  }

  if (row.invocation_mode === null) {
    return { actorType: row.actor_type, actorId: row.actor_id };
  }

  if (!isInvocationMode(row.invocation_mode)) {
    throw new InternalError(
      `event_log.invocation_mode held an unrecognized value: "${row.invocation_mode}".`,
    );
  }

  return {
    actorType: row.actor_type,
    actorId: row.actor_id,
    invocationMode: row.invocation_mode,
  };
}

/**
 * `payload` is `JSON NOT NULL` and mysql2 has already parsed it by the time
 * Kysely hands the row back (`Json`'s select type is `JsonValue`, matching
 * `oauth.repository.ts`'s `toRedirectUris` comment) — there is no string to
 * `JSON.parse`, only a shape to narrow to `changeFeedEventSchema.payload`
 * (`z.record(z.string(), z.unknown())`). Every payload `emitEvent` writes is an
 * event's own object body (`OpenBooksEvent`'s payload interfaces in
 * `plugin-api`), never an array or a primitive, so a value that is not a plain
 * object here is this process's own write having gone wrong, the same class of
 * failure `toRedirectUris` guards against.
 */
function toChangeFeedPayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new InternalError('event_log.payload did not hold a JSON object.');
}
