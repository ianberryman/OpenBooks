import { balanceSheetSchema } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BalanceSheetSection } from '../../src/modules/reports';
import { getBalanceSheet } from '../../src/modules/reports';

import type { FiscalScene } from './balance-sheet-support';
import { createFiscalScene } from './balance-sheet-support';
import type { SceneAccount } from './support';
import { createChart, post, useReportDatabase, withContext } from './support';

/**
 * The balance sheet, worked by hand (OB-043; D-20).
 *
 * The properties next door assert the invariants over generated ledgers; this file
 * asserts the *figures*, on a ledger small enough to add up in the margin. Both are
 * needed and neither substitutes: a property says the sheet balances, and only an
 * example says it balances at the right numbers rather than at zero.
 *
 * The org's fiscal year starts in **April** throughout, because that is the case
 * every shortcut gets wrong. Under a January assumption every figure below is still
 * internally consistent — the sheet balances, every account ties to the trial
 * balance — and only the split between the two derived lines moves.
 */
const harness = useReportDatabase();

/** April, so a report date in Q1 belongs to the *previous* fiscal year. */
const START_MONTH = 4;

const CASH = '1000';
const DEPRECIATION = '1010';
const PAYABLES = '2000';
const CAPITAL = '3000';
const SALES = '4000';
const COSTS = '5000';

let scene: FiscalScene;
let accounts: ReadonlyMap<string, SceneAccount>;

beforeEach(async () => {
  scene = await createFiscalScene(harness, {
    startMonth: START_MONTH,
    calendarYears: [2025, 2026],
  });

  accounts = await createChart(scene, [
    { code: CASH, type: 'asset', normalBalance: 'debit' },
    // Accumulated depreciation: an asset with a credit normal balance, and a child
    // of the asset it depreciates. It must *reduce* both the section and the
    // parent's subtotal.
    { code: DEPRECIATION, type: 'asset', normalBalance: 'credit', parentCode: CASH },
    { code: PAYABLES, type: 'liability', normalBalance: 'credit' },
    // An ordinary equity account. D-20: retained earnings is an account, and the
    // derived lines must not double-count anything that lives in one.
    { code: CAPITAL, type: 'equity', normalBalance: 'credit' },
    { code: SALES, type: 'revenue', normalBalance: 'credit' },
    { code: COSTS, type: 'expense', normalBalance: 'debit' },
  ]);

  // Fiscal year 2025 runs 2025-04-01 to 2026-03-31; fiscal year 2026 starts the day
  // after. Capital 100,000; prior-year profit 50,000 - 20,000 = 30,000.
  await entry('2025-05-10', CASH, CAPITAL, 100_000n);
  await entry('2025-06-01', CASH, SALES, 50_000n);
  await entry('2025-07-01', COSTS, PAYABLES, 20_000n);

  // Fiscal year 2026. The first entry is dated on the year's opening day, which is
  // the one date an off-by-one at the boundary moves between the derived lines.
  await entry('2026-04-01', CASH, SALES, 70_000n);
  await entry('2026-05-15', COSTS, CASH, 25_000n);
  await entry('2026-06-30', COSTS, DEPRECIATION, 5_000n);
});

