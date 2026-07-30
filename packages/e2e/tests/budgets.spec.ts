import { expect, test } from '@playwright/test';

import { chooseInCombobox, currentMonth, newRegistration } from './support/books';

/**
 * The budgets narrative (OB-184, N) — the milestone's browser proof, one run of user
 * intent, as D-26 asks: a single narrative rather than a suite.
 *
 * The claim it verifies is budgets' whole reason to exist: a figure entered against an
 * account and period is a *parallel plane* (D-94, no journal), and the budget-vs-actual
 * report lines it up against the ledger with an exact variance. It sets up an org, enters
 * a 1,000.00 budget for a revenue account, posts a 400.00 cash sale to that same account,
 * then opens Budget vs actual and reads back budget 1,000.00, actual 400.00, variance
 * 600.00 — cents-exact. A cash sale is used for the actual so the figure is the same on
 * either recognition basis; the property suite (`budget-vs-actual.property.test.ts`) is
 * where both-bases exactness and the slices-plus-unassigned-equal-the-whole invariant (B6)
 * are proven across generated inputs.
 */
test('a budgeted revenue account reads back its exact variance against actuals', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();

  // Service revenue (4020) in the "General small business" starter chart — a credit-normal
  // revenue account, and the one the actual below posts to.
  const REVENUE_ACCOUNT = 'Service revenue';
  const BUDGET = '1000';
  const ACTUAL = '400';

  await test.step('register, which creates the login and the first organization together', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account instead' }).click();
    await page.getByLabel('Your name').fill(registration.displayName);
    await page.getByLabel('Email').fill(registration.email);
    await page.getByLabel('Password').fill(registration.password);
    await page.getByLabel('Organization name').fill(registration.orgName);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chart of accounts' })).toBeVisible();
  });

  await test.step('apply the starter chart of accounts', async () => {
    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Business checking' })).toBeVisible();
  });

  await test.step('generate the fiscal year — the period a budget and its actuals name', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  await test.step('enter a 1,000.00 budget for Service revenue in this period', async () => {
    await page.getByRole('link', { name: 'Budgets' }).click();
    await expect(page.getByRole('heading', { name: 'Budgets' })).toBeVisible();

    // Choosing the period loads the grid for that period's slot; the grid is keyed on the
    // period, so this alone remounts it prefilled from whatever is already stored (nothing yet).
    await page.getByRole('combobox', { name: 'Fiscal period' }).click();
    await page.getByRole('option', { name: month.periodName }).click();

    // The grid lists every revenue and expense account, each input aria-labelled by its
    // account name — only P&L accounts are budgeted in v1 (D-N2).
    const amount = page.getByLabel(`${REVENUE_ACCOUNT} budgeted amount`);
    await expect(amount).toBeVisible();
    await amount.fill(BUDGET);

    // One batch upsert for the whole grid (D-N5). Save enables only once a cell is dirty.
    await page.getByRole('button', { name: 'Save budgets' }).click();
    // Re-reading the just-saved figure proves the round trip: the input stays populated and
    // no error banner appears.
    await expect(amount).toHaveValue(BUDGET);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  await test.step('post a 400.00 cash sale to Service revenue — the actual', async () => {
    await page.getByRole('link', { name: 'Journal entry' }).click();
    await page.getByRole('button', { name: 'New entry' }).click();

    const draft = page.getByRole('region', { name: 'Journal entry draft' });
    await draft.getByLabel('Entry date').fill(month.day(10));
    await draft.getByLabel('Description').fill('Cash sale');

    // Debit the bank, credit revenue: a cash sale, recognised the same on accrual and cash,
    // so the actual below is basis-independent.
    await chooseInCombobox(page, 'Account, line 1', '1010');
    await draft.getByLabel('Debit, line 1').fill(ACTUAL);
    await chooseInCombobox(page, 'Account, line 2', '4020');
    await draft.getByLabel('Credit, line 2').fill(ACTUAL);

    await draft.getByRole('button', { name: 'Save draft' }).click();
    await draft.getByRole('button', { name: 'Post entry' }).click();

    const posted = page.getByRole('region', { name: 'Posted journal entry' });
    await expect(posted.getByText('Posted to the ledger')).toBeVisible();
  });

  await test.step('Budget vs actual shows budget 1000.00, actual 400.00, variance 600.00', async () => {
    await page.getByRole('link', { name: 'Reports' }).click();
    await page.getByRole('button', { name: 'Budget vs actual' }).click();

    // The report is keyed by a single period (D-N4), chosen from its own picker.
    await page.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: month.periodName }).click();

    await expect(page.getByRole('heading', { name: 'Budget vs actual' })).toBeVisible();

    // The unsliced report has one group, so one Revenue table. The account's row carries its
    // budget, actual and variance in that column order — all cents-exact.
    const revenue = page.getByRole('table', { name: 'Revenue' });
    const row = revenue.getByRole('row', { name: new RegExp(REVENUE_ACCOUNT) });
    await expect(row).toContainText('1000.00');
    await expect(row).toContainText('400.00');
    await expect(row).toContainText('600.00');
  });
});
