import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import {
  chartByCode,
  chooseSelectOption,
  csvStatement,
  postJournal,
  seedBankAccount,
} from './support/banking';
import { chooseInCombobox, currentMonth, newRegistration } from './support/books';

/**
 * M4 — a statement is imported, matched, and reconciled, in a real browser (OB-090, D-26).
 *
 * ## What this test is for, and what it deliberately is not
 *
 * Every layer below the browser is proven elsewhere: the parser and the dedupe fingerprint by
 * the CSV suite, the ranking by the scoring property tests, the reconciliation arithmetic and
 * its finalise/reopen race by the banking module suites, the components by jsdom. What none of
 * them can say is that the seam holds — that a person clicking through import, match and
 * reconcile against a real Fastify app and a real MySQL ends with books that agree with the
 * bank. That is the only claim this file makes, which is why it is one narrative and not a
 * suite (D-26), exactly as `month-of-books.spec.ts` is for M1–M3.
 *
 * So the assertions are **figures**, read off the rendered page as text: the import counts, the
 * reconciliation's cleared balance, its difference reaching zero, the reconciling item that
 * does not block. Money is cents on the wire and a decimal only in the glyphs (D-13), so there
 * is no float to compare against here and there must not be one.
 *
 * ## The arithmetic, written down
 *
 * The bank ledger account is `1010`, opening at zero. Two entries are seeded before the
 * statement arrives (the API, not the point of this narrative — `support/banking.ts`):
 *
 * ```
 *   day  5   Dr 1010 Business checking 1500.00  Cr 4020 Service revenue  1500.00   ← the deposit,
 *                                                                                     already booked
 *   day 22   Dr 6080 Rent              100.00   Cr 1010 Business checking  100.00   ← a cheque the
 *                                                                                     bank has not shown
 * ```
 *
 * Then a three-line statement is imported and every line cleared:
 *
 * ```
 *   day  5   +1500.00  MERIDIAN CONSULTING     → linked to the day-5 entry (E3: a proposal, accepted)
 *   day 12   − 400.00  CITYWIDE OFFICE RENT    → coded to 6080 Rent
 *   day 18   − 250.00  PAPERWORKS SUPPLIES     → coded to 6060 Office supplies
 * ```
 *
 * which gives, against the session opened to the month end:
 *
 * ```
 *   cleared balance   0 + 1500 − 400 − 250 = 850.00       ← what the bank has processed
 *   statement closing 850.00                              ← what the statement claims
 *   difference        850.00 − 850.00 = 0.00              ← reaches zero, so it finalises (E5)
 *   book balance      1500 − 400 − 250 − 100 = 750.00     ← the ledger, cheque and all
 *   uncleared amount  750 − 850 = −100.00                 ← the cheque, a reconciling difference (D-50)
 * ```
 *
 * The unpresented cheque is the point of the second seeded entry: it leaves the difference at
 * zero — the account reconciles — while standing in the report as the one thing the bank has
 * not caught up with. A reconciliation that blocked on it, or that hid it, would be wrong in
 * opposite directions (D-50).
 *
 * ## Why the sub-screens are reached by deep link, not by clicking the tabs
 *
 * The banking section's tab bar (`screens/banking/index.tsx`) is a defect this narrative
 * surfaced: its `NavLink`s are relative (`to="import"`) and, under the section's `/banking/*`
 * splat with a `*`→`<Navigate to="match">` catch-all, a tab click resolves to
 * `/banking/match/import`, which the catch-all then rewrites forever —
 * `/banking/match/import/match/match/…` — until the tab OOM-crashes. Deep links to
 * `/banking/import`, `/banking/match` and `/banking/reconcile` resolve cleanly, so this test
 * reaches each screen that way (a bookmarkable URL is a real entry point) and exercises the
 * screen↔server seam it exists to test. The tab bug is reported separately; when it is fixed,
 * these `page.goto`s become tab clicks, and nothing else here changes.
 */

