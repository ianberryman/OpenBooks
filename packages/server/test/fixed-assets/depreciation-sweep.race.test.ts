import { describe, expect, it } from 'vitest';

import { createRequestContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { bufferToUuid, systemDb } from '../../src/db';
import { postOnePeriod } from '../../src/modules/fixed-assets/depreciation-sweep';
import { registerFixedAsset } from '../../src/modules/fixed-assets';
import type { DueScheduleRow } from '../../src/modules/fixed-assets/fixed-assets.repository';
import { selectDueScheduleRows } from '../../src/modules/fixed-assets/fixed-assets.repository';
import { SYSTEM_ROLE_UUIDS, useTestDatabase } from '../db';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  contextFor,
  delay,
  parkedTransactionOn,
  transactionOn,
} from '../payments/support';

/**
 * D-113's once-per-period guard, proved as a real race (CLAUDE.md: "prove
 * contention, don't assume it") — the fixed-asset sibling of
 * `test/recurring-journals/materialize-cycle.race.test.ts`; read that file's
 * header first, the shape is identical one layer down.
 *
 * `selectScheduleRowByIdForUpdate` (`depreciation-sweep.ts`) takes the schedule
 * row's exclusive lock before checking `posted_journal_id`, so two invocations
 * racing the same due period — a crashed worker retried, a re-enqueue arriving
 * before the first tick committed — serialize on that row rather than both
 * reading `posted_journal_id IS NULL` and both posting. A sequential "call it
 * twice" cannot exercise this: the second call always sees the first one's
 * committed row, and the mutation this proves against (drop the lock, keep the
 * comparison) would still pass every sequential assertion.
 *
 * `useTestDatabase()` alone, not `useServiceDatabase()` — `materialize-cycle.race
 * .test.ts`'s own reasoning: with no process pool, a query that escapes the
 * ambient transaction throws rather than quietly running on a third connection.
 */
const db = useTestDatabase();

function automationContextFor(orgUuid: string, userUuid: string, actorId: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: userUuid,
    actorType: 'automation',
    actorId,
  });
}

describe('two concurrent postings of the same depreciation period (D-113, L3)', () => {
  it('serialize on the schedule row and post exactly one journal', async () => {
    const org = await db.factories.org();
    const user = await db.factories.user();
    await db.factories.orgMember({ orgId: org.id, userId: user.id });
    const period = await db.factories.fiscalPeriod({ orgId: org.id });
    const [assetAccount, accumulatedDepreciationAccount, depreciationExpenseAccount] =
      await Promise.all([
        db.factories.account({
          orgId: org.id,
          code: '1800',
          type: 'asset',
          normalBalance: 'debit',
        }),
        db.factories.account({
          orgId: org.id,
          code: '1810',
          type: 'asset',
          normalBalance: 'credit',
        }),
        db.factories.account({
          orgId: org.id,
          code: '6900',
          type: 'expense',
          normalBalance: 'debit',
        }),
      ]);

    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);
    const date = period.startDate;

    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const asset = await transactionOn(first, ctx, () =>
        registerFixedAsset(
          {
            name: 'Delivery van',
            assetAccountId: assetAccount.uuid,
            accumulatedDepreciationAccountId: accumulatedDepreciationAccount.uuid,
            depreciationExpenseAccountId: depreciationExpenseAccount.uuid,
            acquisitionCostMinor: '120000',
            salvageValueMinor: '0',
            method: 'straight_line',
            usefulLifeMonths: 2,
            decliningRatePpm: null,
            inServiceDate: date,
          },
          ctx,
        ),
      ).promise;

      const due: readonly DueScheduleRow[] = await transactionOn(first, ctx, () =>
        selectDueScheduleRows(systemDb(), date),
      ).promise;
      const dueRow = due.find((row) => bufferToUuid(row.fixedAssetId) === asset.id);
      if (dueRow === undefined) throw new Error('Expected the asset to have a period due.');

      const automationCtx = automationContextFor(org.uuid, user.uuid, asset.id);

      // The winner has posted the period's journal and marked the row posted,
      // uncommitted, and holds the schedule row's lock.
      const winner = parkedTransactionOn(first, automationCtx, () =>
        postOnePeriod(dueRow, automationCtx),
      );
      await winner.parked;

      const loser = transactionOn(second, automationCtx, () =>
        postOnePeriod(dueRow, automationCtx),
      );
      await delay(CONTENTION_WAIT_MS);

      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;
      // Unblocked, the loser's locking read now sees `posted_journal_id` already
      // set and returns without posting a second journal for this period.
      await loser.promise;

      const journalCount = await db.app
        .selectFrom('journals')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('org_id', '=', org.id)
        .where('source', '=', 'depreciation')
        .executeTakeFirstOrThrow();
      expect(Number(journalCount.count)).toBe(1);

      const scheduleRow = await db.app
        .selectFrom('fixed_asset_schedule')
        .select(['posted_journal_id'])
        .where('id', '=', dueRow.id)
        .executeTakeFirstOrThrow();
      expect(scheduleRow.posted_journal_id).not.toBeNull();
    } finally {
      await first.close();
      await second.close();
    }
  });
});
