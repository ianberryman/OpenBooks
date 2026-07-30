import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  chooseInCombobox,
  currentMonth,
  newRegistration,
  reportDate,
  rowIn,
} from './support/books';

/**
 * B1 — a full month of books, run end to end in a real browser (OB-055, D-26).
 *
 * ## What this test is for, and what it deliberately is not
 *
 * Every layer below the browser has already been proven: the ledger invariants by the
 * property suite, the permission and 404 behaviour by the enforcement matrix, the report
 * arithmetic by OB-053, the components by jsdom. What none of them can say is that the
 * seam between them holds — that a person clicking through six screens against a real
 * Fastify app and a real MySQL ends up with books that balance. That is the only claim
 * this file makes, and it is why it is one narrative rather than a suite (D-26).
 *
 * So the assertions are **figures**. A test that checked headings would be an expensive
 * way to prove routing works; the trial balance must balance, the P&L's net income must be
 * the number the entries imply, the balance sheet must foot, and the reversed account must
 * be back at zero. Every one of those is read off the rendered page as text, because money
 * is cents on the wire and a decimal only in the glyphs (D-13) — there is no float to
 * compare against here and there must not be one.
 *
 * ## The arithmetic, written down
 *
 * Four journals, three posted by hand and one a reversal:
 *
 * ```
 *   day  5   Dr 1010 Business checking  1500.00   Cr 4020 Service revenue   1500.00
 *   day 10   Dr 6080 Rent                400.00   Cr 1010 Business checking  400.00
 *   day 15   Dr 6060 Office supplies     250.00   Cr 1010 Business checking  250.00
 *   day 20   reversal of day 15 — every side inverted (D-02, D-16)
 * ```
 *
 * which gives, at the month end:
 *
 * ```
 *   trial balance   debits 2400.00 = credits 2400.00, difference 0.00
 *   6060            250.00 Dr and 250.00 Cr, balance 0.00      ← the reversal, netted
 *   profit and loss revenue 1500.00 − expenses 400.00 = net income 1100.00
 *   balance sheet   assets 1100.00 = liabilities 0.00 + equity 0.00
 *                                    + prior-year 0.00 + current-year 1100.00
 * ```
 *
 * The office-supplies pair is the point of the third entry: 6060 standing at 0.00 with a
 * debit and a credit *both* showing is what a correction looks like in a ledger that cannot
 * be edited, and it is visibly different from an entry that was never made (D-16).
 */

/** Displayed forms. Cents on the wire, decimals on screen, never a float (D-13). */
const CONSULTING = '1500.00';
const RENT = '400.00';
const SUPPLIES = '250.00';
const NET_INCOME = '1100.00';
const CASH = '1100.00';
const TOTAL_SIDE = '2400.00';
const ZERO = '0.00';

const CUSTOMER = 'Northwind Traders';
const DEPARTMENT = 'Department';
const DEPARTMENT_VALUE = 'Operations';

