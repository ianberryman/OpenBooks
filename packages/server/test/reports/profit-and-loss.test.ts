import { profitAndLossSchema } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { ValidationError, toWireError } from '../../src/errors';
import type { ProfitAndLossRow, ProfitAndLossSection } from '../../src/modules/reports';
import { getProfitAndLoss } from '../../src/modules/reports';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';

import type { Axis, Scene, SceneAccount } from './support';
import {
  contextFor,
  createAxis,
  createChart,
  createScene,
  post,
  useReportDatabase,
} from './support';

/**
 * The profit and loss, stated as examples (OB-042).
 *
 * The properties in `test/properties/report-profit-and-loss.test.ts` are what
 * prove the arithmetic — net income against the trial balance over generated
 * ledgers (B2), slices summing to the whole (B6), subtotals against descendants
 * (B7). What is here is the part a property cannot state: which way the numbers
 * point, which accounts appear at all, and what the query refuses.
 *
 * The fixture is built around the case that separates the two plausible sign
 * rules. `4900` is contra-revenue — `type: 'revenue'`, `normalBalance: 'debit'` —
 * which every real chart has as discounts or returns, and which is the only chart
 * shape where "flip by type" and "flip by normal balance" disagree.
 */
const db = useReportDatabase();

interface Fixture {
  readonly scene: Scene;
  readonly accounts: ReadonlyMap<string, SceneAccount>;
  readonly department: Axis;
}

