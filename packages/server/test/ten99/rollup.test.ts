import { describe, expect, it } from 'vitest';

import type { Ten99Run, Ten99Worksheet } from '@openbooks/shared-types';

import type { Session } from '../transport/v1-support';
import { authorizedWrite, createAccount, registerUser, useV1App } from '../transport/v1-support';

/**
 * The 1099 worksheet rollup and TIN handling, the load-bearing correctness of OB-228
 * (D-228-2/4). The happy path — a paid vendor over threshold becoming a filed form — is
 * exercised end-to-end by `cross-org.test.ts`'s owner control pass; this suite pins the
 * edges a wrong-numbers 1099 turns on:
 *
 * - the **$600 threshold** boundary (`meetsThreshold` at exactly the threshold);
 * - **cash-basis, calendar-year**: a payment dated outside the tax year does not count;
 * - a **voided** payment does not count (it never moved cash);
 * - the **TIN never crosses the wire in full** — only `taxIdLast4` is read back (D-228-2);
 * - **generate snapshots the worksheet**: the filed amount equals the reviewed amount.
 *
 * All through HTTP (`useV1App`), spec §11's real-stack discipline. The DB resets per test
 * (`harness.ts`'s `beforeEach`), so each test builds its own org, vendor and payments.
 */
const harness = useV1App();

const YEAR = 2026;

interface Fixture {
  readonly owner: Session;
  readonly cashId: string;
  readonly vendorId: string;
}

/** A fresh org with a cash account, an open fiscal year, and one eligible 1099 vendor with a TIN. */
async function setup(nonce: string): Promise<Fixture> {
  const app = harness.app();
  const owner = await registerUser(app, {
    email: `ten99-${nonce}@example.invalid`,
    orgName: `Ten99 ${nonce}`,
  });
  const cashId = await createAccount(app, owner, {
    code: '1000',
    name: 'Cash',
    type: 'asset',
    normalBalance: 'debit',
  });
  // A money-out payment posts to the AP control account, so it must be nominated first.
  const payableId = await createAccount(app, owner, {
    code: '2000',
    name: 'Accounts payable',
    type: 'liability',
    normalBalance: 'credit',
  });
  const settings = await app.inject({
    method: 'PATCH',
    url: '/v1/accounting-settings',
    headers: authorizedWrite(owner, `settings-${nonce}`),
    payload: { payableControlAccountId: payableId },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  const year = await app.inject({
    method: 'POST',
    url: '/v1/fiscal-years',
    headers: authorizedWrite(owner, `year-${nonce}`),
    payload: { fiscalYear: YEAR },
  });
  expect(year.statusCode, year.body).toBe(201);

  const created = await app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: authorizedWrite(owner, `vendor-${nonce}`),
    payload: { displayName: 'Acme Contractor', isVendor: true },
  });
  expect(created.statusCode, created.body).toBe(201);
  const vendorId = created.json<{ id: string }>().id;

  const profile = await app.inject({
    method: 'PUT',
    url: `/v1/vendor-tax-profiles/${vendorId}`,
    headers: authorizedWrite(owner, `profile-${nonce}`),
    payload: {
      isEligible: true,
      defaultForm: '1099_nec',
      defaultBox: 'nec_1',
      taxId: '12-3456789',
      taxIdType: 'ein',
    },
  });
  expect(profile.statusCode, profile.body).toBe(200);

  return { owner, cashId, vendorId };
}

/** Records a money-out payment to the vendor (`made` is the wire vocabulary for `paid`). */
async function pay(f: Fixture, nonce: string, amount: string, date: string): Promise<string> {
  const response = await harness.app().inject({
    method: 'POST',
    url: '/v1/payments',
    headers: authorizedWrite(f.owner, `pay-${nonce}`),
    payload: { direction: 'made', contactId: f.vendorId, date, amount, accountId: f.cashId },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function worksheet(f: Fixture): Promise<Ten99Worksheet> {
  const response = await harness.app().inject({
    method: 'GET',
    url: `/v1/ten99/worksheet?taxYear=${YEAR}`,
    headers: { cookie: f.owner.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Ten99Worksheet>();
}

const vendorRow = (sheet: Ten99Worksheet, f: Fixture) =>
  sheet.rows.find((row) => row.contactId === f.vendorId);

describe('the 1099 worksheet rollup', () => {
  it('counts a payment at exactly the $600 threshold as meeting it, and masks the TIN', async () => {
    const f = await setup('threshold');
    await pay(f, 'threshold', '60000', `${YEAR}-03-01`);

    const row = vendorRow(await worksheet(f), f);
    expect(row?.paidMinor).toBe('60000');
    expect(row?.meetsThreshold).toBe(true);
    // The stored TIN is read back only as its last four (D-228-2).
    expect(row?.taxIdLast4).toBe('6789');
    expect(row?.hasTaxId).toBe(true);
  });

  it('leaves a vendor just under the threshold not meeting it', async () => {
    const f = await setup('under');
    await pay(f, 'under', '59999', `${YEAR}-03-01`);

    const row = vendorRow(await worksheet(f), f);
    expect(row?.paidMinor).toBe('59999');
    expect(row?.meetsThreshold).toBe(false);
  });

  it('excludes a payment dated outside the tax year (cash-basis, calendar-year)', async () => {
    const f = await setup('year');
    await pay(f, 'in-year', '60000', `${YEAR}-06-15`);
    // The prior year needs its own fiscal periods before a payment can post into it.
    const priorYear = await harness.app().inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(f.owner, 'year-prior'),
      payload: { fiscalYear: YEAR - 1 },
    });
    expect(priorYear.statusCode, priorYear.body).toBe(201);
    await pay(f, 'prior-year', '500000', `${YEAR - 1}-12-31`);

    // The out-of-year $5,000 must not lift the in-year total above the $600.
    expect(vendorRow(await worksheet(f), f)?.paidMinor).toBe('60000');
  });

  it('excludes a voided payment', async () => {
    const f = await setup('void');
    await pay(f, 'keep', '60000', `${YEAR}-03-01`);
    const voidable = await pay(f, 'voidable', '250000', `${YEAR}-06-01`);
    expect(vendorRow(await worksheet(f), f)?.paidMinor).toBe('310000');

    const voided = await harness.app().inject({
      method: 'POST',
      url: `/v1/payments/${voidable}/void`,
      headers: authorizedWrite(f.owner, 'void-1'),
      payload: { date: `${YEAR}-06-02` },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    // Back to the pre-void total — the voided $2,500 no longer counts.
    expect(vendorRow(await worksheet(f), f)?.paidMinor).toBe('60000');
  });
});

describe('generate snapshots the reviewed worksheet', () => {
  it('files exactly the worksheet amount for an over-threshold vendor (D-228-5)', async () => {
    const f = await setup('generate');
    await pay(f, 'gen', '150000', `${YEAR}-04-01`);
    const reviewed = vendorRow(await worksheet(f), f);
    expect(reviewed?.meetsThreshold).toBe(true);

    const response = await harness.app().inject({
      method: 'POST',
      url: '/v1/ten99/runs',
      headers: authorizedWrite(f.owner, 'generate-1'),
      payload: { taxYear: YEAR },
    });
    expect(response.statusCode, response.body).toBe(200);

    const form = response.json<Ten99Run>().forms.find((x) => x.contactId === f.vendorId);
    expect(form).toBeDefined();
    // The filed amount is the reviewed amount, to the cent — a snapshot, not a re-derive.
    expect(form?.amountMinor).toBe(reviewed?.paidMinor);
    expect(form?.formType).toBe('1099_nec');
    expect(form?.recipientTinLast4).toBe('6789');
  });
});
