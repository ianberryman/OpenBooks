import { expect, test } from '@playwright/test';

import { chooseInCombobox, currentMonth, newRegistration } from './support/books';

/**
 * The OCR bill-capture narrative (OB-191; ROADMAP D-26 — one run of user intent).
 *
 * A bookkeeper receiving a vendor bill by hand does not want to re-type it into a purchases
 * form: they want to hand the document to the system and check its work. OB-189 built the
 * screen for that — upload (or forward) a document, let extraction read it, review what it
 * found, and turn it into a draft bill in `purchases` — sitting on top of the extraction
 * pipeline `deterministic.ts` already proves headless. This is that screen's one browser
 * proof: register, put a vendor in Contacts, upload a bill whose bytes are the deterministic
 * `key: value` format extraction understands, wait for it to settle to matched and ready for
 * review (the `extracting` state is momentary under the in-process queue, so it is the
 * settled state that is asserted), confirm the match and post an expense account, create the
 * draft, and
 * find that exact draft sitting in Purchases afterwards.
 *
 * ## What this narrative does not claim
 *
 * Nothing here reaches the ledger. `createDraftFromCapture` returns a `draft` bill — D-38's
 * status, unposted — exactly as `purchases`' own "New bill" would (`bill-captures.tsx`'s own
 * comment: "It does not post anything to the ledger"), and finding that draft on the
 * Purchases screen is the whole proof this narrative is built to give; approving it is
 * `purchases`' own story, told by `month-of-books.spec.ts` for an entry typed by hand rather
 * than extracted.
 *
 * Extraction itself runs on the server's in-process job queue after the upload response
 * returns (`capture.service.ts` stages the capture as `extracting` before the job that reads
 * it has run), so there is no HTTP-observable "extraction is done" signal for a browser test
 * to await in-page. `page.reload()` is the deterministic way to force the review queue's
 * TanStack query to refetch; reloading also resets this screen's own `status` filter state
 * back to its default (`extracted`, "Needs review"), which happens to be exactly the signal
 * this narrative is waiting for — so the reload is both the trigger and, once the row
 * appears filtered to that status, the proof.
 */

const VENDOR = 'Acme Supplies';
const REFERENCE = 'INV-88012';
// Professional fees (`chart-templates.ts`'s general small-business chart) is the expense
// account a consulting bill posts to — read off the template rather than guessed.
const EXPENSE_ACCOUNT_CODE = '6070';

function bill(text: string): { name: string; mimeType: string; buffer: Buffer } {
  // `mimeType` names a PDF because that is the format a bill actually arrives in, but
  // `deterministic.ts`'s own doc-comment says the adapter reads the bytes as UTF-8 text
  // regardless of the declared type — this is what makes a plain-text fixture a working E2E
  // input for a screen whose real documents are scanned PDFs.
  return { name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from(text, 'utf-8') };
}

test('a bill is captured, extracted, reviewed and turned into a draft bill in Purchases', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const billDate = month.day(15);

  const BILL_TEXT = `
vendor: ${VENDOR}
date: ${billDate}
reference: ${REFERENCE}
line: Consulting | 1 | 120000
`;

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

  await test.step('apply the starter chart, for the expense account the reviewed line will post to', async () => {
    // D-23: a fresh org holds no accounts until this is opted into, so this is the wall
    // between "registered" and "can pick an expense account in the review dialog".
    await expect(page.getByText('This organization has no accounts yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(page.getByText('that is the whole chart')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Professional fees' })).toBeVisible();
  });

  await test.step('add the vendor the bill is from, so extraction has a contact to match', async () => {
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.getByRole('button', { name: 'New contact' }).click();

    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByLabel('Name', { exact: true }).fill(VENDOR);
    await dialog.getByLabel('Code').fill('VEND-101');
    await dialog.getByLabel('Vendor').check();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('cell', { name: VENDOR, exact: true })).toBeVisible();
  });

  await test.step('upload the bill for extraction', async () => {
    await page.getByRole('link', { name: 'Bill capture' }).click();
    await expect(page.getByRole('heading', { name: 'Bill captures' })).toBeVisible();

    // The hidden native file input carries the accessible name — the visible "Upload a
    // bill" button only opens it — exactly the `setInputFiles`-on-`getByLabel` pattern
    // `quickbooks-import.spec.ts` uses for its three CSV exports.
    await page.getByLabel('Bill file').setInputFiles(bill(BILL_TEXT));

    // The transient `extracting` state is deliberately not asserted. With
    // QUEUE_PROVIDER=in-process and the deterministic extraction provider (the e2e
    // defaults), the capture settles to `extracted` synchronously-fast inside the API
    // process — the same event-loop turn — so 'Extracting…' is not reliably observable in
    // the browser, which only refetches on the upload's success and on a filter change.
    // The next step reloads and asserts the settled 'Needs review' state; that is what
    // proves the capture was created, extracted and vendor-matched.
  });

  await test.step('wait for extraction to settle, then find the matched vendor in the review queue', async () => {
    // See the file header: a reload is what forces the query to refetch, and it also
    // resets the Status filter to its default (`extracted`), which is the state this step
    // is waiting to observe — so the same reload is the trigger and the retry.
    const matched = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: VENDOR, exact: true }) });

    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Bill captures' })).toBeVisible();
      await expect(matched.getByText('Needs review')).toBeVisible();
    }).toPass({ timeout: 15_000 });
  });

  await test.step('review the extracted capture and create a draft bill', async () => {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: VENDOR, exact: true }) });
    await row.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog', { name: 'Review captured bill' });

    // Pre-selected: extraction resolved exactly one active vendor contact whose name
    // matched the document (`extraction.job.ts`'s `resolveVendorMatch`), so this confirms
    // the match rather than performing it.
    await expect(dialog.getByRole('combobox', { name: 'Vendor' })).toHaveValue(VENDOR);
    await expect(dialog.getByLabel('Vendor’s invoice number')).toHaveValue(REFERENCE);
    await expect(dialog.getByLabel('Issue date')).toHaveValue(billDate);
    await expect(dialog.getByLabel('Description, line 1')).toHaveValue('Consulting');

    // Extraction reads a description, a quantity and an amount, but never a chart-of-
    // accounts posting (`review-state.ts`'s `stateFromCapture` comment), so the expense
    // account is the one thing review must add before the line is sendable.
    await chooseInCombobox(page, 'Expense account, line 1', EXPENSE_ACCOUNT_CODE);

    await dialog.getByRole('button', { name: 'Create draft bill' }).click();

    const done = page.getByRole('status').filter({ hasText: 'Draft bill created' });
    await expect(done).toBeVisible();
    await expect(done.getByText(REFERENCE)).toBeVisible();
  });

  await test.step('the draft bill exists in Purchases, unposted', async () => {
    await page.getByRole('link', { name: 'Purchases', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Purchases' })).toBeVisible();

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: VENDOR, exact: true }) });

    // Columns, in order (`document-list.tsx`): our number, the vendor's number, vendor,
    // issued, due, status, total, outstanding. "Draft" appears twice on this row for two
    // different reasons — no number is allocated until approval (D-36, D-38), so the
    // number column reads "Draft" too, same as the status pill — which is exactly why the
    // columns are read by position rather than by a single ambiguous text match.
    const cells = row.locator('td');
    await expect(cells.nth(0)).toHaveText('Draft');
    await expect(cells.nth(1)).toHaveText(REFERENCE);
    await expect(cells.nth(5)).toHaveText('Draft');
  });
});
