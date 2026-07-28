import { expect, test } from '@playwright/test';

import { chooseInCombobox, currentMonth, newRegistration } from './support/books';

/**
 * The cash-basis narrative (OB-161, K) — the milestone's browser proof, one long run of
 * user intent, as D-26 asks: a single narrative rather than a suite.
 *
 * The claim it verifies is the one most customers depend on daily: the same invoice,
 * only half paid, is full revenue on the accrual books and half on cash. It sets up an
 * org, raises and approves an invoice, receives a partial payment against it, then opens
 * the profit and loss and toggles the basis — accrual shows the whole invoice recognised
 * at approval, cash shows only what has actually been received.
 */
test('a cash-basis filer sees only the revenue that has been paid', async ({ page }) => {
  const registration = newRegistration();
  const month = currentMonth();
  const CUSTOMER = 'Northwind Traders';

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

  await test.step('generate the fiscal year — nothing can be posted before this', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  // The starter chart nominates the receivable and payable control accounts itself
  // (chart-templates.service.ts), so nothing sets them by hand — an invoice can post.

  await test.step('add the customer the invoice names', async () => {
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByLabel('Name', { exact: true }).fill(CUSTOMER);
    await dialog.getByLabel('Code').fill('CUST-001');
    await dialog.getByLabel('Customer').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('cell', { name: CUSTOMER, exact: true })).toBeVisible();
  });

  await test.step('raise and approve a 1,000.00 invoice', async () => {
    await page.getByRole('link', { name: 'Sales' }).click();
    await page.getByRole('button', { name: 'New invoice' }).click();

    // "New invoice" creates a draft for the only customer, so the editor opens with the
    // customer already set — nothing to choose here.
    const draft = page.getByRole('region', { name: /invoice draft/i });
    // A sales line needs all four of description, quantity, unit price and account, or the
    // editor drops it as half-typed before it ever reaches the wire (document-state.ts's
    // `toRequestLine`). A journal line has no such requirement, which is why `month-of-books`
    // never fills a description — an invoice must.
    await draft.getByLabel('Description, line 1').fill('Consulting');
    await draft.getByLabel('Quantity, line 1').fill('1');
    await draft.getByLabel('Unit price, line 1').fill('1000');

    // The account combobox opens showing the whole chart; typing filters it. `chooseInCombobox`
    // clicks, types the code, waits for the one match, and commits it.
    await chooseInCombobox(page, 'Account, line 1', '4020');

    // The document is repriced on the server at save, so the net/total are 0 until then.
    await draft.getByRole('button', { name: 'Save draft' }).click();
    await expect(draft.getByText('All changes saved')).toBeVisible();

    await draft.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    // Approval allocates the number and posts the journal; the first invoice in a fresh org
    // is number 1. The read-only posted view names its region "Invoice 1" — a draft's region
    // is "Invoice draft", so this alone proves the journal was posted.
    await expect(page.getByRole('region', { name: 'Invoice 1' })).toBeVisible();
  });

  await test.step('receive 400.00 against it, applied to the invoice — a partial payment', async () => {
    await page.getByRole('link', { name: 'Money' }).click();
    await page.getByRole('button', { name: /Record payment|Receive/ }).click();

    const dialog = page.getByRole('dialog', { name: /payment/i });
    // A partial of the name, not the whole of it: `chooseInCombobox` proves the option was
    // taken by asserting the committed label differs from what was typed, so the query must
    // be a substring — "Northwind" filters to the one contact and commits "Northwind Traders".
    await chooseInCombobox(page, 'Contact', 'Northwind');
    await dialog.getByLabel('Amount', { exact: true }).fill('400');
    await chooseInCombobox(page, 'Account', '1010');

    // Apply the 400 to the invoice. A payment left unapplied is a receipt that settles no
    // invoice — cash basis recognises nothing from it and flags it for review (K3) — so the
    // whole claim of this narrative rests on the allocation being made here, not merely on the
    // cash arriving. "Choose documents" unlocks once the contact is set and lists their open
    // invoices; there is exactly one.
    await dialog.getByRole('button', { name: 'Choose documents' }).click();
    await dialog.getByLabel(/Amount to apply to/).fill('400');

    await dialog.getByRole('button', { name: 'Record payment' }).click();
  });

  await test.step('the accrual P&L shows the whole invoice; the cash P&L only the 400', async () => {
    await page.getByRole('link', { name: 'Reports' }).click();
    await page.getByRole('button', { name: 'Profit and loss' }).click();

    // Accrual: the invoice was recognised in full at approval. Amounts are formatted without a
    // thousands separator (`1000.00`), and the value repeats down the column, so the assertion
    // anchors on the unambiguous "Total revenue" row rather than a bare cell.
    await expect(page.getByText('Accrual basis')).toBeVisible();
    await expect(page.getByRole('row', { name: 'Total revenue 1000.00' })).toBeVisible();

    // Toggle to cash — the Basis control is a hand-built combobox, not a native select, so
    // it opens and its option is chosen rather than `selectOption`-ed.
    await page.getByRole('combobox', { name: 'Basis' }).click();
    await page.getByRole('option', { name: 'Cash' }).click();

    // Only the 400.00 received is revenue; the full 1000.00 is gone from the statement entirely.
    await expect(page.getByText('Cash basis')).toBeVisible();
    await expect(page.getByRole('row', { name: 'Total revenue 400.00' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1000.00' })).toHaveCount(0);
  });
});