async function fixture(): Promise<Fixture> {
  const scene = await createScene(db);

  const accounts = await createChart(scene, [
    { code: '1000', type: 'asset', normalBalance: 'debit' },
    { code: '2000', type: 'liability', normalBalance: 'credit' },
    { code: '3000', type: 'equity', normalBalance: 'credit' },
    { code: '4000', type: 'revenue', normalBalance: 'credit' },
    { code: '4100', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
    { code: '4200', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
    { code: '4900', type: 'revenue', normalBalance: 'debit', parentCode: '4000' },
    { code: '5000', type: 'expense', normalBalance: 'debit' },
    { code: '5100', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
    { code: '5200', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
  ]);

  return { scene, accounts, department: await createAxis(scene, 'DEPT', ['OPS', 'SALES']) };
}

function id(accounts: ReadonlyMap<string, SceneAccount>, code: string): string {
  const account = accounts.get(code);
  if (account === undefined) throw new Error(`Fixture has no account ${code}.`);
  return account.id;
}

function rowFor(section: ProfitAndLossSection, code: string): ProfitAndLossRow {
  const row = section.rows.find((candidate) => candidate.code === code);
  if (row === undefined) throw new Error(`No row for account ${code} in this section.`);
  return row;
}

/**
 * A quarter with sales, a discount against them, rent posted to a child, and a
 * little posted to the expense parent directly — plus one journal in the next
 * quarter, which every in-range assertion must exclude.
 */
async function postTheQuarter(f: Fixture): Promise<void> {
  const cash = id(f.accounts, '1000');

  await post(f.scene, '2026-01-15', [
    { accountId: cash, side: 'debit', amount: 100_000n },
    { accountId: id(f.accounts, '4100'), side: 'credit', amount: 100_000n },
  ]);
  await post(f.scene, '2026-02-01', [
    { accountId: id(f.accounts, '4900'), side: 'debit', amount: 5_000n },
    { accountId: cash, side: 'credit', amount: 5_000n },
  ]);
  await post(f.scene, '2026-03-31', [
    { accountId: id(f.accounts, '5100'), side: 'debit', amount: 30_000n },
    { accountId: cash, side: 'credit', amount: 30_000n },
  ]);
  await post(f.scene, '2026-03-31', [
    { accountId: id(f.accounts, '5000'), side: 'debit', amount: 2_000n },
    { accountId: cash, side: 'credit', amount: 2_000n },
  ]);

  // Outside the quarter. Present so that "movement, not closing" is a claim the
  // suite can fail rather than one it happens to agree with.
  await post(f.scene, '2026-04-01', [
    { accountId: id(f.accounts, '4200'), side: 'credit', amount: 777_000n },
    { accountId: cash, side: 'debit', amount: 777_000n },
  ]);
}

const QUARTER = { from: '2026-01-01', to: '2026-03-31' } as const;

describe('the statement', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
    await postTheQuarter(f);
  });

  it('reports revenue and expense only', async () => {
    const report = await getProfitAndLoss(QUARTER, f.scene.ctx);
    const group = report.groups[0];
    if (group === undefined) throw new Error('An unsliced statement returned no group.');

    expect(report.groups).toHaveLength(1);
    expect(group.key).toBeNull();
    expect(report.groupBy).toBeNull();
    expect(report.range).toEqual({ from: QUARTER.from, to: QUARTER.to });
    expect(report.basis).toBe('accrual');

    expect(group.revenue.rows.map((row) => row.code)).toEqual(['4000', '4100', '4200', '4900']);
    expect(group.expenses.rows.map((row) => row.code)).toEqual(['5000', '5100', '5200']);
  });

  it('signs revenue so that a good month is a positive number', async () => {
    const { revenue } = (await getProfitAndLoss(QUARTER, f.scene.ctx)).groups[0]!;

    // The core's own `balance` for 4100 is `debits - credits` = -100000. A reader
    // of a P&L expects 100000, and that flip is this report's whole convention.
    expect(rowFor(revenue, '4100').amount).toBe('100000');
    expect(rowFor(revenue, '4100').normalBalance).toBe('credit');
  });

  it('signs expense so that money spent is a positive number', async () => {
    const { expenses } = (await getProfitAndLoss(QUARTER, f.scene.ctx)).groups[0]!;

    expect(rowFor(expenses, '5100').amount).toBe('30000');
    expect(rowFor(expenses, '5000').amount).toBe('2000');
  });

  it('subtracts a contra-revenue account from revenue rather than adding it', async () => {
    const { revenue } = (await getProfitAndLoss(QUARTER, f.scene.ctx)).groups[0]!;

    // The account this suite exists for. It carries `type: 'revenue'` and
    // `normalBalance: 'debit'`, so a sign keyed off the normal balance would
    // report +5000 here and a revenue total of 105000 — a plausible number, and
    // 10000 too high. Keying off the type is what makes a discount reduce sales.
    const discount = rowFor(revenue, '4900');
    expect(discount.normalBalance).toBe('debit');
    expect(discount.amount).toBe('-5000');
    expect(revenue.total).toBe('95000');
  });

  it('rolls a subtree into its parent’s subtotal without touching the parent’s own row', async () => {
    const group = (await getProfitAndLoss(QUARTER, f.scene.ctx)).groups[0]!;

    // 4000 has no postings of its own; its children net to 100000 - 5000.
    expect(rowFor(group.revenue, '4000').amount).toBe('0');
    expect(rowFor(group.revenue, '4000').subtotal).toBe('95000');

    // 5000 does have postings of its own, which is the case that makes the two
    // numbers distinguishable: 2000 of its own plus 30000 from 5100.
    expect(rowFor(group.expenses, '5000').amount).toBe('2000');
    expect(rowFor(group.expenses, '5000').subtotal).toBe('32000');
    expect(rowFor(group.expenses, '5100').subtotal).toBe('30000');
  });

  it('totals each section from the rows, not from the subtotals', async () => {
    const group = (await getProfitAndLoss(QUARTER, f.scene.ctx)).groups[0]!;

    // Summing the subtotals instead would count 5000’s subtree twice and give
    // 64000 here, which is why the section total is stated over `amount`.
    expect(group.expenses.total).toBe('32000');
    expect(group.revenue.total).toBe('95000');
  });

  it('reports net income as revenue less expenses', async () => {
    const report = await getProfitAndLoss(QUARTER, f.scene.ctx);

    expect(report.groups[0]!.netIncome).toBe('63000');
    expect(report.totals).toEqual({
      revenue: '95000',
      expenses: '32000',
      netIncome: '63000',
    });
  });

  it('reads the period’s movement, not the balance to date', async () => {
    const quarter = await getProfitAndLoss(QUARTER, f.scene.ctx);
    const toDate = await getProfitAndLoss({ to: '2026-12-31' }, f.scene.ctx);

    // The April journal is 777000 of revenue. A statement built on `closing`
    // would report it inside a quarter that ended in March.
    expect(rowFor(quarter.groups[0]!.revenue, '4200').amount).toBe('0');
    expect(rowFor(toDate.groups[0]!.revenue, '4200').amount).toBe('777000');
    expect(toDate.totals.netIncome).toBe('840000');
    expect(toDate.range).toEqual({ from: null, to: '2026-12-31' });
  });

  it('excludes what happened before the range, not only what happened after it', async () => {
    const report = await getProfitAndLoss({ from: '2026-02-01', to: '2026-03-31' }, f.scene.ctx);
    const group = report.groups[0]!;

    // Measured, and the reason this test exists separately from the one above:
    // with the range starting on the fiscal year's first day there is nothing
    // before it, so `opening` is zero and `closing` equals `movement` — a
    // statement built on the wrong arm passes every assertion in this file. It
    // takes a lower bound with postings behind it to tell them apart, and the
    // January sale of 100000 is what sits behind this one.
    expect(rowFor(group.revenue, '4100').amount).toBe('0');
    expect(group.revenue.total).toBe('-5000');
    expect(group.expenses.total).toBe('32000');
    expect(group.netIncome).toBe('-37000');
  });

  it('keeps accounts with no postings in the period, at zero', async () => {
    const { revenue, expenses } = (await getProfitAndLoss(QUARTER, f.scene.ctx)).groups[0]!;

    // 4200's only journal is in April and 5200 has never been posted to. Both
    // stay: an empty revenue account is how someone notices the month's sales
    // landed somewhere else, and a section that dropped its zeros would drop a
    // different set in every group of a sliced report, which is what B6 compares.
    expect(rowFor(revenue, '4200').amount).toBe('0');
    expect(rowFor(revenue, '4200').subtotal).toBe('0');
    expect(rowFor(expenses, '5200').amount).toBe('0');
  });

  it('is a response the published schema accepts', async () => {
    const report = await getProfitAndLoss(QUARTER, f.scene.ctx);

    // The service declares its own interfaces and shared-types declares the wire
    // shape; nothing in the compiler ties the two together, so the tie is here.
    expect(profitAndLossSchema.safeParse(report)).toMatchObject({ success: true });
  });
});

describe('slicing by a dimension axis', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();

    const cash = id(f.accounts, '1000');
    const ops = f.department.values.get('OPS');
    if (ops === undefined) throw new Error('Fixture axis has no OPS value.');

    await post(f.scene, '2026-01-15', [
      { accountId: cash, side: 'debit', amount: 60_000n },
      { accountId: id(f.accounts, '4100'), side: 'credit', amount: 60_000n, valueIds: [ops] },
    ]);
    await post(f.scene, '2026-01-20', [
      { accountId: cash, side: 'debit', amount: 40_000n },
      { accountId: id(f.accounts, '4100'), side: 'credit', amount: 40_000n },
    ]);
    await post(f.scene, '2026-02-10', [
      { accountId: id(f.accounts, '5100'), side: 'debit', amount: 25_000n, valueIds: [ops] },
      { accountId: cash, side: 'credit', amount: 25_000n },
    ]);
  });

  it('gives each bucket its own statement and keeps the unassigned one last', async () => {
    const report = await getProfitAndLoss({ ...QUARTER, groupBy: f.department.id }, f.scene.ctx);

    expect(report.groupBy).toBe(f.department.id);
    expect(report.groups.at(-1)?.key).toBeNull();

    const ops = report.groups.find((group) => group.key?.code === 'OPS');
    if (ops === undefined) throw new Error('No OPS bucket.');
    expect(ops.revenue.total).toBe('60000');
    expect(ops.expenses.total).toBe('25000');
    expect(ops.netIncome).toBe('35000');

    const unassigned = report.groups.find((group) => group.key === null);
    if (unassigned === undefined) throw new Error('No unassigned bucket.');
    expect(unassigned.revenue.total).toBe('40000');
    expect(unassigned.netIncome).toBe('40000');
  });

  it('sums its buckets to the unsliced statement (B6)', async () => {
    const whole = await getProfitAndLoss(QUARTER, f.scene.ctx);
    const sliced = await getProfitAndLoss({ ...QUARTER, groupBy: f.department.id }, f.scene.ctx);

    expect(sliced.totals).toEqual(whole.totals);
    expect(whole.totals.netIncome).toBe('75000');
  });
});

describe('the query', () => {
  it('refuses an account-type filter, because a P&L is revenue and expense', async () => {
    const scene = await createScene(db);

    const error = await getProfitAndLoss({ types: ['asset'] } as never, scene.ctx).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(toWireError(error)).toMatchObject({
      code: 'validation_failed',
      details: { issues: [{ path: 'types' }] },
    });
  });

  it('refuses an inverted range', async () => {
    const scene = await createScene(db);

    // Not restated on this schema — the core parses the query it is handed, so
    // the rule is enforced in one place and reported with the core's own message.
    const error = await getProfitAndLoss({ from: '2026-03-31', to: '2026-01-01' }, scene.ctx).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(toWireError(error)).toMatchObject({
      code: 'validation_failed',
      details: { issues: [{ path: 'to' }] },
    });
  });
});

describe('permission', () => {
  it('is readable by a role that holds reports.read and nothing that writes', async () => {
    const scene = await createScene(db);
    const user = await db.factories.user();
    await db.factories.orgMember({
      orgId: scene.orgId,
      userId: user.id,
      roleId: systemRoleId('readOnly'),
    });

    const readOnly = contextFor(scene.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, user.uuid);
    await expect(getProfitAndLoss({}, readOnly)).resolves.toBeDefined();
  });
});