describe('the balance sheet (OB-043)', () => {
  it('balances, with the year’s earnings derived rather than closed (B3, D-20)', async () => {
    const sheet = await withContext(scene.ctx, () =>
      getBalanceSheet({ asOf: '2026-12-31' }, scene.ctx),
    );

    expect(sheet.totals).toEqual({
      // 100,000 + 50,000 + 70,000 - 25,000 in cash, less 5,000 of depreciation.
      assets: '190000',
      liabilities: '20000',
      // The capital account only. Neither derived line is an account (D-20).
      equity: '100000',
      priorYearEarnings: '30000',
      // 70,000 of sales less 25,000 of costs and 5,000 of depreciation.
      currentYearEarnings: '40000',
      liabilitiesAndEquity: '190000',
      difference: '0',
    });
  });

  it('resolves the fiscal year from the org rather than from the calendar (D-17)', async () => {
    const [current, prior] = await withContext(scene.ctx, async () => [
      await getBalanceSheet({ asOf: '2026-12-31' }, scene.ctx),
      // Inside fiscal year 2025, which an org starting in January would call 2026 —
      // and would then report 30,000 of prior-year earnings and none for the year.
      await getBalanceSheet({ asOf: '2026-03-31' }, scene.ctx),
    ]);

    expect(current.fiscalYear).toEqual({
      year: 2026,
      startMonth: 4,
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });

    expect(prior.fiscalYear).toEqual({
      year: 2025,
      startMonth: 4,
      startDate: '2025-04-01',
      endDate: '2026-03-31',
    });

    // Every posting so far is inside fiscal year 2025, so nothing is brought
    // forward and the whole result is this year's.
    expect(prior.totals.priorYearEarnings).toBe('0');
    expect(prior.totals.currentYearEarnings).toBe('30000');
    expect(prior.totals.assets).toBe('150000');
    expect(prior.totals.difference).toBe('0');
  });

  it('signs each section by account type, so a contra asset reduces assets', async () => {
    const sheet = await withContext(scene.ctx, () =>
      getBalanceSheet({ asOf: '2026-12-31' }, scene.ctx),
    );

    const group = sheet.groups[0];
    if (group === undefined) throw new Error('An unsliced sheet returned no group.');

    // Positive on the side each section belongs to: a debit-balance asset and a
    // credit-balance liability both print positive.
    expect(rowFor(group.assets, CASH).amount).toBe('195000');
    expect(rowFor(group.liabilities, PAYABLES).amount).toBe('20000');
    expect(rowFor(group.equity, CAPITAL).amount).toBe('100000');

    // The contra asset holds a credit balance and is still in the asset section, so
    // it prints negative. Signing by `normalBalance` would print 5,000 and add it.
    const depreciation = rowFor(group.assets, DEPRECIATION);
    expect(depreciation.normalBalance).toBe('credit');
    expect(depreciation.amount).toBe('-5000');

    // B7: the parent carries its own postings *and* its subtree's total, separately.
    expect(rowFor(group.assets, CASH).subtotal).toBe('190000');
    expect(group.assets.total).toBe('190000');
  });

  it('prints no revenue or expense account, and every balance-sheet account', async () => {
    const sheet = await withContext(scene.ctx, () =>
      getBalanceSheet({ asOf: '2026-12-31' }, scene.ctx),
    );

    const group = sheet.groups[0];
    if (group === undefined) throw new Error('An unsliced sheet returned no group.');

    const printed = [...group.assets.rows, ...group.liabilities.rows, ...group.equity.rows].map(
      (row) => row.code,
    );

    expect(printed).toEqual([CASH, DEPRECIATION, PAYABLES, CAPITAL]);
    expect(printed).not.toContain(SALES);
    expect(printed).not.toContain(COSTS);
  });

  it('produces a response the wire schema accepts', async () => {
    const sheet = await withContext(scene.ctx, () =>
      getBalanceSheet({ asOf: '2026-12-31' }, scene.ctx),
    );

    // The service returns cents-only strings and the schema enforces D-13's format,
    // so this is where "a `number` slipped into a money field" would surface —
    // before OB-045 attaches the schema to a route.
    expect(() => balanceSheetSchema.parse(sheet)).not.toThrow();
  });

  it('refuses a report date that is not a date', async () => {
    await expect(
      withContext(scene.ctx, () => getBalanceSheet({ asOf: '2026-02-30' }, scene.ctx)),
    ).rejects.toThrow();
  });
});

async function entry(
  date: string,
  debitCode: string,
  creditCode: string,
  amount: bigint,
): Promise<void> {
  await post(scene, date, [
    { accountId: accountId(debitCode), side: 'debit', amount },
    { accountId: accountId(creditCode), side: 'credit', amount },
  ]);
}

function accountId(code: string): string {
  const account = accounts.get(code);
  if (account === undefined) throw new Error(`Chart is missing account ${code}.`);
  return account.id;
}

function rowFor(section: BalanceSheetSection, code: string): BalanceSheetSection['rows'][number] {
  const row = section.rows.find((candidate) => candidate.code === code);
  if (row === undefined) throw new Error(`No row for account ${code}.`);
  return row;
}
