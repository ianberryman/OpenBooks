import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chooseInCombobox, currentMonth, newRegistration } from './support/books';

/**
 * The accountant-access-and-close narrative (OB-199, initiative P; ROADMAP D-26, D-96,
 * D-97, D-98).
 *
 * P's claim is that an accountant is a granted user type layered over the existing
 * invite flow (D-96) rather than a separate product, and that a period close is a
 * workflow *over* the M1 period lock (D-97) rather than a second source of truth for
 * whether an entry may post. This is the one browser proof of both (D-26): an owner
 * grants the seeded `Accountant` role through the ordinary invite dialog, posts an
 * adjusting journal entry the audit trail flags as such (D-98), runs the advisory close
 * checklist and locks the period with a signed-off note, renders a branded statement
 * package over that same range, and reopens the period with a recorded reason — then
 * checks the audit trail again and finds both the close and the reopen sitting next to
 * the adjusting entry it already flagged.
 *
 * ## What this narrative does not claim
 *
 * It does not log in as the invited accountant. Accepting an emailed invite means taking
 * a token out of a self-host install's server log (`members.tsx`'s own words — the token
 * is a credential and is never returned to this screen), which is a second narrative's
 * worth of plumbing and not what P1 is about. The grant itself — that `Accountant` is
 * offered as an assignable role and that issuing the invite records it — is the
 * assertion; OB-198's permission matrix is where the *enforcement* the role carries is
 * proven, not a browser click as someone who holds it.
 */
