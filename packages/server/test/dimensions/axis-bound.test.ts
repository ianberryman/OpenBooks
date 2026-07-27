import { MAX_DIMENSIONS_PER_ORG } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer } from '../../src/db';
import { PreconditionFailedError } from '../../src/errors';
import {
  archiveDimension,
  createDimension,
  deleteDimension,
  listDimensions,
} from '../../src/modules/dimensions';
import type { ActorFixture } from './support';
import { actorIn, CONTENTION_WAIT_MS, deferred, delay, useServiceDatabase, watch } from './support';

/**
 * The axis bound (OB-037; ROADMAP D-18).
 *
 * D-18 left this number to the service and said it had to be chosen and written
 * down rather than found in production, because the schema cannot express it —
 * MySQL has no per-partition row cap and a `CHECK` cannot count rows in another
 * table. These are the assertions that make it a bound rather than a comment: it
 * refuses the axis over the line, it counts archived axes, deletion frees a slot,
 * and it holds against a concurrent writer.
 */
const db = useServiceDatabase();

/** Fills the org to `count` axes, named so the codes sort predictably. */
async function fillTo(count: number, actor: ActorFixture): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await createDimension({ code: `AX${String(index)}`, name: `Axis ${String(index)}` }, actor.ctx);
  }
}

describe('the number of axes an org may define', () => {
  it('admits exactly MAX_DIMENSIONS_PER_ORG and refuses the next', async () => {
    const actor = await actorIn(db);
    await fillTo(MAX_DIMENSIONS_PER_ORG, actor);

    expect((await listDimensions({ limit: 200 }, actor.ctx)).items).toHaveLength(
      MAX_DIMENSIONS_PER_ORG,
    );

    const refused = createDimension({ code: 'ONE_TOO_MANY', name: 'Overflow' }, actor.ctx);
    await expect(refused).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(refused).rejects.toMatchObject({
      details: { precondition: 'dimension_limit_reached' },
    });
  });

  /**
   * The bound is on rows and not on active rows, which is a decision and not an
   * oversight: an archived axis whose values journal lines carry is still a join in
   * every historical sliced report. The escape hatch is deletion, which an axis
   * nothing carries permits — asserted here in the same test so the pair cannot
   * drift into "archived axes are free".
   */
  it('counts archived axes, and a deletion frees the slot', async () => {
    const actor = await actorIn(db);
    await fillTo(MAX_DIMENSIONS_PER_ORG, actor);

    const [first] = (await listDimensions({ limit: 200 }, actor.ctx)).items;
    if (first === undefined) throw new Error('the org should hold the axes just created');

    await archiveDimension(first.id, actor.ctx);
    await expect(createDimension({ code: 'NEXT', name: 'Next' }, actor.ctx)).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );

    await deleteDimension(first.id, actor.ctx);
    expect((await createDimension({ code: 'NEXT', name: 'Next' }, actor.ctx)).code).toBe('NEXT');
  });

  it('scopes the bound to one org', async () => {
    const mine = await actorIn(db);
    const theirs = await actorIn(db);

    await fillTo(MAX_DIMENSIONS_PER_ORG, mine);

    expect((await createDimension({ code: 'AX0', name: 'Axis 0' }, theirs.ctx)).code).toBe('AX0');
  });

  /**
   * The bound against a concurrent writer, proved rather than assumed.
   *
   * A sequential simulation of this race passes against a service that takes no
   * lock at all, so one side is *parked*: a second connection inserts the axis that
   * fills the org and holds its transaction open. `createDimension` counts under
   * `FOR UPDATE`, so its count has to wait for that row — which is the whole
   * mechanism, and the assertion is that it has not settled while the other
   * transaction is open. A service reading the count without a lock would settle
   * immediately, count one fewer, and admit a ninth axis.
   *
   * The parked side inserts on the org's *existing* rows' index range, which
   * matters: InnoDB's gap locks do not conflict with each other, so it is the
   * record locks over the seven axes already there that serialize the two counts.
   * At the bound there are always such rows, which is why the check is exact
   * exactly where it needs to be.
   */
  it('does not admit an extra axis to a create that raced an insert', async () => {
    const actor = await actorIn(db);
    await fillTo(MAX_DIMENSIONS_PER_ORG - 1, actor);

    const connection = await db.openAppConnection();
    const release = deferred<void>();

    try {
      const parked = deferred<void>();
      const holder = connection.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('dimensions')
          .values({
            id: newUuidBuffer(),
            org_id: actor.orgId,
            code: 'PARKED',
            name: 'Inserted by the other transaction',
          })
          .execute();
        parked.resolve();
        await release.promise;
      });
      await parked.promise;

      const racing = watch(createDimension({ code: 'RACER', name: 'Racing' }, actor.ctx));
      await delay(CONTENTION_WAIT_MS);

      // The claim: the count is waiting on the parked row rather than having read
      // around it.
      expect(racing.hasSettled()).toBe(false);

      release.resolve();
      await holder;

      await expect(racing.promise).rejects.toMatchObject({
        details: { precondition: 'dimension_limit_reached' },
      });
      expect((await listDimensions({ limit: 200 }, actor.ctx)).items).toHaveLength(
        MAX_DIMENSIONS_PER_ORG,
      );
    } finally {
      release.resolve();
      await connection.close();
    }
  });
});