test('a solo owner runs a month of books, unassisted, in a browser', async ({ page }) => {
  const registration = newRegistration();
  const month = currentMonth();

  await test.step('register, which creates the login and the first organization together', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account instead' }).click();

    await page.getByLabel('Your name').fill(registration.displayName);
    await page.getByLabel('Email').fill(registration.email);
    await page.getByLabel('Password').fill(registration.password);
    await page.getByLabel('Organization name').fill(registration.orgName);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Signed in and scoped to the new org: the shell only renders primary navigation once
    // `GET /v1/auth/me` answers with an active org (src/App.tsx).
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chart of accounts' })).toBeVisible();
  });

  await test.step('apply the starter chart of accounts', async () => {
    // D-23 keeps the starter chart opt-in, and the register form cannot offer it —
    // `GET /v1/chart-templates` is org-scoped, and the org does not exist yet when that
    // form is filled in. So a new org arrives with no accounts at all, and says so.
    await expect(page.getByText('This organization has no accounts yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(page.getByText('that is the whole chart')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Business checking' })).toBeVisible();
  });

  await test.step('generate the fiscal year — nothing can be posted before this', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });

    // D-17: generation is explicit and never implicit, so `journals.period_id` being NOT
    // NULL means a fresh org can record nothing at all. This is the first wall a real user
    // hits, which is why it is part of B1 and not a setup detail.
    await expect(periods.getByText('This organization cannot record anything yet')).toBeVisible();

    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByText('Generated 12 periods')).toBeVisible();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  await test.step('add a reporting dimension and a value on it', async () => {
    const dimensions = page.getByRole('region', { name: 'Dimensions' });
    await dimensions.getByRole('button', { name: 'New axis' }).click();

    const axisDialog = page.getByRole('dialog', { name: 'New axis' });
    await axisDialog.getByLabel('Code').fill('DEPT');
    await axisDialog.getByLabel('Name').fill(DEPARTMENT);
    await axisDialog.getByRole('button', { name: 'Create axis' }).click();

    await expect(dimensions.getByRole('cell', { name: 'DEPT' })).toBeVisible();

    await dimensions
      .getByRole('row', { name: /DEPT/ })
      .getByRole('button', { name: 'Values' })
      .click();
    await page.getByRole('button', { name: 'New value' }).click();

    const valueDialog = page.getByRole('dialog', { name: 'New value' });
    await valueDialog.getByLabel('Code').fill('OPS');
    await valueDialog.getByLabel('Name').fill(DEPARTMENT_VALUE);
    await valueDialog.getByRole('button', { name: 'Add value' }).click();

    // `exact`, because the row's actions cell carries "Archive Operations" and "Delete
    // Operations" as accessible names and would otherwise match too.
    await expect(page.getByRole('cell', { name: DEPARTMENT_VALUE, exact: true })).toBeVisible();
  });

  await test.step('add the customer the first entry names', async () => {
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.getByRole('button', { name: 'New contact' }).click();

    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByLabel('Name', { exact: true }).fill(CUSTOMER);
    await dialog.getByLabel('Code').fill('CUST-001');
    await dialog.getByLabel('Customer').check();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('cell', { name: CUSTOMER, exact: true })).toBeVisible();
  });

  await test.step('draft the first entry, save it, and post it', async () => {
    await page.getByRole('link', { name: 'Journal entry' }).click();
    await page.getByRole('button', { name: 'New entry' }).click();

    const draft = page.getByRole('region', { name: 'Journal entry draft' });
    await draft.getByLabel('Entry date').fill(month.day(5));
    await draft.getByLabel('Description').fill('Consulting fee — Northwind');

    await chooseInCombobox(page, 'Account, line 1', '1010');
    await page.getByLabel('Debit, line 1').fill(CONSULTING);

    await chooseInCombobox(page, 'Account, line 2', '4020');
    await page.getByLabel('Credit, line 2').fill(CONSULTING);
    await chooseInCombobox(page, 'Contact, line 2', 'Northwind');

    // Per line, never per journal (D-18) — one entry can split across departments, so the
    // tag lives behind the line's own disclosure.
    await draft.getByRole('button', { name: 'Details, line 2' }).click();
    await chooseInCombobox(page, `${DEPARTMENT}, line 2`, 'OPS');

    // A draft is editable and stored, and reaches nothing (D-19). Saving before posting is
    // what proves the two states are distinct rather than one button apart.
    await draft.getByRole('button', { name: 'Save draft' }).click();
    await expect(draft.getByText('All changes saved')).toBeVisible();

    await draft.getByRole('button', { name: 'Post entry' }).click();

    const posted = page.getByRole('region', { name: 'Posted journal entry' });
    await expect(posted.getByText('Posted to the ledger')).toBeVisible();
    await expect(posted.getByRole('cell', { name: CUSTOMER })).toBeVisible();
    await expect(posted.getByRole('cell', { name: DEPARTMENT_VALUE })).toBeVisible();
  });

  await test.step('post the rent', async () => {
    await postSimpleEntry(page, {
      entryDate: month.day(10),
      memo: 'Office rent',
      debitAccount: '6080',
      creditAccount: '1010',
      amount: RENT,
    });
  });

  await test.step('post an entry that will be corrected', async () => {
    await postSimpleEntry(page, {
      entryDate: month.day(15),
      memo: 'Office supplies — wrong account',
      debitAccount: '6060',
      creditAccount: '1010',
      amount: SUPPLIES,
    });
  });

  await test.step('reverse it — the only correction an append-only ledger has', async () => {
    const posted = page.getByRole('region', { name: 'Posted journal entry' });
    await posted.getByRole('button', { name: 'Reverse entry' }).click();

    const dialog = page.getByRole('dialog', { name: 'Reverse this entry' });
    await dialog.getByLabel('Reversal date').fill(month.day(20));
    await dialog.getByLabel('Description').fill('Posted to the wrong account');
    await dialog.getByRole('button', { name: 'Post reversal' }).click();

    // Both entries exist afterwards. Nothing was edited and nothing was deleted, because
    // the app user holds no UPDATE or DELETE on `journals` at all (A6, D-02).
    await expect(posted.getByText('This entry reverses another')).toBeVisible();
    await expect(posted.getByText('Both entries remain in the books')).toBeVisible();
  });

  await test.step('close the month, and find it closed', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    const row = periods.getByRole('row', { name: new RegExp(month.periodName) });

    await expect(row.getByText('Open')).toBeVisible();
    await row.getByRole('button', { name: 'Close' }).click();

    // Closing goes through an advisory sign-off dialog (initiative P, D-97): the row's
    // Close button opens it, and the period is not closed until 'Close period' inside it is
    // confirmed. A brand-new org trips no blocking check, so the sign-off is a formality
    // here — but it is the real flow the product ships (`settings/periods.tsx`), so the
    // narrative drives it rather than the pre-P one-click close it used to.
    const closeDialog = page.getByRole('dialog', { name: `Close ${month.periodName}` });
    await closeDialog.getByRole('button', { name: 'Close period' }).click();

    await expect(row.getByText('Closed')).toBeVisible();
  });

  await test.step('a closed month refuses the next entry, by name', async () => {
    // The point of closing. Asserted here rather than assumed, because a Close button that
    // only recoloured a pill would pass every screen test written against it.
    await page.getByRole('link', { name: 'Journal entry' }).click();
    await page.getByRole('button', { name: 'New entry' }).click();

    const draft = page.getByRole('region', { name: 'Journal entry draft' });
    await draft.getByLabel('Entry date').fill(month.day(25));
    await chooseInCombobox(page, 'Account, line 1', '6080');
    await page.getByLabel('Debit, line 1').fill(RENT);
    await chooseInCombobox(page, 'Account, line 2', '1010');
    await page.getByLabel('Credit, line 2').fill(RENT);
    await draft.getByRole('button', { name: 'Post entry' }).click();

    const refusal = draft.getByRole('alert');
    await expect(refusal).toContainText('Not possible right now');
    await expect(refusal).toContainText(`${month.periodName}`);
    await expect(refusal).toContainText('is closed');

    // Discarded, so the books this run leaves behind hold no half-finished work.
    await draft.getByRole('button', { name: 'Discard' }).click();
    await page.getByRole('button', { name: 'Discard draft' }).click();
  });

  await test.step('the trial balance balances, and the reversed account stands at zero', async () => {
    await page.getByRole('link', { name: 'Reports' }).click();
    await reportDate(page, 'As at').fill(month.lastDay);

    const table = page.getByRole('table', { name: 'Trial balance' });
    /**
     * By code, anchored — the row's text begins with it. Matching on the account *name*
     * looks more readable and is wrong: `hasText` is a case-insensitive substring, so
     * "Rent" also selects "Current assets" and "Current liabilities", and the assertion
     * then reads the first of the three. The chart has sixty-six rows and four of them
     * carry figures; a locator that can drift onto a zero row is a locator that passes.
     */
    const row = (code: string) =>
      table.locator('tbody tr').filter({ hasText: new RegExp(`^${code}`) });

    // `balance` on this report is always debits − credits, whatever the account's normal
    // balance is, which is why revenue reads negative here and positive on the P&L.
    await expect(row('1010').locator('td').nth(2)).toHaveText(CASH);
    await expect(row('4020').locator('td').nth(2)).toHaveText(`-${CONSULTING}`);
    await expect(row('6080').locator('td').nth(2)).toHaveText(RENT);

    // The correction, netted: both sides visible, the account at zero. A deleted entry
    // would have left no trace of either.
    const supplies = row('6060');
    await expect(supplies.locator('td').nth(0)).toHaveText(SUPPLIES);
    await expect(supplies.locator('td').nth(1)).toHaveText(SUPPLIES);
    await expect(supplies.locator('td').nth(2)).toHaveText(ZERO);

    const totals = table.locator('tfoot tr').first();
    await expect(totals.locator('td').nth(0)).toHaveText(TOTAL_SIDE);
    await expect(totals.locator('td').nth(1)).toHaveText(TOTAL_SIDE);
    // Last cell of the row: the difference sits under the Balance column, behind two empty
    // cells where the debit and credit totals are.
    await expect(
      rowIn(table, /^Difference$/)
        .locator('td')
        .last(),
    ).toHaveText(ZERO);
  });

  await test.step('the profit and loss shows the income the entries imply', async () => {
    await page.getByRole('button', { name: 'Profit and loss' }).click();
    await reportDate(page, 'From').fill(month.firstDay);
    await reportDate(page, 'To').fill(month.lastDay);

    const revenue = page.getByRole('table', { name: 'Revenue' });
    const expenses = page.getByRole('table', { name: 'Expenses' });

    // First cell: a section total prints under the Amount column it is the sum of, and an
    // empty Subtotal cell follows it.
    await expect(
      rowIn(revenue, /^Total revenue$/)
        .locator('td')
        .first(),
    ).toHaveText(CONSULTING);
    // 400.00 and not 650.00: the reversal took the office supplies back out.
    await expect(
      rowIn(expenses, /^Total expenses$/)
        .locator('td')
        .first(),
    ).toHaveText(RENT);
    await expect(
      rowIn(page.getByRole('table', { name: 'Result' }), /^Net income$/).locator('td'),
    ).toHaveText(NET_INCOME);
  });

  await test.step('the balance sheet foots, without a closing journal', async () => {
    await page.getByRole('button', { name: 'Balance sheet' }).click();
    await reportDate(page, 'As at').fill(month.lastDay);

    const assets = page.getByRole('table', { name: 'Assets' });
    await expect(
      rowIn(assets, /^Total assets$/)
        .locator('td')
        .first(),
    ).toHaveText(CASH);

    /**
     * D-20's identity, and it is two derived lines rather than one:
     *
     *   assets = liabilities + equity + prior-year earnings + current-year earnings
     *
     * Neither earnings line is an account — with no year-end closing journal, revenue and
     * expense balances have nowhere to land, so the sheet is made to balance by deriving
     * what a close would have moved. Current-year earnings equalling the P&L's net income
     * is the tie between the two statements (B2).
     */
    const footing = page.getByRole('table', { name: 'Footing' });
    await expect(rowIn(footing, /^Total liabilities$/).locator('td')).toHaveText(ZERO);
    await expect(rowIn(footing, /^Total equity accounts$/).locator('td')).toHaveText(ZERO);
    await expect(rowIn(footing, /^Prior-year earnings/).locator('td')).toHaveText(ZERO);
    await expect(rowIn(footing, /^Current-year earnings/).locator('td')).toHaveText(NET_INCOME);
    await expect(rowIn(footing, /^Total liabilities and equity$/).locator('td')).toHaveText(CASH);
    await expect(rowIn(footing, /^Total assets$/).locator('td')).toHaveText(CASH);
    await expect(rowIn(footing, /^Difference/).locator('td')).toHaveText(ZERO);
  });

  await test.step('drill through to the general ledger, where opening + movement = closing', async () => {
    // Reached by clicking the figure rather than by picking the account, so the
    // drill-through seam is exercised on the way to the fourth report.
    await page
      .getByRole('table', { name: 'Assets' })
      .getByRole('button', { name: 'Business checking' })
      .click();

    await expect(
      page.getByRole('heading', { level: 2, name: '1010 — Business checking' }),
    ).toBeVisible();

    const balances = page.getByRole('table', { name: 'Balances' });
    // Debits, credits, then balance — the third cell is the one B4 is about.
    await expect(
      rowIn(balances, /^Opening$/)
        .locator('td')
        .nth(2),
    ).toHaveText(ZERO);
    await expect(
      rowIn(balances, /^Movement$/)
        .locator('td')
        .nth(2),
    ).toHaveText(CASH);
    await expect(
      rowIn(balances, /^Closing$/)
        .locator('td')
        .nth(2),
    ).toHaveText(CASH);

    // One line per journal that touched the account: the consulting fee, the rent, the
    // supplies, and the reversal of the supplies.
    await expect(page.getByRole('table', { name: 'Entries' }).locator('tbody tr')).toHaveCount(4);
  });
});

interface SimpleEntry {
  readonly entryDate: string;
  readonly memo: string;
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly amount: string;
}

/**
 * A two-line entry, posted. The first entry is written out in the narrative because it is
 * the one carrying a contact and a tag; the rest differ only in their figures.
 */
async function postSimpleEntry(page: Page, entry: SimpleEntry): Promise<void> {
  await page.getByRole('button', { name: 'New entry' }).click();

  const draft = page.getByRole('region', { name: 'Journal entry draft' });
  await draft.getByLabel('Entry date').fill(entry.entryDate);
  await draft.getByLabel('Description').fill(entry.memo);

  await chooseInCombobox(page, 'Account, line 1', entry.debitAccount);
  await page.getByLabel('Debit, line 1').fill(entry.amount);
  await chooseInCombobox(page, 'Account, line 2', entry.creditAccount);
  await page.getByLabel('Credit, line 2').fill(entry.amount);

  await draft.getByRole('button', { name: 'Post entry' }).click();

  const posted = page.getByRole('region', { name: 'Posted journal entry' });
  await expect(posted.getByText('Posted to the ledger')).toBeVisible();
}
