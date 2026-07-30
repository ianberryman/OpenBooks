import { describe, expect, it } from 'vitest';

import { createRequestContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { bufferToUuid, systemDb, uuidToBuffer } from '../../src/db';
import { postOnePeriod } from '../../src/modules/fixed-assets/depreciation-sweep';
import {
  disposeFixedAsset,
  getFixedAssetSchedule,
  registerFixedAsset,
} from '../../src/modules/fixed-assets';
import type { DueScheduleRow } from '../../src/modules/fixed-assets/fixed-assets.repository';
import { selectDueScheduleRows } from '../../src/modules/fixed-assets/fixed-assets.repository';
import { SYSTEM_ROLE_UUIDS } from '../db';
import { sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

/**
 * `postOnePeriod` end to end (OB-165, OB-168; ROADMAP D-113, L3), the fixed-asset
 * sibling of `test/recurring-journals/materialize-cycle.test.ts` — read that file's
 * own header first. `postOnePeriod` is exercised directly rather than through
 * `runDepreciationSweep`/`runAsAutomation` for the same reason: the daily tick and
 * the automation-context seam are OB-127's, and this suite's job is one period's
 * posting, not the sweep that dispatches it.
 *
 * The concurrent version — two invocations racing the same schedule row — is
 * `depreciation-sweep.race.test.ts`; this file proves the guard's *effect*
 * sequentially (one journal, `posted_journal_id` set once) and covers disposal
 * (OB-166, D-116), which has no concurrency claim of its own.
 */
const db = useServiceDatabase();

function automationContextFor(scene: Scene, actorId: string): RequestContext {
  return createRequestContext({
    orgId: scene.orgUuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: scene.userUuid,
    actorType: 'automation',
    actorId,
  });
}

async function dueRowFor(fixedAssetUuid: string, runDate: string): Promise<DueScheduleRow> {
  const due = await selectDueScheduleRows(systemDb(), runDate);
  const row = due.find((candidate) => bufferToUuid(candidate.fixedAssetId) === fixedAssetUuid);
  if (row === undefined) {
    throw new Error(`Expected ${fixedAssetUuid} to have a period due on or before ${runDate}.`);
  }
  return row;
}

async function journalCountBySource(scene: Scene, source: string): Promise<number> {
  const row = await db.app
    .selectFrom('journals')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', scene.orgId)
    .where('source', '=', source)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe('postOnePeriod', () => {
  it('posts once per period and marks the schedule row posted exactly once', async () => {
    const scene = await sceneIn(db);
    const [assetAccount, accumulatedDepreciationAccount] = await Promise.all([
      db.factories.account({
        orgId: scene.orgId,
        code: '1800',
        type: 'asset',
        normalBalance: 'debit',
      }),
      db.factories.account({
        orgId: scene.orgId,
        code: '1810',
        type: 'asset',
        normalBalance: 'credit',
      }),
    ]);

    const asset = await withContext(scene.ctx, () =>
      registerFixedAsset(
        {
          name: 'Delivery van',
          assetAccountId: assetAccount.uuid,
          accumulatedDepreciationAccountId: accumulatedDepreciationAccount.uuid,
          depreciationExpenseAccountId: scene.expense.uuid,
          acquisitionCostMinor: '120000',
          salvageValueMinor: '0',
          method: 'straight_line',
          usefulLifeMonths: 2,
          decliningRatePpm: null,
          inServiceDate: scene.date,
        },
        scene.ctx,
      ),
    );

    const automationCtx = automationContextFor(scene, asset.id);
    // Only period 0 (dated `scene.date`) is due on `scene.date`; period 1 is a month
    // later and stays due for its own tick — `postOnePeriod`'s own reason `runDate`
    // never appears in its body.
    const dueRow = await dueRowFor(asset.id, scene.date);

    expect(await journalCountBySource(scene, 'depreciation')).toBe(0);

    await withContext(automationCtx, () => postOnePeriod(dueRow, automationCtx));
    expect(await journalCountBySource(scene, 'depreciation')).toBe(1);

    const schedule = await withContext(scene.ctx, () => getFixedAssetSchedule(asset.id, scene.ctx));
    expect(schedule[0]?.postedJournalId).not.toBeNull();
    expect(schedule[1]?.postedJournalId).toBeNull();

    // A second invocation against the same stale row — a crashed worker retrying,
    // or a re-enqueue — must not post a second journal for a period already done.
    await withContext(automationCtx, () => postOnePeriod(dueRow, automationCtx));
    expect(await journalCountBySource(scene, 'depreciation')).toBe(1);

    const schedulePostSecondRun = await withContext(scene.ctx, () =>
      getFixedAssetSchedule(asset.id, scene.ctx),
    );
    expect(schedulePostSecondRun[0]?.postedJournalId).toBe(schedule[0]?.postedJournalId);
  });
});

describe('disposeFixedAsset', () => {
  it('posts a balanced disposal journal, recognises the gain, and stops the schedule', async () => {
    const scene = await sceneIn(db);
    const [assetAccount, accumulatedDepreciationAccount, proceedsAccount, gainLossAccount] =
      await Promise.all([
        db.factories.account({
          orgId: scene.orgId,
          code: '1800',
          type: 'asset',
          normalBalance: 'debit',
        }),
        db.factories.account({
          orgId: scene.orgId,
          code: '1810',
          type: 'asset',
          normalBalance: 'credit',
        }),
        db.factories.account({
          orgId: scene.orgId,
          code: '1820',
          type: 'asset',
          normalBalance: 'debit',
        }),
        db.factories.account({
          orgId: scene.orgId,
          code: '4900',
          type: 'revenue',
          normalBalance: 'credit',
        }),
      ]);

    const asset = await withContext(scene.ctx, () =>
      registerFixedAsset(
        {
          name: 'Delivery van',
          assetAccountId: assetAccount.uuid,
          accumulatedDepreciationAccountId: accumulatedDepreciationAccount.uuid,
          depreciationExpenseAccountId: scene.expense.uuid,
          acquisitionCostMinor: '100000',
          salvageValueMinor: '0',
          method: 'straight_line',
          usefulLifeMonths: 2,
          decliningRatePpm: null,
          inServiceDate: scene.date,
        },
        scene.ctx,
      ),
    );

    // Post period 0 (50000) so disposal has real accumulated depreciation to net
    // against — the interesting case, not an asset disposed the day it is bought.
    const automationCtx = automationContextFor(scene, asset.id);
    const dueRow = await dueRowFor(asset.id, scene.date);
    await withContext(automationCtx, () => postOnePeriod(dueRow, automationCtx));

    // cost 100000, accumulated 50000 ⇒ net book value 50000; proceeds 70000 ⇒ a
    // 20000 gain. Lines: Cr asset 100000; Dr accumulated 50000; Dr proceeds 70000;
    // Cr gain 20000 — debits 120000, credits 120000 (`disposeFixedAsset`'s own
    // four-line algebra, `fixed-assets.service.ts`'s header).
    const disposed = await withContext(scene.ctx, () =>
      disposeFixedAsset(
        asset.id,
        {
          date: scene.date,
          proceedsMinor: '70000',
          proceedsAccountId: proceedsAccount.uuid,
          gainLossAccountId: gainLossAccount.uuid,
        },
        scene.ctx,
      ),
    );

    expect(disposed.status).toBe('disposed');
    expect(disposed.disposedDate).toBe(scene.date);
    if (disposed.disposalJournalId === null) {
      throw new Error('Expected the disposal to have posted a journal.');
    }

    const journalId = uuidToBuffer(disposed.disposalJournalId);
    const lines = await db.app
      .selectFrom('journal_lines')
      .select(['account_id', 'debit_minor', 'credit_minor'])
      .where('journal_id', '=', journalId)
      .execute();

    const totals = lines.reduce(
      (acc, line) => ({
        debit: acc.debit + line.debit_minor,
        credit: acc.credit + line.credit_minor,
      }),
      { debit: 0n, credit: 0n },
    );
    expect(totals.debit).toBe(120_000n);
    expect(totals.credit).toBe(120_000n);
    expect(totals.debit).toBe(totals.credit);

    const gainLossLine = lines.find((line) => line.account_id.equals(gainLossAccount.id));
    expect(gainLossLine).toMatchObject({ debit_minor: 0n, credit_minor: 20_000n });

    // The remaining unposted period (period 1) is discarded; the posted one stays,
    // as the permanent record of what actually happened before disposal.
    const scheduleAfterDisposal = await withContext(scene.ctx, () =>
      getFixedAssetSchedule(asset.id, scene.ctx),
    );
    expect(scheduleAfterDisposal).toHaveLength(1);
    expect(scheduleAfterDisposal[0]?.postedJournalId).not.toBeNull();
  });
});
