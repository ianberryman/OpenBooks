import type {
  BudgetVsActual,
  BudgetVsActualGroup,
  BudgetVsActualRow,
  BudgetVsActualSection,
  SetBudgetEntry,
} from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { setBudgets } from '../../src/modules/budgets';
import { getBudgetVsActual } from '../../src/modules/reports';
import { SYSTEM_ROLE_UUIDS, uuidToBuffer, type TestDatabase } from '../db';
import type { Axis, Scene, SceneAccount } from '../reports/support';
import {
  contextFor,
  createAxis,
  createChart,
  PERIOD,
  post,
  useReportDatabase,
} from '../reports/support';

/**
 * Properties for the budget-vs-actual report (OB-182; ROADMAP D-N1…D-N6).
 *
 * `budget-vs-actual.service.ts` is a projection: the actuals side reuses
 * `getAccountBalances` (already proven by the OB-041 property suite) and the
 * budget side is one flat read of `budgets`, bucketed by hand
 * (`bucketBudgetRows`/`sectionOf`/`project`). Nothing here re-derives the
 * actuals from the ledger — that oracle already exists — so every property
 * below checks the arithmetic the projection itself is responsible for:
 * `variance = budget − actual` at every level the wire carries a triplet, and
 * (B6, restated for a budget) that a sliced report's per-account figures sum
 * back to the unsliced ones.
 *
 * Fixtures are built the way `test/reports/support.ts` argues fixtures should
 * be: real accounts through `createAccount` (`createChart`), real journals
 * through `postJournal` (`post`), real budgets through `setBudgets`. A scene
 * and its fiscal period are constructed locally rather than through
 * `createScene`, which creates a period of its own but never returns its id —
 * `getBudgetVsActual` needs `periodId`, so this file duplicates the shape
 * rather than reaching into a helper another ticket owns, `support.ts`'s own
 * stated reason for duplicating across suites.
 */

const harness = useReportDatabase();

/** Every posting lands on the same date, inside the one open period. */
const POSTING_DATE = '2026-06-15';

const RUNS = 30;
const SLICE_RUNS = 25;

// ---------------------------------------------------------------------------
// Scene / chart helpers
// ---------------------------------------------------------------------------

interface BudgetScene {
  readonly scene: Scene;
  readonly periodId: string;
}

/** An org with an owner and one open fiscal period, whose id the caller keeps. */
async function createBudgetScene(db: TestDatabase): Promise<BudgetScene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id });
  const period = await db.factories.fiscalPeriod({
    orgId: org.id,
    startDate: PERIOD.startDate,
    endDate: PERIOD.endDate,
  });

  return {
    scene: {
      ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid),
      orgUuid: org.uuid,
      orgId: org.id,
      userId: user.id,
    },
    periodId: period.uuid,
  };
}

function accountCode(prefix: string, index: number): string {
  return `${prefix}${String(index)}`;
}

/** One asset "bank" account plus one account per generated P&L type. */
async function createAccounts(
  scene: Scene,
  types: readonly ('revenue' | 'expense')[],
): Promise<{ bank: SceneAccount; accounts: readonly SceneAccount[] }> {
  const chart = await createChart(scene, [
    { code: 'BANK', type: 'asset', normalBalance: 'debit' },
    ...types.map((type, index) => ({
      code: accountCode('P', index),
      type,
      normalBalance: type === 'revenue' ? ('credit' as const) : ('debit' as const),
    })),
  ]);

  const bank = chart.get('BANK');
  if (bank === undefined) throw new Error('Chart is missing the bank account.');

  const accounts = types.map((_, index) => {
    const account = chart.get(accountCode('P', index));
    if (account === undefined) {
      throw new Error(`Chart is missing account ${accountCode('P', index)}.`);
    }
    return account;
  });

  return { bank, accounts };
}

/**
 * Flags `accountId` as a cash account for the direct-cash path of the
 * cash-basis transform (`cash-basis/repository.ts`'s `selectCashAccountIds`) —
 * `test/reports/cash-basis.test.ts`'s own `markCash`, restated here for the
 * same reason `support.ts` gives for its own duplicates.
 */
async function markCash(db: TestDatabase, accountId: string): Promise<void> {
  await db.app
    .updateTable('accounts')
    .set({ cash_basis_role: 'cash' })
    .where('id', '=', uuidToBuffer(accountId))
    .execute();
}

