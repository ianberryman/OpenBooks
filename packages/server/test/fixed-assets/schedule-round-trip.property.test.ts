import type { FixedAssetMethod } from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getFixedAssetSchedule, registerFixedAsset } from '../../src/modules/fixed-assets';
import { sceneIn, useServiceDatabase, withContext } from '../payments/support';

/**
 * L6, against real MySQL rather than the pure function (OB-168; ROADMAP D-113…D-117).
 *
 * `depreciation.test.ts` already proves `computeDepreciationSchedule` sums to
 * `acquisitionCostMinor − salvageValueMinor` exactly, in memory. What that suite
 * cannot see is the round trip this one exercises: `registerFixedAsset` converts
 * the wire's cents-only strings to `bigint`, writes one row per period through
 * `insertScheduleRows`, and `getFixedAssetSchedule` reads them back out as strings
 * again (`fixed_asset_schedule.depreciation_amount_minor` is itself a `bigint`
 * column). A mistake anywhere in that path — a truncating cast, a column reordered
 * against `SCHEDULE_COLUMNS`, a `BigInt(row.total)` that silently returned `0`
 * for a `null` — would still make the pure function's own test pass while
 * breaking every asset a caller actually registers, which is why this is a
 * second, DB-backed instance of the same property rather than a duplicate of it.
 *
 * `costAndSalvageArb` is `depreciation.test.ts`'s own construction, restated
 * here rather than imported — the pure suite's arbitraries are that file's
 * private fixtures, and this suite's job is the database seam, not the
 * arithmetic `computeDepreciationSchedule` itself already owns.
 */

const db = useServiceDatabase();

interface CostAndSalvage {
  readonly cost: bigint;
  readonly salvage: bigint;
}

/** `salvage < cost`, both non-negative — `chk_fixed_assets_salvage`'s own bound. */
const costAndSalvageArb: fc.Arbitrary<CostAndSalvage> = fc
  .tuple(fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 0, max: 1_000_000 }))
  .map(([costUnits, salvageFraction]) => {
    const cost = BigInt(costUnits);
    // Scaled down from `cost` by a fraction in [0, 1) so salvage stays strictly
    // below cost across the whole generated range, `depreciation.test.ts`'s own
    // reason for avoiding a rejection filter here.
    const salvage = (cost * BigInt(salvageFraction)) / 1_000_001n;
    return { cost, salvage };
  });

/** Capped well below `computeDepreciationSchedule`'s own 360-month ceiling: each
 * generated life is a real round trip through the database, not an in-memory call. */
const usefulLifeMonthsArb = fc.integer({ min: 1, max: 24 });
const decliningRatePpmArb = fc.integer({ min: 1, max: 1_000_000 });

const inServiceDateArb = fc
  .record({
    year: fc.integer({ min: 2020, max: 2029 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ year, month, day }) => {
    const y = String(year).padStart(4, '0');
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });

interface AssetScenario {
  readonly costAndSalvage: CostAndSalvage;
  readonly usefulLifeMonths: number;
  readonly inServiceDate: string;
  readonly method: FixedAssetMethod;
  readonly decliningRatePpm: number | null;
}

const straightLineArb: fc.Arbitrary<AssetScenario> = fc
  .record({
    costAndSalvage: costAndSalvageArb,
    usefulLifeMonths: usefulLifeMonthsArb,
    inServiceDate: inServiceDateArb,
  })
  .map((value) => ({ ...value, method: 'straight_line' as const, decliningRatePpm: null }));

const decliningBalanceArb: fc.Arbitrary<AssetScenario> = fc
  .record({
    costAndSalvage: costAndSalvageArb,
    usefulLifeMonths: usefulLifeMonthsArb,
    decliningRatePpm: decliningRatePpmArb,
    inServiceDate: inServiceDateArb,
  })
  .map((value) => ({ ...value, method: 'declining_balance' as const }));

/** Both methods, so the property holds across D-114's whole surface, not just one. */
const assetScenarioArb: fc.Arbitrary<AssetScenario> = fc.oneof(
  straightLineArb,
  decliningBalanceArb,
);

describe('L6 — a registered asset’s schedule round-trips through the database', () => {
  it(
    'sums to acquisitionCostMinor − salvageValueMinor, every amount is non-negative, ' +
      'and there are exactly usefulLifeMonths rows',
    async () => {
      await fc.assert(
        fc.asyncProperty(assetScenarioArb, async (scenario) => {
          // A fresh org per run rather than one shared scene: `fixed_assets` and its
          // schedule are org-scoped, and creating a new one keeps each generated case
          // independent of what an earlier (possibly shrinking) run left behind.
          const scene = await sceneIn(db);
          const [assetAccount, accumulatedDepreciationAccount] = await Promise.all([
            db.factories.account({
              orgId: scene.orgId,
              code: '1800',
              type: 'asset',
              normalBalance: 'debit',
            }),
            // Accumulated depreciation is a contra-asset — an asset account with a
            // credit normal balance (`fixed-assets.service.ts`'s own D-115 note) —
            // but `assertAccountUsable` only checks `type`, so this is chosen to
            // read like the real chart of accounts rather than because the service
            // demands it. A distinct code from the asset account above, since both
            // land in the same fresh org and share `uq_accounts_org_code`.
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
                name: 'Property test asset',
                assetAccountId: assetAccount.uuid,
                accumulatedDepreciationAccountId: accumulatedDepreciationAccount.uuid,
                depreciationExpenseAccountId: scene.expense.uuid,
                acquisitionCostMinor: scenario.costAndSalvage.cost.toString(),
                salvageValueMinor: scenario.costAndSalvage.salvage.toString(),
                method: scenario.method,
                usefulLifeMonths: scenario.usefulLifeMonths,
                decliningRatePpm: scenario.decliningRatePpm,
                inServiceDate: scenario.inServiceDate,
              },
              scene.ctx,
            ),
          );

          const schedule = await withContext(scene.ctx, () =>
            getFixedAssetSchedule(asset.id, scene.ctx),
          );

          expect(schedule).toHaveLength(scenario.usefulLifeMonths);

          let sum = 0n;
          for (const row of schedule) {
            const amount = BigInt(row.depreciationAmountMinor);
            expect(amount >= 0n).toBe(true);
            // Nothing has posted — registration only computes the schedule.
            expect(row.postedJournalId).toBeNull();
            sum += amount;
          }

          expect(sum).toBe(scenario.costAndSalvage.cost - scenario.costAndSalvage.salvage);
        }),
        { numRuns: 15 },
      );
    },
    120_000,
  );
});
