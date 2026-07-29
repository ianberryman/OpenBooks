import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chooseInCombobox, currentMonth, newRegistration } from './support/books';

/**
 * The Phase 4 narrative — recurring invoices and dunning (OB-128/129/130/132/133;
 * ROADMAP D-26, D-75, D-76).
 *
 * A subscription business does not want to raise the same invoice by hand every month, and
 * it does not want to remember to chase every customer who lets one go overdue. Phase 4
 * builds the two engines that replace both chores — a template the scheduler turns into an
 * ordinary invoice each cycle, and a ladder of reminders the same scheduler walks once a
 * document falls overdue — and this is their one browser proof (D-26): register, build a
 * template due today, pause and resume it, run the scheduler the way the daily tick would,
 * and build a dunning ladder with a gentle stage before the due date and a firmer one after
 * it.
 *
 * ## What this narrative does not claim
 *
 * Materialisation itself is not observed here as a document landing on the Sales screen.
 * `POST /v1/scheduling/run-due-work` enqueues the same sweep the daily tick fires onto the
 * self-host in-process queue (`packages/server/src/providers/queue/in-process.ts`), whose
 * own commentary says a job "runs on a later turn of the event loop" and the route resolves
 * once it is *enqueued*, not once it has *run* — there is no HTTP-observable "settled"
 * signal for a browser test to wait on. Asserting an invoice into existence off the back of
 * that would mean inventing a reload/retry loop this suite uses nowhere else, in a file
 * `playwright.config.ts` deliberately runs with zero retries so that a pass means "this ran"
 * and not "this usually runs" (its own comment on `retries: 0`). So this narrative proves
 * exactly what the contract promises instead: the trigger route answers 200 and names the
 * date it enqueued the sweep for. See the `// ORCHESTRATOR:` comment at that step.
 */

const CUSTOMER = 'Harbor Consulting';
const TEMPLATE_NAME = 'Monthly consulting retainer';
const POLICY_NAME = 'Standard 2-stage chase';