function oppositeSide(side: 'debit' | 'credit'): 'debit' | 'credit' {
  return side === 'debit' ? 'credit' : 'debit';
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Index ${String(index)} is out of bounds.`);
  return value;
}

// ---------------------------------------------------------------------------
// Property 1 & 2: variance arithmetic is exact, and variancePercent's sign
// agrees with the variance/budget it was computed from.
// ---------------------------------------------------------------------------

interface PostingPlan {
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
}

interface AccountPlan {
  readonly type: 'revenue' | 'expense';
  readonly budget: bigint;
  readonly postings: readonly PostingPlan[];
}

/**
 * Budgets may be negative — `budgetSchema`'s own note is "a contra account" —
 * so the arithmetic property is checked over the full signed range. Bounded
 * well inside the storable range; the point of this suite is the projection's
 * bucketing and summation, not another pass at `bigint` overflow (M1 already
 * owns that).
 */
const budgetAmountArb = fc.bigInt({ min: -5_000_000n, max: 5_000_000n });

/** `chk_journal_lines_one_sided` requires every posted line to be > 0. */
const postingAmountArb = fc.bigInt({ min: 1n, max: 1_000_000n });

const postingArb: fc.Arbitrary<PostingPlan> = fc.record({
  side: fc.constantFrom('debit', 'credit'),
  amount: postingAmountArb,
});

const accountPlanArb: fc.Arbitrary<AccountPlan> = fc.record({
  type: fc.constantFrom('revenue', 'expense'),
  budget: budgetAmountArb,
  postings: fc.array(postingArb, { minLength: 0, maxLength: 3 }),
});

/** 1–4 accounts, `report-arbitraries.ts`'s own reason for a small bound: a
 * failure should report the smallest ledger that still breaks the property. */
const scenarioArb = fc.array(accountPlanArb, { minLength: 1, maxLength: 4 });

interface MaterializedScenario {
  readonly scene: Scene;
  readonly periodId: string;
  readonly bank: SceneAccount;
  readonly accounts: readonly SceneAccount[];
}

/**
 * Builds one generated scenario into its own org: the chart, one account-total
 * budget entry per account (even a zero one, so the zero-budget branch of
 * `variancePercent` is exercised without a separate fixture), and every
 * posting against a shared "bank" account.
 */
async function materializeScenario(
  db: TestDatabase,
  plans: readonly AccountPlan[],
): Promise<MaterializedScenario> {
  const { scene, periodId } = await createBudgetScene(db);
  const { bank, accounts } = await createAccounts(
    scene,
    plans.map((plan) => plan.type),
  );

  const entries: SetBudgetEntry[] = accounts.map((account, index) => ({
    accountId: account.id,
    periodId,
    amount: at(plans, index).budget.toString(),
  }));
  await setBudgets({ entries }, scene.ctx);

  for (const [index, account] of accounts.entries()) {
    const plan = at(plans, index);
    for (const posting of plan.postings) {
      await post(scene, POSTING_DATE, [
        { accountId: account.id, side: posting.side, amount: posting.amount },
        { accountId: bank.id, side: oppositeSide(posting.side), amount: posting.amount },
      ]);
    }
  }

  return { scene, periodId, bank, accounts };
}

interface Triplet {
  readonly budget: bigint;
  readonly actual: bigint;
  readonly variance: bigint;
}

const ZERO_TRIPLET: Triplet = { budget: 0n, actual: 0n, variance: 0n };

function addTriplet(left: Triplet, right: Triplet): Triplet {
  return {
    budget: left.budget + right.budget,
    actual: left.actual + right.actual,
    variance: left.variance + right.variance,
  };
}

function expectTripletEquals(
  wire: { readonly budget: string; readonly actual: string; readonly variance: string },
  expected: Triplet,
): void {
  expect(BigInt(wire.budget)).toBe(expected.budget);
  expect(BigInt(wire.actual)).toBe(expected.actual);
  expect(BigInt(wire.variance)).toBe(expected.variance);
}

/**
 * `variancePercent = variance / budget × 100` (`budget-vs-actual.service.ts`),
 * so its sign is the sign of `variance` only when `budget` is positive — for a
 * negative budget the division flips it. That is the mathematically exact
 * statement of "agrees with the variance it was computed from"; asserting flat
 * "same sign as variance" would be a false property on the negative-budget
 * half of `budgetAmountArb`'s range, not a weaker version of a true one.
 *
 * `-0` is reachable (`variance === 0n` and `budget < 0n`: `0 / negative =
 * -0`), and `toBe` compares with `Object.is`, which does not consider `-0`
 * equal to `0` — so the zero case is asserted with `===` instead.
 */
function expectVariancePercentAgrees(
  row: BudgetVsActualRow,
  budget: bigint,
  variance: bigint,
): void {
  if (budget === 0n) {
    expect(row.variancePercent).toBeNull();
    return;
  }

  expect(row.variancePercent).not.toBeNull();
  const percent = row.variancePercent as number;

  if (variance === 0n) {
    expect(percent === 0).toBe(true);
    return;
  }

  const expectedPositive = variance > 0n === budget > 0n;
  if (expectedPositive) {
    expect(percent).toBeGreaterThan(0);
  } else {
    expect(percent).toBeLessThan(0);
  }
}

function expectSectionArithmetic(section: BudgetVsActualSection): Triplet {
  let total = ZERO_TRIPLET;

  for (const row of section.rows) {
    const budget = BigInt(row.budget);
    const actual = BigInt(row.actual);
    const variance = BigInt(row.variance);

    expect(variance).toBe(budget - actual);
    expectVariancePercentAgrees(row, budget, variance);

    total = addTriplet(total, { budget, actual, variance });
  }

  expectTripletEquals(
    { budget: section.budget, actual: section.actual, variance: section.variance },
    total,
  );

  return total;
}

/**
 * Properties 1 and 2 together: every row's variance is exact, every section's
 * totals are the sum of its rows, every group's `netIncome` is `revenue −
 * expenses`, the report's `totals` sum every group, and `variancePercent`
 * agrees with the `variance`/`budget` it was computed from. One report is
 * enough state to check all five — they are not independent scenarios, they
 * are five views of the arithmetic one `project()` call produced.
 */
function expectReportArithmeticIsExact(report: BudgetVsActual): void {
  let totalRevenue = ZERO_TRIPLET;
  let totalExpenses = ZERO_TRIPLET;

  for (const group of report.groups) {
    const revenue = expectSectionArithmetic(group.revenue);
    const expenses = expectSectionArithmetic(group.expenses);

    expectTripletEquals(group.netIncome, {
      budget: revenue.budget - expenses.budget,
      actual: revenue.actual - expenses.actual,
      variance: revenue.variance - expenses.variance,
    });

    totalRevenue = addTriplet(totalRevenue, revenue);
    totalExpenses = addTriplet(totalExpenses, expenses);
  }

  expectTripletEquals(report.totals.revenue, totalRevenue);
  expectTripletEquals(report.totals.expenses, totalExpenses);
  expectTripletEquals(report.totals.netIncome, {
    budget: totalRevenue.budget - totalExpenses.budget,
    actual: totalRevenue.actual - totalExpenses.actual,
    variance: totalRevenue.variance - totalExpenses.variance,
  });
}

describe('budget vs actual: variance arithmetic is exact', () => {
  it('on accrual basis', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (plans) => {
        const { scene, periodId } = await materializeScenario(harness, plans);

        const report = await getBudgetVsActual({ periodId, basis: 'accrual' }, scene.ctx);

        expectReportArithmeticIsExact(report);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);

  it('on cash basis, whole org, unsliced', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (plans) => {
        const { scene, periodId, bank } = await materializeScenario(harness, plans);
        await markCash(harness, bank.id);

        const report = await getBudgetVsActual({ periodId, basis: 'cash' }, scene.ctx);
        expectReportArithmeticIsExact(report);

        // Every posting here is a two-line journal against the now-marked
        // bank account with no other non-P&L leg — a "pure" direct-cash
        // journal (`cash-basis/repository.ts`), recognised in full on its
        // entry date. With no invoice/bill in play to partially recognise,
        // cash and accrual actuals — and therefore every figure the report
        // derives from them — must agree exactly, not merely each be
        // internally consistent.
        const accrual = await getBudgetVsActual({ periodId, basis: 'accrual' }, scene.ctx);
        expect(report.totals).toEqual(accrual.totals);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Property 3: slices plus unassigned equal the whole (B6 for budgets).
// ---------------------------------------------------------------------------

const AXIS_VALUES = 2;

interface SliceAccountPlan {
  readonly type: 'revenue' | 'expense';
  /** `null` omits the account-total (unassigned) budget entry entirely. */
  readonly unassignedBudget: bigint | null;
  /** One slot per axis value; `null` omits that slice's budget entry. */
  readonly sliceBudgets: readonly (bigint | null)[];
}

interface SlicePosting {
  readonly accountIndex: number;
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
  /** An index into the axis's values, or `null` for an untagged line. */
  readonly valueIndex: number | null;
}

interface SliceScenario {
  readonly accounts: readonly SliceAccountPlan[];
  readonly postings: readonly SlicePosting[];
}

const sliceBudgetSlotArb = fc.option(fc.bigInt({ min: -2_000_000n, max: 2_000_000n }), {
  nil: null,
});

const sliceAccountPlanArb: fc.Arbitrary<SliceAccountPlan> = fc.record({
  type: fc.constantFrom('revenue', 'expense'),
  unassignedBudget: sliceBudgetSlotArb,
  sliceBudgets: fc.array(sliceBudgetSlotArb, { minLength: AXIS_VALUES, maxLength: AXIS_VALUES }),
});

const sliceScenarioArb: fc.Arbitrary<SliceScenario> = fc
  .array(sliceAccountPlanArb, { minLength: 1, maxLength: 3 })
  .chain((accounts) =>
    fc
      .array(
        fc.record({
          accountIndex: fc.nat({ max: accounts.length - 1 }),
          side: fc.constantFrom('debit', 'credit'),
          amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
          valueIndex: fc.option(fc.nat({ max: AXIS_VALUES - 1 }), { nil: null }),
        }),
        { minLength: 0, maxLength: 6 },
      )
      .map((postings) => ({ accounts, postings })),
  );

interface MaterializedSlices {
  readonly scene: Scene;
  readonly periodId: string;
  readonly axis: Axis;
}

async function materializeSliceScenario(
  db: TestDatabase,
  plan: SliceScenario,
): Promise<MaterializedSlices> {
  const { scene, periodId } = await createBudgetScene(db);
  const axis = await createAxis(
    scene,
    'AXIS',
    Array.from({ length: AXIS_VALUES }, (_, index) => `V${String(index)}`),
  );
  const { bank, accounts } = await createAccounts(
    scene,
    plan.accounts.map((account) => account.type),
  );
  const axisValueIds = Array.from({ length: AXIS_VALUES }, (_, index) => {
    const id = axis.values.get(`V${String(index)}`);
    if (id === undefined) throw new Error(`Axis is missing value V${String(index)}.`);
    return id;
  });

  const entries: SetBudgetEntry[] = [];
  for (const [index, account] of accounts.entries()) {
    const accountPlan = at(plan.accounts, index);
    if (accountPlan.unassignedBudget !== null) {
      entries.push({
        accountId: account.id,
        periodId,
        amount: accountPlan.unassignedBudget.toString(),
      });
    }
    for (const [valueIndex, amount] of accountPlan.sliceBudgets.entries()) {
      if (amount === null) continue;
      entries.push({
        accountId: account.id,
        periodId,
        dimensionValueId: at(axisValueIds, valueIndex),
        amount: amount.toString(),
      });
    }
  }
  if (entries.length > 0) await setBudgets({ entries }, scene.ctx);

  // Post exactly the plan's actuals — no anchor postings. A per-slice budget on a
  // value with **no** ledger activity is deliberately exercised here: the service
  // synthesises a zero-actuals group for every value a budget names on the grouped
  // axis (`getBudgetVsActual`'s budget-only-key handling), so B6 must hold even when
  // a slice is budgeted before its first transaction (D-N1). An earlier version of
  // this generator anchored a 1-unit posting onto every budgeted value to sidestep a
  // real gap in `project()`; that gap is now fixed and the anchor is gone, so the
  // property tests the criterion rather than around it.
  for (const posting of plan.postings) {
    const account = at(accounts, posting.accountIndex);
    const valueIds = posting.valueIndex === null ? [] : [at(axisValueIds, posting.valueIndex)];

    await post(scene, POSTING_DATE, [
      { accountId: account.id, side: posting.side, amount: posting.amount, valueIds },
      { accountId: bank.id, side: oppositeSide(posting.side), amount: posting.amount },
    ]);
  }

  return { scene, periodId, axis };
}

/** `accountId -> summed triplet`, across every row of every group's two sections. */
function sumTripletsByAccount(
  groups: readonly BudgetVsActualGroup[],
): ReadonlyMap<string, Triplet> {
  const summed = new Map<string, Triplet>();

  for (const group of groups) {
    for (const section of [group.revenue, group.expenses]) {
      for (const row of section.rows) {
        const triplet: Triplet = {
          budget: BigInt(row.budget),
          actual: BigInt(row.actual),
          variance: BigInt(row.variance),
        };
        summed.set(row.accountId, addTriplet(summed.get(row.accountId) ?? ZERO_TRIPLET, triplet));
      }
    }
  }

  return summed;
}

describe('budget vs actual: slices plus unassigned equal the whole (B6)', () => {
  it('sums each account’s budget, actual and variance across every group to the ungrouped figure', async () => {
    await fc.assert(
      fc.asyncProperty(sliceScenarioArb, async (plan) => {
        const { scene, periodId, axis } = await materializeSliceScenario(harness, plan);

        const ungrouped = await getBudgetVsActual({ periodId, basis: 'accrual' }, scene.ctx);
        const grouped = await getBudgetVsActual(
          { periodId, basis: 'accrual', groupBy: axis.id },
          scene.ctx,
        );

        // The bucket the criterion is about, present regardless of whether this
        // generated run happened to leave every line and every budget slot tagged.
        expect(grouped.groups.some((group) => group.key === null)).toBe(true);

        const summed = sumTripletsByAccount(grouped.groups);
        expect(ungrouped.groups).toHaveLength(1);
        const whole = ungrouped.groups[0];
        if (whole === undefined) throw new Error('The ungrouped report returned no group.');

        for (const section of [whole.revenue, whole.expenses]) {
          for (const row of section.rows) {
            const total = summed.get(row.accountId);
            if (total === undefined) {
              throw new Error(`No grouped figures summed for account ${row.accountId}.`);
            }
            expect(total.budget).toBe(BigInt(row.budget));
            expect(total.actual).toBe(BigInt(row.actual));
            expect(total.variance).toBe(BigInt(row.variance));
          }
        }

        expect(grouped.totals).toEqual(ungrouped.totals);
      }),
      { numRuns: SLICE_RUNS },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Property 4: budget signing — a focused example rather than a property, per
// the ticket brief ("reads cleaner alongside the properties").
// ---------------------------------------------------------------------------

describe('budget vs actual: budget signing', () => {
  it('signs revenue and expense variance to their section, per budgetVsActualRowSchema', async () => {
    const { scene, periodId } = await createBudgetScene(harness);
    const { bank, accounts } = await createAccounts(scene, ['revenue', 'expense']);
    const revenue = at(accounts, 0);
    const expense = at(accounts, 1);

    const revenueBudget = 100_000n; // $1,000.00 targeted
    const revenueActual = 75_000n; // $750.00 earned — under target
    const expenseBudget = 50_000n; // $500.00 targeted
    const expenseActual = 60_000n; // $600.00 spent — over target

    await setBudgets(
      {
        entries: [
          { accountId: revenue.id, periodId, amount: revenueBudget.toString() },
          { accountId: expense.id, periodId, amount: expenseBudget.toString() },
        ],
      },
      scene.ctx,
    );

    // Revenue is credit-normal: crediting it is money earned, which
    // `statementAmount('revenue', …)` reports as a positive actual.
    await post(scene, POSTING_DATE, [
      { accountId: revenue.id, side: 'credit', amount: revenueActual },
      { accountId: bank.id, side: 'debit', amount: revenueActual },
    ]);
    // Expense is debit-normal: debiting it is money spent, reported positive
    // as-is (`statementAmount('expense', …)` is the identity).
    await post(scene, POSTING_DATE, [
      { accountId: expense.id, side: 'debit', amount: expenseActual },
      { accountId: bank.id, side: 'credit', amount: expenseActual },
    ]);

    const report = await getBudgetVsActual({ periodId, basis: 'accrual' }, scene.ctx);
    expect(report.groups).toHaveLength(1);
    const group = report.groups[0];
    if (group === undefined) throw new Error('The report returned no group.');

    const revenueRow = group.revenue.rows.find((row) => row.accountId === revenue.id);
    const expenseRow = group.expenses.rows.find((row) => row.accountId === expense.id);
    if (revenueRow === undefined || expenseRow === undefined) {
      throw new Error('The report is missing a generated account.');
    }

    expect(revenueRow.actual).toBe(revenueActual.toString());
    expect(revenueRow.variance).toBe((revenueBudget - revenueActual).toString());

    expect(expenseRow.actual).toBe(expenseActual.toString());
    expect(expenseRow.variance).toBe((expenseBudget - expenseActual).toString());
  });
});