test('an owner grants an accountant, who could then adjust, close, report on, and reopen a period', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const accountantEmail = `p-accountant-${randomUUID().slice(0, 8)}@openbooks.test`;

  // Depreciation expense (6030) against Accumulated depreciation (1590) — a contra-asset
  // pair in the "General small business" starter chart, and about as textbook an
  // adjusting entry as exists: nothing changed hands, a period-end estimate did.
  const DEBIT_ACCOUNT_CODE = '6030';
  const CREDIT_ACCOUNT_CODE = '1590';
  const AMOUNT = '250';

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

  await test.step('generate the fiscal year — the period the close below locks', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  await test.step('grant an accountant — invite someone and assign the Accountant role', async () => {
    const people = page.getByRole('region', { name: 'People' });
    await people.getByRole('button', { name: 'Invite someone' }).click();

    const dialog = page.getByRole('dialog', { name: 'Invite someone' });
    await dialog.getByLabel('Email address').fill(accountantEmail);
    await dialog.getByRole('combobox', { name: 'Role' }).click();
    // The role list is keyed by seeded name, and D-96's whole point is that this reads
    // "Accountant" here — a role an owner grants, not a separate product tier.
    await page.getByRole('option', { name: 'Accountant', exact: true }).click();
    await dialog.getByRole('button', { name: 'Send invitation' }).click();

    // Confirmation is the issued-invitation notice — "Invitation sent" if the install can
    // deliver mail, "Invitation created — no message went out" if it is running the log
    // provider (`members.tsx`'s own words); either way the title starts the same. Then
    // the invitations table, whose Role column renders `invitation.roleCode`
    // (`members.tsx`), the seeded role's code rather than its display name, so the row
    // reads the lower-case "accountant".
    await expect(page.getByText(/^Invitation (sent|created)/)).toBeVisible();

    const invites = page.getByRole('table', { name: 'Invitations' });
    const inviteRow = invites
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: accountantEmail, exact: true }) });
    await expect(inviteRow.getByText('accountant', { exact: true })).toBeVisible();
  });

  await test.step('post an adjusting entry — Depreciation expense against Accumulated depreciation', async () => {
    await page.getByRole('link', { name: 'Journal entry' }).click();
    await page.getByRole('button', { name: 'New entry' }).click();

    const draft = page.getByRole('region', { name: 'Journal entry draft' });
    await draft.getByLabel('Entry date').fill(month.day(15));
    await draft.getByLabel('Description').fill('Monthly depreciation');

    // The classification P4 asks the audit trail to flag (D-98) — a plain `Select`
    // (`draft-editor.tsx`), not the filterable chart-of-accounts combobox below it.
    await page.getByRole('combobox', { name: 'Entry type' }).click();
    await page.getByRole('option', { name: 'Adjusting', exact: true }).click();

    await chooseInCombobox(page, 'Account, line 1', DEBIT_ACCOUNT_CODE);
    await draft.getByLabel('Debit, line 1').fill(AMOUNT);
    await chooseInCombobox(page, 'Account, line 2', CREDIT_ACCOUNT_CODE);
    await draft.getByLabel('Credit, line 2').fill(AMOUNT);

    await draft.getByRole('button', { name: 'Save draft' }).click();
    await draft.getByRole('button', { name: 'Post entry' }).click();

    const posted = page.getByRole('region', { name: 'Posted journal entry' });
    await expect(posted.getByText('Posted to the ledger')).toBeVisible();
  });

  await test.step('the audit trail shows the entry, flagged as adjusting', async () => {
    await page.getByRole('link', { name: 'Reports' }).click();
    await page
      .getByRole('group', { name: 'Report' })
      .getByRole('button', { name: 'Audit' })
      .click();
    await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();

    const trail = page.getByRole('table', { name: 'Audit trail' });
    // `journalSummary` (`audit.repository.ts`) renders "Adjusting entry #<sequence>", and
    // `EntryRow` (`reports/audit.tsx`) appends a badge whose own text is exactly
    // "Adjusting" — the summary text alone would also contain that substring, so the
    // exact match below targets the badge and not a coincidental prefix of the summary.
    const row = trail.getByRole('row').filter({ hasText: /Adjusting entry/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('Adjusting', { exact: true })).toBeVisible();
  });

  await test.step('run the close checklist and close the period with a sign-off note', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    const periodRow = periods
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: month.periodName, exact: true }) });

    await periodRow.getByRole('button', { name: 'Close' }).click();

    const closeDialog = page.getByRole('dialog', { name: `Close ${month.periodName}` });
    // Three advisory checks (`period-close.service.ts`), and none of them ever blocks a
    // close — D-97 is advisory, not a fourth 'fail' status. A brand-new org with nothing
    // posted as an unfinished draft and no bank data imported reads the first two as a
    // pass unconditionally.
    for (const label of [
      'Unposted journal drafts dated in this period',
      'Unreconciled bank statement lines in this period',
    ]) {
      const check = closeDialog.getByRole('listitem').filter({ hasText: label });
      await expect(check).toContainText('Pass');
    }
    // The third — "prior period is closed" — is a pure calendar lookup
    // (`selectPriorPeriod`): the immediately preceding month's row, regardless of which
    // `POST /v1/fiscal-years` call generated it. "Generate 12 periods" makes the whole
    // fiscal year at once, so unless this happens to run in the org's fiscal-year-start
    // month (no prior row exists yet — a pass by the "nothing to check" branch), the
    // previous calendar month is sitting there Open and this reads a warning. Either way
    // is D-97's point: a warning here is exactly what the sign-off below is for, so this
    // step asserts the row is present rather than pinning a status a run in January and a
    // run in July would legitimately disagree about.
    await expect(
      closeDialog.getByRole('listitem').filter({ hasText: 'Prior fiscal period is closed' }),
    ).toBeVisible();

    await closeDialog.getByLabel('Sign-off note (optional)').fill('Depreciation posted; reviewed.');
    await closeDialog.getByRole('button', { name: 'Close period' }).click();

    await expect(periodRow.getByText('Closed', { exact: true })).toBeVisible();
  });

  await test.step('render a statement package for the closed period', async () => {
    await page.getByRole('link', { name: 'Statement packages' }).click();
    await expect(page.getByRole('heading', { name: 'Statement packages' })).toBeVisible();

    await page.getByLabel('Period start').fill(month.firstDay);
    await page.getByLabel('Period end').fill(month.lastDay);
    await page.getByRole('combobox', { name: 'Basis' }).click();
    await page.getByRole('option', { name: 'Accrual', exact: true }).click();
    await page.getByRole('button', { name: 'Generate package' }).click();

    const packages = page.getByRole('table', { name: /Rendered statement packages/ });
    await expect(packages.getByRole('link', { name: 'Download PDF' }).first()).toBeVisible();
  });

  await test.step('reopen the period with a reason', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });
    const periodRow = periods
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: month.periodName, exact: true }) });

    await periodRow.getByRole('button', { name: 'Reopen' }).click();

    const reopenDialog = page.getByRole('dialog', { name: `Reopen ${month.periodName}` });
    await reopenDialog
      .getByLabel('Reason (optional)')
      .fill('Client requested a correction before filing.');
    await reopenDialog.getByRole('button', { name: 'Reopen period' }).click();

    await expect(periodRow.getByText('Open', { exact: true })).toBeVisible();
  });

  await test.step('the audit trail now also shows the close and the reopen', async () => {
    await page.getByRole('link', { name: 'Reports' }).click();
    await page
      .getByRole('group', { name: 'Report' })
      .getByRole('button', { name: 'Audit' })
      .click();

    // `toPeriodCloseAuditRow` (`audit.repository.ts`) renders "Closed <period name>" and
    // "Reopened <period name>" verbatim, where the period name is the same
    // `fiscal_periods.name` the periods table and this narrative's `month.periodName`
    // both already read.
    const trail = page.getByRole('table', { name: 'Audit trail' });
    await expect(trail.getByText(`Closed ${month.periodName}`, { exact: true })).toBeVisible();
    await expect(trail.getByText(`Reopened ${month.periodName}`, { exact: true })).toBeVisible();
  });
});
