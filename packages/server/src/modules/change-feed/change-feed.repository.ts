import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import { applyKeyset, counterKey, orgScope as toOrgId, tenantDb, toKeysetPage } from '../../db';

/**
 * Data access for `event_log`, read-only (OB-101; ROADMAP D-56, D-57).
 *
 * This file holds no write path — `modules/events/outbox.ts` is the only writer,
 * inside the transaction of the state change it announces (F7). The feed is a
 * projection of that log, not a second store, so there is nothing here to keep in
 * sync with it.
 *
 * `tenantDb` scopes every statement to `ctx.orgId` before this file adds a
 * predicate, matching `api-keys.repository.ts` and every other module reading a
 * tenant table.
 */

/** The scope every operation in this module runs in (spec §4 — never a parameter). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

const CHANGE_FEED_COLUMNS = [
  'id',
  'position',
  'name',
  'actor_type',
  'actor_id',
  'invocation_mode',
  'payload',
  'occurred_at',
] as const;

/**
 * The raw row shape, snake_case and undecoded — the same split
 * `api-keys.repository.ts` makes, where this file hands back exactly what the
 * table holds and `change-feed.service.ts` renders it to the wire shape.
 *
 * `payload` is `unknown` rather than the generated `Json` (`JsonValue`) type,
 * matching `oauth.repository.ts`'s `redirect_uris: unknown` — mysql2 has already
 * parsed the column by the time Kysely hands it back, so there is nothing to
 * decode here, only to narrow, which is `change-feed.service.ts`'s job because it
 * is the one place that knows the shape a `changeFeedEventSchema.payload` must
 * satisfy.
 */
export interface ChangeFeedRow {
  readonly id: Buffer;
  readonly position: bigint;
  readonly name: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly invocation_mode: string | null;
  readonly payload: unknown;
  readonly occurred_at: Date;
}

/**
 * `position` alone, ascending — it is already a total order within an org
 * (`uq_event_log_org_position`, `event_positions`' `FOR UPDATE` allocation in
 * `outbox.ts`), so this ordering needs no tiebreaker the way `(created_at, id)`
 * elsewhere in this codebase does for a column that is not itself unique.
 */
const CHANGE_FEED_KEYSET: KeysetOrdering<ChangeFeedRow> = [
  counterKey('event_log.position', (row) => row.position),
];

/**
 * One page of the org's event log, oldest first — the direction a feed is
 * followed forward from a cursor, matching `listJournals`' "not newest-first"
 * reasoning for the same kind of append-only source.
 */
export async function selectChangeFeedPage(
  db: TenantDatabase,
  limit: number,
  cursor: string | undefined,
): Promise<KeysetPage<ChangeFeedRow>> {
  const query = db.selectFrom('event_log').select(CHANGE_FEED_COLUMNS);
  const rows = await applyKeyset(query, CHANGE_FEED_KEYSET, limit, cursor).execute();

  return toKeysetPage(rows, CHANGE_FEED_KEYSET, limit);
}
