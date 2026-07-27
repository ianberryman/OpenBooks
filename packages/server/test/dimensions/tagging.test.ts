import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { newUuidBuffer } from '../../src/db';
import {
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
} from '../../src/errors';
import {
  archiveDimension,
  archiveDimensionValue,
  createDimension,
  createDimensionValue,
  deleteDimensionValue,
  getJournalLineDimensions,
  setJournalLineDimensions,
} from '../../src/modules/dimensions';
import { getTrialBalance, postJournal } from '../../src/modules/ledger';
import { SYSTEM_ROLE_UUIDS, systemRoleId, uuidToBuffer } from '../db';
import { contextFor, useServiceDatabase, withContext } from './support';

/**
 * Retagging a posted journal line, against a real ledger (spec §11).
 *
 * Every line tagged here comes from `postJournal` rather than from a factory, and
 * that is deliberate: the claim this suite has to support is that a tag can be
 * changed on a line the ledger actually holds — the table the app user may not
 * `UPDATE` — so a fixture-written line would prove the easy half. The in-use
 * restrictions are asserted against those same lines, which is the only way to
 * know that `fk_jld_value`'s `RESTRICT` is reached rather than assumed.
 */
const db = useServiceDatabase();

interface Scene {
  readonly ctx: RequestContext;
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userId: Buffer;
  readonly lineId: string;
  readonly otherLineId: string;
  readonly department: string;
  readonly sales: string;
  readonly operations: string;
  readonly project: string;
  readonly alpha: string;
}

async function scene(): Promise<Scene> {
  const ledger = await db.factories.ledger();
  const ctx = contextFor(ledger.org.uuid, SYSTEM_ROLE_UUIDS.owner, ledger.user.uuid);

  const department = await createDimension({ code: 'DEPT', name: 'Department' }, ctx);
  const sales = await createDimensionValue(department.id, { code: 'SALES', name: 'Sales' }, ctx);
  const operations = await createDimensionValue(department.id, { code: 'OPS', name: 'Ops' }, ctx);
  const project = await createDimension({ code: 'PROJ', name: 'Project' }, ctx);
  const alpha = await createDimensionValue(project.id, { code: 'ALPHA', name: 'Alpha' }, ctx);

  const posted = await withContext(ctx, () =>
    postJournal(
      {
        date: ledger.period.startDate,
        memo: 'Rent',
        actorType: 'user',
        actorId: ledger.user.uuid,
        lines: [
          { accountId: ledger.debitAccount.uuid, side: 'debit', amount: 150000n },
          { accountId: ledger.creditAccount.uuid, side: 'credit', amount: 150000n },
        ],
      },
      ctx,
    ),
  );

  const [first, second] = posted.lines;
  if (first === undefined || second === undefined) {
    throw new Error('a balanced journal should have posted two lines');
  }

  return {
    ctx,
    orgUuid: ledger.org.uuid,
    orgId: ledger.org.id,
    userId: ledger.user.id,
    lineId: first.lineId,
    otherLineId: second.lineId,
    department: department.id,
    sales: sales.id,
    operations: operations.id,
    project: project.id,
    alpha: alpha.id,
  };
}

let s: Scene;
beforeEach(async () => {
  s = await scene();
});

