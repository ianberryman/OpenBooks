import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { chooseInCombobox, currentMonth, newRegistration, reportDate } from './support/books';

/**
 * Initiative R (D-125) — the mobile smoke narrative, and the only spec that runs in the
 * `mobile` Playwright project (iPhone 13, ~390px). The fifteen milestone narratives are
 * desktop by design — their wide-table figure assertions are layout at a phone width — so
 * this is not a sixteenth of the same kind. It proves one thing the desktop suite cannot:
 * that the responsive shell holds up at phone width. Register, drive the nav *drawer*, post
 * a journal, read a report, and at every stop assert the body never scrolls sideways — the
 * acceptance bar for the whole initiative.
 *
 * It shares the `support/books` vocabulary with `month-of-books`, because the accounting is
 * the same books; what differs is the viewport and the drawer, which is exactly what this
 * spec is for.
 */

const AMOUNT = '1500.00';

/**
 * Reach a destination the way a phone user must: the static sidebar is `display:none` below
 * `md`, so navigation is the hamburger → drawer → link, and following the link closes the
 * drawer (D-122). Waiting for the drawer to disappear matters — the next step would
 * otherwise click through a closing scrim.
 */
async function navigateVia(page: Page, link: string): Promise<void> {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'OpenBooks' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: link }).click();
  await expect(drawer).toBeHidden();
}

/**
 * The initiative's headline promise: no horizontal `<body>` scroll at phone width. A wide
 * table is *allowed* to scroll inside its own `ResponsiveTable` wrapper (D-123); what must
 * not happen is a region's own content forcing the region sideways.
 *
 * So this measures the actual scroll regions — the fixed chrome (`<header>`) and the content
 * scroller (`#main`) — and asserts neither overflows its own width. It deliberately does
 * **not** measure `document.scrollingElement.scrollWidth`: under Chromium's mobile emulation
 * that value aggregates the scrollWidth of *contained* horizontal scrollers (the wide table
 * inside its wrapper), reporting a body overflow the user cannot actually perform — verified
 * against `window.scrollX`, which stays 0. A region whose *own* `scrollWidth` exceeds its
 * `clientWidth` is the real defect: an un-wrapped wide element, or chrome that will not
 * shrink, pushing the page sideways (the header org-switcher was exactly that, and this
 * check catches it). The callback is typed through `globalThis` because this package's
 * tsconfig carries no DOM lib on purpose.
 */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    type Region = { readonly scrollWidth: number; readonly clientWidth: number };
    const { document: doc } = globalThis as unknown as {
      document: { querySelector: (s: string) => Region | null };
    };
    let worst = 0;
    for (const selector of ['header', '#main']) {
      const region = doc.querySelector(selector);
      if (region !== null) worst = Math.max(worst, region.scrollWidth - region.clientWidth);
    }
    return worst;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

test('the responsive shell keeps a set of books on a phone-sized viewport', async ({ page }) => {
  const registration = newRegistration();
  const month = currentMonth();

  await test.step('register on a narrow viewport', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account instead' }).click();

    await page.getByLabel('Your name').fill(registration.displayName);
    await page.getByLabel('Email').fill(registration.email);
    await page.getByLabel('Password').fill(registration.password);
    await page.getByLabel('Organization name').fill(registration.orgName);
    await page.getByRole('button', { name: 'Create account' }).click();

    // The nav is a drawer here, not a sidebar: the hamburger is the only nav affordance and
    // the static Primary sidebar is hidden below md, so the desktop suite's
    // `navigation, name: Primary` visibility check would fail — this is what replaces it.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chart of accounts' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  await test.step('the sidebar is a drawer: it opens, traps into a dialog, and closes', async () => {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'OpenBooks' });
    await expect(drawer.getByRole('link', { name: 'Settings' })).toBeVisible();

    // Closes on its own control and on Escape (Radix gives both); prove the explicit close
    // once, then lean on link-following to close it for the rest of the run.
    await drawer.getByRole('button', { name: 'Close navigation' }).click();
    await expect(drawer).toBeHidden();
  });

  await test.step('apply the starter chart (no navigation — it is the landing screen)', async () => {
    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Business checking' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  await test.step('generate the fiscal year, reached through the drawer', async () => {
    await navigateVia(page, 'Settings');
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  await test.step('post a journal, reached through the drawer', async () => {
    await navigateVia(page, 'Journal entry');
    await page.getByRole('button', { name: 'New entry' }).click();

    const draft = page.getByRole('region', { name: 'Journal entry draft' });
    await draft.getByLabel('Entry date').fill(month.day(5));
    await draft.getByLabel('Description').fill('Consulting fee');

    // The line grid is wider than the phone; it scrolls inside its ResponsiveTable wrapper,
    // and the labelled controls stay reachable — which is what makes the entry postable here.
    await chooseInCombobox(page, 'Account, line 1', '1010');
    await page.getByLabel('Debit, line 1').fill(AMOUNT);
    await chooseInCombobox(page, 'Account, line 2', '4020');
    await page.getByLabel('Credit, line 2').fill(AMOUNT);

    await draft.getByRole('button', { name: 'Post entry' }).click();

    const posted = page.getByRole('region', { name: 'Posted journal entry' });
    await expect(posted.getByText('Posted to the ledger')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  await test.step('read the trial balance, reached through the drawer', async () => {
    await navigateVia(page, 'Reports');
    await reportDate(page, 'As at').fill(month.lastDay);

    const table = page.getByRole('table', { name: 'Trial balance' });
    const row = (code: string): ReturnType<Page['locator']> =>
      table.locator('tbody tr').filter({ hasText: new RegExp(`^${code}`) });

    // `balance` is debits − credits whatever the account's normal side, so cash reads
    // positive and revenue negative — the same figures the desktop narrative reads, proving
    // the report is correct and legible at phone width, not merely present.
    await expect(row('1010').locator('td').nth(2)).toHaveText(AMOUNT);
    await expect(row('4020').locator('td').nth(2)).toHaveText(`-${AMOUNT}`);

    // The report is wider than 390px; the body still does not scroll sideways — the table
    // scrolls inside its own wrapper (D-123).
    await expectNoHorizontalScroll(page);
  });
});