test('a recurring-invoice template is built and scheduled, and a dunning ladder is built to chase what falls overdue', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  // Today, so the template's first cycle is due the moment the scheduler is asked to run —
  // the only way to prove "due" without waiting for a real calendar day to pass.
  const todayIso = month.day(new Date().getDate());

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

  await test.step('apply the starter chart, for the income account a template line will credit', async () => {
    // D-23: a fresh org holds no accounts until this is opted into by hand, so this is the
    // first wall between "registered" and "can build anything that names an account" — the
    // recurring-invoice line below needs a revenue account to exist before it can pick one.
    await expect(page.getByText('This organization has no accounts yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(page.getByText('that is the whole chart')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Service revenue' })).toBeVisible();
  });

  await test.step('add the customer the template bills, and the invoice each cycle will be for', async () => {
    await page.getByRole('link', { name: 'Contacts' }).click();
    await page.getByRole('button', { name: 'New contact' }).click();

    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByLabel('Name', { exact: true }).fill(CUSTOMER);
    await dialog.getByLabel('Code').fill('CUST-101');
    await dialog.getByLabel('Customer').check();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('cell', { name: CUSTOMER, exact: true })).toBeVisible();
  });

  await test.step('build a monthly recurring-invoice template, due today', async () => {
    await page.getByRole('link', { name: 'Recurring invoices' }).click();
    await expect(page.getByRole('heading', { name: 'Recurring invoices' })).toBeVisible();

    await page.getByRole('button', { name: 'New recurring invoice' }).click();
    const dialog = page.getByRole('dialog', { name: 'New recurring invoice' });

    await chooseInCombobox(page, 'Customer', CUSTOMER);
    await dialog.getByLabel('Name', { exact: true }).fill(TEMPLATE_NAME);
    // Frequency defaults to monthly with an interval of 1 — exactly the cadence this
    // template wants (`vocabulary.ts`'s `cadenceLabel` renders that pair as "Monthly"), so
    // neither the Frequency nor the Every control is touched.
    await dialog.getByLabel('Due days').fill('5');
    // `startDate` is create-only (`template-form.tsx`'s own reason: it seeds `nextRunDate`
    // once and the field is gone from then on), and today is the one value that makes the
    // first cycle due the moment the scheduler is asked to run it.
    await dialog.getByLabel('Start date').fill(todayIso);

    await dialog.getByLabel('Description, line 1').fill('Retainer services');
    await dialog.getByLabel('Quantity, line 1').fill('1');
    await dialog.getByLabel('Unit price, line 1').fill('500.00');
    await chooseInCombobox(page, 'Income account, line 1', '4020');
    // Tax rate is left at "No tax" — D-35's default is never a rate nobody chose.

    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: TEMPLATE_NAME, exact: true }) });
    await expect(row.getByText('Monthly', { exact: true })).toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
  });

  await test.step('pause it, then resume it — the reversible toggle, not the retire door', async () => {
    // The list defaults to "Active only" (`recurring-invoices.tsx`'s own `filter` state), so
    // a paused template would vanish from view the instant it is paused unless the filter is
    // widened first — this is not the same list a moment ago, it is the same query re-run.
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Active and paused' }).click();

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: TEMPLATE_NAME, exact: true }) });

    await row.getByRole('button', { name: `Pause ${TEMPLATE_NAME}` }).click();
    await expect(row.getByText('Paused', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: `Resume ${TEMPLATE_NAME}` }).click();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
  });

  await test.step('run the scheduler now, the same fan-out the daily tick performs unattended', async () => {
    // ORCHESTRATOR: there is no button for this — `dunning.tsx`'s own comment says the API
    // publishes no "send now" route, and materialisation is the same story: the only door is
    // this manual trigger, which enqueues rather than runs synchronously (see the file
    // header). So this step proves the one thing the contract actually guarantees — a 200
    // naming the date the sweep was enqueued for — and stops short of asserting that
    // Harbor Consulting's invoice has landed on the Sales screen by the time the assertion
    // runs. Confirming that materialisation really produced a Sales-visible invoice needs
    // either a deterministic completion signal added to this route, or a component/
    // integration test against `materializeCycle` directly (`modules/invoicing/recurring/
    // engine.ts`), not a browser poll bolted onto a suite that runs with zero retries.
    const response = await page.request.post('/v1/scheduling/run-due-work', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {},
    });
    expect(
      response.ok(),
      `POST /v1/scheduling/run-due-work → ${String(response.status())}`,
    ).toBeTruthy();

    const body = (await response.json()) as { runDate: string };
    expect(body.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  await test.step('build a dunning policy — a gentle reminder before the due date, a firmer chase after it', async () => {
    await page.getByRole('link', { name: 'Dunning' }).click();
    await expect(page.getByRole('heading', { name: 'Dunning' })).toBeVisible();

    await page.getByRole('button', { name: 'New policy' }).click();
    const dialog = page.getByRole('dialog', { name: 'New policy' });

    await dialog.getByLabel('Name').fill(POLICY_NAME);

    // Stage 1: two days before the due date — `offsetDays` is signed and relative to it
    // (`stage-editor.tsx`'s own hint: "Negative is before it, 0 is on it, positive is
    // after"), so a small negative number is the gentle nudge.
    const stage1 = dialog.getByRole('listitem').filter({ hasText: 'Stage 1' });
    await stage1.getByLabel('Send offset').fill('-2');
    await stage1.getByLabel('Subject').fill('Friendly reminder — invoice due soon');
    await stage1
      .getByLabel('Body')
      .fill('This is a friendly reminder that your invoice is due soon. Thank you.');

    // Stage 2: ten days after the due date, firmer, and carrying a late fee this rung is the
    // one the policy escalates to.
    await dialog.getByRole('button', { name: 'Add stage' }).click();
    const stage2 = dialog.getByRole('listitem').filter({ hasText: 'Stage 2' });
    await stage2.getByLabel('Send offset').fill('10');
    await stage2.getByLabel('Subject').fill('Second notice — payment overdue');
    await stage2
      .getByLabel('Body')
      .fill('Your invoice is now overdue. Please arrange payment as soon as possible.');
    await stage2.getByLabel('Late fee').fill('25.00');

    await dialog.getByRole('button', { name: 'Create policy' }).click();

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: POLICY_NAME, exact: true }) });
    await expect(row.getByText('2 stages', { exact: true })).toBeVisible();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
  });
});