describe('tagging a posted journal line', () => {
  it('applies a set, moves a value within an axis, and clears by omission', async () => {
    const applied = await setJournalLineDimensions(
      s.lineId,
      { valueIds: [s.sales, s.alpha] },
      s.ctx,
    );

    expect(applied).toHaveLength(2);
    expect(applied).toContainEqual({
      lineId: s.lineId,
      dimensionId: s.department,
      dimensionValueId: s.sales,
    });

    // Same axis, different value: a move, not a second tag — the primary key
    // `(org_id, journal_line_id, dimension_id)` is what makes B6 true.
    const moved = await setJournalLineDimensions(
      s.lineId,
      { valueIds: [s.operations, s.alpha] },
      s.ctx,
    );
    expect(moved).toHaveLength(2);
    expect(moved.map((tag) => tag.dimensionValueId).sort()).toEqual([s.operations, s.alpha].sort());

    // An axis absent from the set is untagged.
    const narrowed = await setJournalLineDimensions(s.lineId, { valueIds: [s.alpha] }, s.ctx);
    expect(narrowed).toEqual([
      { lineId: s.lineId, dimensionId: s.project, dimensionValueId: s.alpha },
    ]);

    expect(await setJournalLineDimensions(s.lineId, { valueIds: [] }, s.ctx)).toEqual([]);
    expect(await getJournalLineDimensions(s.lineId, s.ctx)).toEqual([]);
  });

  it('is a no-op on a resend, and tags lines independently', async () => {
    await setJournalLineDimensions(s.lineId, { valueIds: [s.sales] }, s.ctx);
    const again = await setJournalLineDimensions(s.lineId, { valueIds: [s.sales] }, s.ctx);

    expect(again).toHaveLength(1);
    expect(await getJournalLineDimensions(s.otherLineId, s.ctx)).toEqual([]);
  });

  it('refuses two values on one axis rather than keeping one of them', async () => {
    const refused = setJournalLineDimensions(
      s.lineId,
      { valueIds: [s.sales, s.operations] },
      s.ctx,
    );

    await expect(refused).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(refused).rejects.toMatchObject({
      details: { precondition: 'dimension_axis_conflict' },
    });
    expect(await getJournalLineDimensions(s.lineId, s.ctx)).toEqual([]);
  });

  /**
   * The asymmetry archiving is *for*: it stops a value being chosen anew and
   * leaves every line already carrying it alone. Because this operation states the
   * whole set, resending an archived tag has to be permitted — otherwise a line
   * carrying one archived value could never be tagged on any other axis again.
   */
  it('refuses an archived value as a new tag and accepts it as a kept one', async () => {
    await setJournalLineDimensions(s.lineId, { valueIds: [s.sales] }, s.ctx);
    await archiveDimensionValue(s.sales, s.ctx);

    const refused = setJournalLineDimensions(s.otherLineId, { valueIds: [s.sales] }, s.ctx);
    await expect(refused).rejects.toMatchObject({
      details: { precondition: 'dimension_value_archived' },
    });

    // The line that already carries it keeps it, and can still gain another axis.
    const kept = await setJournalLineDimensions(s.lineId, { valueIds: [s.sales, s.alpha] }, s.ctx);
    expect(kept).toHaveLength(2);
  });

  it('refuses a new tag on an archived axis', async () => {
    await archiveDimension(s.project, s.ctx);

    await expect(
      setJournalLineDimensions(s.lineId, { valueIds: [s.alpha] }, s.ctx),
    ).rejects.toMatchObject({ details: { precondition: 'dimension_archived' } });
  });

  /**
   * The property D-18 names and OB-053 will assert over reports: tagging never
   * moves money. Asserted against a real trial balance rather than by reading the
   * code, because the whole reason retagging is permitted is that it cannot change
   * a figure — if it ever could, this is where it would show.
   */
  it('changes no amount', async () => {
    const before = await getTrialBalance({}, s.ctx);

    await setJournalLineDimensions(s.lineId, { valueIds: [s.sales, s.alpha] }, s.ctx);
    await setJournalLineDimensions(s.lineId, { valueIds: [s.operations] }, s.ctx);
    await setJournalLineDimensions(s.otherLineId, { valueIds: [s.alpha] }, s.ctx);

    expect(await getTrialBalance({}, s.ctx)).toEqual(before);
  });

  it('answers an unknown, malformed, or cross-org line identically (A7)', async () => {
    const other = await db.factories.org();
    const user = await db.factories.user();
    await db.factories.orgMember({ orgId: other.id, userId: user.id, roleId: systemRoleId() });
    const outsider = contextFor(other.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);

    const answerFor = async (lineId: string, ctx: RequestContext): Promise<unknown> =>
      toWireError(await getJournalLineDimensions(lineId, ctx).catch((error: unknown) => error));

    const crossOrg = await answerFor(s.lineId, outsider);
    const unknown = await answerFor('999999999', s.ctx);
    const malformed = await answerFor('not-a-line', s.ctx);

    expect(JSON.stringify(crossOrg)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(malformed)).toBe(JSON.stringify(unknown));
    await expect(
      setJournalLineDimensions(s.lineId, { valueIds: [] }, outsider),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a caller holding dimensions.read only', async () => {
    const user = await db.factories.user();
    await db.factories.orgMember({
      orgId: s.orgId,
      userId: user.id,
      roleId: systemRoleId('readOnly'),
    });
    const reader = contextFor(s.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, user.uuid);

    await expect(
      setJournalLineDimensions(s.lineId, { valueIds: [s.sales] }, reader),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('deleting a value a line carries', () => {
  it('is refused while a journal line carries it and permitted once it does not', async () => {
    await setJournalLineDimensions(s.lineId, { valueIds: [s.sales] }, s.ctx);

    const refused = deleteDimensionValue(s.sales, s.ctx);
    await expect(refused).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(refused).rejects.toMatchObject({
      details: { precondition: 'dimension_value_in_use' },
    });

    // Archiving is the sanctioned removal, and it leaves the tag in place.
    expect((await archiveDimensionValue(s.sales, s.ctx)).isActive).toBe(false);
    expect(await getJournalLineDimensions(s.lineId, s.ctx)).toHaveLength(1);

    await setJournalLineDimensions(s.lineId, { valueIds: [] }, s.ctx);
    await deleteDimensionValue(s.sales, s.ctx);
  });

  /**
   * The other holder of a value, and the reason the pre-check asks twice: a draft
   * tag restricts the delete exactly as a posted one does (`fk_jdld_value`), and
   * the remedy is entirely different, because a draft is editable. A message
   * naming journal lines here would send someone hunting through the ledger for a
   * tag that is not in it.
   *
   * The draft is written directly rather than through a service because OB-038 owns
   * that surface; what is being asserted is this module's reading of the schema.
   */
  it('names the draft when a draft is the only thing carrying it', async () => {
    const draftId = newUuidBuffer();

    await db.app
      .insertInto('journal_drafts')
      .values({ id: draftId, org_id: s.orgId, created_by_user_id: s.userId })
      .execute();
    const line = await db.app
      .insertInto('journal_draft_lines')
      .values({
        org_id: s.orgId,
        draft_id: draftId,
        line_number: 1,
        debit_minor: 0n,
        credit_minor: 0n,
      })
      .executeTakeFirstOrThrow();
    const draftLineId = line.insertId;
    if (draftLineId === undefined) throw new Error('the draft line should have an id');

    await db.app
      .insertInto('journal_draft_line_dimensions')
      .values({
        org_id: s.orgId,
        draft_line_id: draftLineId,
        dimension_id: uuidToBuffer(s.department),
        dimension_value_id: uuidToBuffer(s.operations),
      })
      .execute();

    const refused = deleteDimensionValue(s.operations, s.ctx);
    await expect(refused).rejects.toMatchObject({
      details: { precondition: 'dimension_value_in_use' },
    });
    await expect(refused).rejects.toThrow(/draft/i);
  });
});