/** Displayed forms. Cents on the wire, decimals on screen, never a float (D-13). */
const INFLOW = '1500.00';
const RENT = '400.00';
const SUPPLIES = '250.00';
const CLEARED = '850.00';
const BOOK = '750.00';
const UNCLEARED = '-100.00';
const ZERO = '0.00';

/** The statement's three descriptions, verbatim — the handles the match rows are found by. */
const DEPOSIT = 'MERIDIAN CONSULTING';
const OFFICE_RENT = 'CITYWIDE OFFICE RENT';
const OFFICE_SUPPLIES = 'PAPERWORKS SUPPLIES';

const BANK_NAME = 'Everyday Checking';
/**
 * A partial of the bank name, typed into the pickers. `chooseInCombobox` asserts the
 * committed label differs from what was typed — proof the option was taken, not just
 * highlighted — so the query must be a prefix of the name, never the whole of it.
 */
const BANK_QUERY = 'Everyday';

test('a business imports a statement, matches it, and reconciles — and the figures tie', async ({
  page,
}) => {
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

    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chart of accounts' })).toBeVisible();
  });

  await test.step('apply the starter chart, so 1010, 4020, 6060 and 6080 exist', async () => {
    await expect(page.getByText('This organization has no accounts yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(page.getByRole('cell', { name: 'Business checking' })).toBeVisible();
  });

  await test.step('generate the fiscal year — nothing, clearing included, can post before it', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });

    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByText('Generated 12 periods')).toBeVisible();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  /**
   * The ledger the statement will reconcile against, put in place over the API (there is no
   * bank-account-creation screen, and re-posting journals in a browser is `month-of-books`'s
   * job — see `support/banking.ts`). Everything the browser then does is banking.
   */
  await test.step('seed the bank account and the two entries the statement meets', async () => {
    const chart = await chartByCode(page.request);
    const accountId = (code: string): string => {
      const id = chart.get(code);
      if (id === undefined) throw new Error(`The starter chart has no account ${code}.`);
      return id;
    };

    await seedBankAccount(page.request, {
      accountId: accountId('1010'),
      name: BANK_NAME,
      institutionName: 'Meridian Bank',
      externalAccountId: 'CHK-4471',
    });

    // The deposit, already booked: the day-5 statement line will link to this rather than
    // post a second copy of it (E3).
    await postJournal(page.request, {
      date: month.day(5),
      memo: 'Meridian consulting fee',
      lines: [
        { accountId: accountId('1010'), side: 'debit', amount: '150000' },
        { accountId: accountId('4020'), side: 'credit', amount: '150000' },
      ],
    });

    // The unpresented cheque: a real ledger movement on the account the bank has not shown,
    // so it is a reconciling difference at reconcile time and never a blocker (D-50).
    await postJournal(page.request, {
      date: month.day(22),
      memo: 'Rent deposit cheque — not yet presented',
      lines: [
        { accountId: accountId('6080'), side: 'debit', amount: '10000' },
        { accountId: accountId('1010'), side: 'credit', amount: '10000' },
      ],
    });
  });

  await test.step('import the statement, and read the counts off the page (E1)', async () => {
    // Deep-linked, not tabbed — the tab bar loops (see the header note).
    await page.goto('/banking/import');

    await chooseInCombobox(page, 'Bank account', BANK_QUERY);

    const statement = csvStatement([
      { date: month.day(5), description: DEPOSIT, amount: '1500.00' },
      { date: month.day(12), description: OFFICE_RENT, amount: '-400.00' },
      { date: month.day(18), description: OFFICE_SUPPLIES, amount: '-250.00' },
    ]);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'meridian-july.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(statement, 'utf8'),
    });

    // The three required columns; the delimiter, date order and amount convention are left at
    // their defaults, which this ISO/signed file is written to match.
    await chooseSelectOption(page, 'Posted date', 'Date');
    await chooseSelectOption(page, 'Description', 'Description');
    await chooseSelectOption(page, 'Amount', 'Amount');

    await page.getByRole('button', { name: 'Preview' }).click();

    // The preview parses the file and shows the rows before anything is written: the three
    // descriptions, their signed amounts, and no duplicate marker on a first upload (E1).
    const preview = page.getByRole('region', { name: 'Import preview' });
    await expect(preview.getByText(DEPOSIT)).toBeVisible();
    await expect(preview.getByText(OFFICE_RENT)).toBeVisible();
    await expect(preview.getByText(OFFICE_SUPPLIES)).toBeVisible();
    await expect(preview.getByText(INFLOW)).toBeVisible();
    await expect(preview.getByText(`-${RENT}`)).toBeVisible();
    await expect(preview.getByText('Already present')).toHaveCount(0);

    await page.getByRole('button', { name: 'Import', exact: true }).click();

    // The async import polled to completion, reporting its own final counts as one figure:
    // three new, none doubled (E1).
    await expect(page.getByText('Statement imported')).toBeVisible();
    await expect(page.getByText('3 imported, 0 already present (3 read).')).toBeVisible();
  });

  /**
   * Opened before a single line is matched, so the cleared balance can be watched moving to
   * the statement's claim as the lines clear (E5). At this point nothing is cleared, so the
   * difference is the whole statement.
   */
  await test.step('open a reconciliation to the month end, still the whole statement apart', async () => {
    await page.goto('/banking/reconcile');

    await chooseInCombobox(page, 'Bank account', BANK_QUERY);
    await page.getByRole('button', { name: 'Open reconciliation' }).click();

    const dialog = page.getByRole('dialog', { name: 'Open a reconciliation' });
    await dialog.getByLabel('Statement end date').fill(month.lastDay);
    await dialog.getByLabel('Statement closing balance').fill(CLEARED);
    await dialog.getByRole('button', { name: 'Open reconciliation' }).click();

    // The figure sits in a sibling cell of its label, both under the row `..`/`..` up from
    // the label span (`reconciliation/balances.tsx`'s `Figure`).
    // `exact`, because the Difference block's hint ("…minus cleared balance") would otherwise
    // match these labels too. The figure sits in a sibling cell of its label, both under the
    // row `..`/`..` up from the label span (`reconciliation/balances.tsx`'s `Figure`).
    const test1 = page.getByRole('region', { name: 'The reconciliation' });
    await expect(figure(test1, 'Cleared balance')).toContainText(ZERO);
    await expect(figure(test1, 'Statement closing balance')).toContainText(CLEARED);
    await expect(test1.getByText('Not reconciled yet')).toBeVisible();
  });

  await test.step('match: accept the proposal for the deposit, code the two payments (E3)', async () => {
    await page.goto('/banking/match');
    await chooseInCombobox(page, 'Bank account', BANK_QUERY);

    // The deposit is the one line the books already hold an entry for, so it is the one line
    // with a proposal: accept it, and it links to the day-5 journal rather than posting a
    // second one. Its Accept is the only one on the row.
    const depositRow = page.getByRole('group', { name: new RegExp(DEPOSIT) });
    await expect(depositRow).toBeVisible();
    await depositRow.getByRole('button', { name: /^Accept:/ }).click();
    // Cleared, so it leaves the "to match" list.
    await expect(page.getByRole('group', { name: new RegExp(DEPOSIT) })).toHaveCount(0);

    // The two payments resemble nothing in the books, so each is coded to the account it is —
    // the expense side of the entry the clearing posts.
    await codeLineTo(page, OFFICE_RENT, '6080');
    await codeLineTo(page, OFFICE_SUPPLIES, '6060');

    await expect(
      page.getByText('No uncleared lines. This statement is fully matched.'),
    ).toBeVisible();
  });

  await test.step('the cleared lines carry the clearing each got', async () => {
    await page.getByRole('tab', { name: 'Matched' }).click();
    const cleared = page.getByRole('list', { name: 'Cleared statement lines' });

    await expect(cleared.getByText('Linked to an existing entry')).toBeVisible();
    await expect(cleared.getByText('Coded to an account')).toHaveCount(2);
    await expect(cleared.getByText(INFLOW)).toBeVisible();
    await expect(cleared.getByText(`-${RENT}`)).toBeVisible();
    await expect(cleared.getByText(`-${SUPPLIES}`)).toBeVisible();
  });

  /**
   * Back on the reconciliation, the same session now reads differently: the cleared balance
   * has moved to the statement's figure, the difference is zero, and the cheque stands as the
   * one reconciling difference. The reconciliation cache is a separate root from matching's, so
   * re-selecting the session is what re-reads it (`reconciliation/queries.ts`).
   */
  await test.step('the cleared balance has reached the statement, difference zero (E5)', async () => {
    await page.goto('/banking/reconcile');
    await chooseInCombobox(page, 'Bank account', BANK_QUERY);
    await page.getByRole('button', { name: new RegExp('Open the reconciliation to') }).click();

    const test1 = page.getByRole('region', { name: 'The reconciliation' });
    await expect(figure(test1, 'Cleared balance')).toContainText(CLEARED);
    await expect(figure(test1, 'Statement closing balance')).toContainText(CLEARED);
    await expect(test1.getByText('Balanced')).toBeVisible();

    // The book balance carries the cheque; the difference does not — the cheque is a
    // reconciling difference, not a disagreement (D-50). No statement line is uncleared: the
    // gap is a book-side entry, not a line the bank showed and the books missed.
    const differences = page.getByRole('region', { name: 'Reconciling differences' });
    await expect(figure(differences, 'Book balance')).toContainText(BOOK);
    await expect(figure(differences, 'Uncleared amount')).toContainText(UNCLEARED);
    await expect(differences.getByText('0 uncleared lines')).toBeVisible();
  });

  await test.step('the report itemises the cheque, and it sums to the uncleared amount (D-50)', async () => {
    await page.getByRole('button', { name: 'Report' }).click();

    const items = page.getByRole('region', { name: 'Reconciling items' });
    // The one item is the cheque, dated day 22 and signed −100.00; scoped to its own row so
    // the same figure in the footer below is not a second match.
    const chequeRow = items.locator('tbody tr').filter({ hasText: month.day(22) });
    await expect(chequeRow).toContainText(UNCLEARED);
    await expect(items.getByText(/These sum to the uncleared amount/)).toContainText(UNCLEARED);

    // The statement side is empty: every line the bank showed has been matched into the books.
    const statementSide = page.getByRole('region', { name: 'Uncleared statement lines' });
    await expect(
      statementSide.getByText(
        'Every statement line in this window has been matched into the books.',
      ),
    ).toBeVisible();
  });

  await test.step('finalise — the assertion succeeds at difference zero (E5)', async () => {
    await page.getByRole('button', { name: 'Balances' }).click();
    await page.getByRole('button', { name: 'Finalise reconciliation' }).click();

    // The session flips to finalised, and the event log records the figure that was asserted.
    await expect(page.getByText('Finalised', { exact: true }).first()).toBeVisible();
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByText('Finalised')).toBeVisible();
    await expect(history.getByText(/Asserted/)).toContainText(CLEARED);
  });
});

/**
 * A `Figure` row in the balances panel, found by its exact label.
 *
 * `exact`, because several hints repeat a label verbatim ("Book balance minus cleared
 * balance"); the value sits in a sibling cell, so the row is two parents up from the label
 * span (`reconciliation/balances.tsx`).
 */
function figure(scope: Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator('../..');
}

/**
 * Code one uncleared line to an account, through the correct dialog.
 *
 * The two payments have no proposal — nothing in the books resembles them — so clearing them
 * is the "correct" path: open the line's dialog, pick the expense account by its code, and
 * post. On success the line leaves the "to match" list.
 */
async function codeLineTo(page: Page, description: string, accountCode: string): Promise<void> {
  const row = page.getByRole('group', { name: new RegExp(description) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Correct' }).click();

  const dialog = page.getByRole('dialog', { name: 'Correct this line' });
  await chooseInCombobox(page, 'Code to account', accountCode);
  await dialog.getByRole('button', { name: 'Code line' }).click();

  await expect(page.getByRole('group', { name: new RegExp(description) })).toHaveCount(0);
}
