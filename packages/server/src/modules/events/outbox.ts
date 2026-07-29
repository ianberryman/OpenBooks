import type { OpenBooksEventInput } from '@openbooks/plugin-api';

import type { RequestContext } from '../../context';
import type { OrgId, TenantDatabase } from '../../db';
import { newUuidBuffer, orgScope, tenantDb } from '../../db';

/**
 * Allocates the next `event_log.position` for an org (D-56) — `journal_sequences`'
 * three-statement pattern applied a second time (`posting.repository.ts`'s
 * `allocateSequenceNumber`, which explains at length why it is three statements
 * and not one clever upsert).
 *
 * `event_log` holds no `UPDATE`/`DELETE` grant for `openbooks_app`
 * (`0999_app_grants`), so the row a relay would take `FOR UPDATE` to order the log
 * cannot be a row *in* the log — `event_positions` is the mutable counter beside
 * it, exactly as `journal_sequences` sits beside the append-only `journals`.
 */
async function allocateEventPosition(db: TenantDatabase, orgId: OrgId): Promise<bigint> {
  await db
    .insertInto('event_positions')
    .values({ next_value: 1n })
    .onDuplicateKeyUpdate({ org_id: orgId })
    .execute();

  const counter = await db
    .selectFrom('event_positions')
    .select('next_value')
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('event_positions')
    .set({ next_value: counter.next_value + 1n })
    .execute();

  return counter.next_value;
}

/**
 * Appends one event to the transactional outbox (D-56; the core guarantee this
 * ticket builds: F7 — the state change and its `event_log` row commit together,
 * so an event exists if and only if its change did — and F8, per-org total
 * ordering from the `FOR UPDATE` counter above).
 *
 * `tenantDb()` joins whichever transaction is already open in this async scope
 * rather than opening one of its own (`transaction-scope.ts`), so a call made
 * from inside a service's `orgScope(ctx).transaction(...)` body lands on the same
 * connection as the state write beside it — the position allocation and the
 * `event_log` insert are two more statements in the caller's transaction, and a
 * rollback of it takes both with it. There is deliberately no `.transaction()`
 * call here: every call site this ticket adds is already inside one, and this
 * function trusts that rather than defending against a caller that is not — an
 * `emitEvent` with no ambient transaction would commit the event on its own
 * connection, which is exactly the phantom-event failure F7 exists to rule out.
 *
 * `id` is the host-side `eventId` — minted here, never by a publisher, per the
 * envelope's own header in `events.ts`. `occurred_at` is left to the column's
 * `DEFAULT CURRENT_TIMESTAMP(3)` rather than set explicitly, the same way
 * `insertJournal` never sets a timestamp column by hand.
 */
export async function emitEvent(input: OpenBooksEventInput, ctx: RequestContext): Promise<void> {
  const orgId = orgScope(ctx.orgId);
  const db = tenantDb(orgId);

  const position = await allocateEventPosition(db, orgId);

  await db
    .insertInto('event_log')
    .values({
      id: newUuidBuffer(),
      position,
      name: input.name,
      actor_type: input.actor.actorType,
      actor_id: input.actor.actorId,
      invocation_mode: input.actor.invocationMode ?? null,
      payload: JSON.stringify(input.payload, serializeEventValue),
    })
    .execute();
}

/**
 * A `MinorUnits` payload field is a `bigint` (money is minor units end to end, spec
 * §12), and `JSON.stringify` throws on a `bigint` rather than guess an encoding. A
 * bigint's decimal digits are exactly the cents-only string the wire already carries
 * money as (`"150000"`, never a decimal or a JSON number, D-13), so the event body
 * stores the same form a consumer reads off the change feed — no float, no loss.
 */
function serializeEventValue(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
