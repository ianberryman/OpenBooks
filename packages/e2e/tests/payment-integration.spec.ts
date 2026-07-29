import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chartByCode, seedBankAccount } from './support/banking';
import { currentMonth, newRegistration } from './support/books';
import {
  clearLineToAccount,
  connectFakeProcessor,
  createAccount,
  createAndApproveInvoice,
  createCustomer,
  getGeneralLedger,
  getInvoice,
  getPayment,
  getProcessorConnection,
  importPayoutDeposit,
  listUnclearedLines,
  lookupPaymentRef,
  postFakeWebhook,
  sendInvoiceAndGetToken,
  waitForImportComplete,
} from './support/payments';
import type { NormalizedProcessorEvent } from './support/payments';

/**
 * The payment-integration narrative (OB-153; ROADMAP D-82…D-86, D-101…D-104, F9,
 * D-26) — a hosted invoice, paid through a real processor seam, reconciled to the
 * real bank.
 *
 * A business that takes card payments does not want to key in a "received" entry by
 * hand every time a customer clicks "Pay now": it wants the charge to clear the
 * invoice itself, the processor's cut to land in its own expense account, and the
 * eventual bank deposit to tie out to the difference — with a redelivered webhook
 * never doubling any of it (F9). This is that seam's one browser proof: connect a
 * `fake` processor (D-102) to a clearing account and a fee account, raise and send an
 * invoice, open the hosted page a customer actually receives, simulate the customer
 * paying with a signed webhook, redeliver the identical event and watch it collapse
 * to one payment, then simulate the payout and clear the real bank deposit against
 * the clearing account until it nets to zero.
 *
 * ## Why this narrative is API-first, and where the browser still appears
 *
 * Every other narrative in this suite is a person clicking through screens, with API
 * calls reserved for the ledger state a screen assumes but has no way to create
 * (`support/banking.ts`'s bank account, `support/books.ts`'s fiscal year). This one
 * inverts that ratio, for reasons specific to what OB-150/OB-153 actually shipped:
 *
 *  - **There is no "Pay now" button.** `screens/public-invoice.tsx` renders the
 *    hosted page from `publicInvoiceViewSchema` but its own hand-mirrored
 *    `PublicInvoiceView` interface never declares `payable`, and nothing on the page
 *    calls `POST /public/invoices/{token}/pay-link`. The API contract OB-150 shipped
 *    is real and this narrative drives it directly; the UI half is not built yet — a
 *    real product gap, in `support/banking.ts`'s "no bank-account-creation screen"
 *    shape, not a shortcut taken here.
 *  - **A webhook has no UI at all, by construction.** `x-fake-signature` is computed
 *    over raw bytes by a processor's own backend, never by a browser — there is
 *    nothing to click that would produce one.
 *  - **The assertions are cents-exact ledger directions.** "The fee debited the fee
 *    account and credited the clearing account" is read off
 *    `GET /v1/reports/general-ledger`, the same report a person would open, rather
 *    than transcribed from a screen — matching figures off a report is exactly what
 *    `banking.spec.ts` already does for M4's own reconciliation.
 *
 * The one moment this narrative *is* the customer in a browser is opening the hosted
 * page itself (`page.goto('/i/{token}')`) — the actual link a customer's email would
 * carry, rendered by the actual unauthenticated route (D-74).
 *
 * ## What this narrative does not claim
 *
 * The payout's own D-85 polling backstop and the full M4 reconciliation *session*
 * (open → match → finalise) are each already this suite's own narrative
 * (`banking.spec.ts`) — re-driving a reconciliation session here would be a second
 * narrative wearing the first's clothes (D-26, `support/banking.ts`'s own reasoning
 * for seeding rather than re-proving M1's journal posting). What is new here, and
 * what this narrative proves instead, is the seam nothing else covers: that a
 * processor payout's net deposit, once cleared through the *existing* M4 pipeline
 * against the clearing account `recordProcessorPayout` itself deliberately posts
 * nothing to (`posting.service.ts`'s header), actually zeroes the clearing account
 * and lands the bank's own ledger account at the figure the statement claims.
 */

// The arithmetic, written down (D-13's cents strings, and their decimal siblings for
// the CSV statement, which speaks decimals the way a bank export does).
const GROSS_MINOR = '150000'; // 1,500.00 — the invoice, one line, no tax.
const FEE_MINOR = '435'; // 4.35 — the processor's cut of this one charge.
const NET_MINOR = '149565'; // 1,500.00 − 4.35 — the clearing account's net, and the payout.
const NET_DECIMAL = '1495.65'; // The same figure, as the bank's own statement export writes it.

const CUSTOMER = 'Beacon Analytics';
const WEBHOOK_SECRET = 'e2e-fake-webhook-secret';

test('a hosted invoice is paid through a fake processor, the fee posts, a redelivery collapses, and the payout reconciles', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const today = month.day(new Date().getDate());
  const fiscalYear = new Date().getFullYear();

  let clearingAccountId: string;
  let feeAccountId: string;
  let customerId: string;
  let connectionId: string;
  let invoiceId: string;
  let token: string;
  let bankAccountId: string;

  await test.step('register an org with the starter chart applied, and generate its fiscal year', async () => {
    // The register payload's own nested `org` shape (`createOrgRequestSchema`)
    // applies the chart and nominates the receivable control account in the same
    // transaction (`orgs.service.ts`'s `createOrgIn`) — one call does what the UI
    // narratives spend two screens on (register, then "Apply a starter chart").
    const response = await page.request.post('/v1/auth/register', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        email: registration.email,
        password: registration.password,
        displayName: registration.displayName,
        org: { name: registration.orgName, chartTemplateId: 'general_small_business' },
      },
    });
    expect(response.ok(), `POST /v1/auth/register → ${String(response.status())}`).toBeTruthy();

    // Nothing posts before a fiscal year exists (D-17) — the invoice below, the
    // charge's payment journal, the fee journal, and the payout's own clearing all
    // need this first.
    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: { 'idempotency-key': randomUUID() },
      data: { fiscalYear },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  await test.step('seed a clearing account and a processor-fee expense account, and add the customer', async () => {
    // Nominate, don't invent (D-103): the starter chart holds no clearing account at
    // all, so this org creates one — a business connecting its first processor does
    // the same the day it sets one up.
    clearingAccountId = await createAccount(page.request, {
      code: '1070',
      name: 'Payment processor clearing',
      type: 'asset',
      normalBalance: 'debit',
    });
    feeAccountId = await createAccount(page.request, {
      code: '6190',
      name: 'Payment processor fees',
      type: 'expense',
      normalBalance: 'debit',
    });
    customerId = await createCustomer(page.request, CUSTOMER);
  });

  await test.step('connect a fake payment processor to those two accounts', async () => {
    connectionId = await connectFakeProcessor(page.request, {
      clearingAccountId,
      feeAccountId,
      webhookSecret: WEBHOOK_SECRET,
    });
  });

  await test.step('raise, approve and send an invoice, and open the hosted page a customer would receive', async () => {
    const chart = await chartByCode(page.request);
    const revenueAccountId = chart.get('4020');
    if (revenueAccountId === undefined) {
      throw new Error('The starter chart has no account 4020.');
    }

    invoiceId = await createAndApproveInvoice(page.request, {
      contactId: customerId,
      issueDate: today,
      incomeAccountId: revenueAccountId,
      description: 'Analytics platform, annual plan',
      grossMinor: GROSS_MINOR,
    });

    token = await sendInvoiceAndGetToken(page.request, invoiceId);

    // The actual link a customer's email carries — rendered by the actual
    // unauthenticated route (D-74), no session, no cookie. `documentNumber` is
    // whatever the org's own gapless sequence allocated at approval, so the
    // heading is matched by its fixed prefix rather than a guessed number, and
    // "Billed to" scopes the customer's name to its own line — the invoice total
    // repeats in three places on this page (the one line, "Net", and "Total" all
    // read 1500.00 with no tax), so it is asserted cents-exact off the JSON below
    // instead of scraped as page text that would match three elements at once.
    await page.goto(`/i/${token}`);
    await expect(page.getByText(/^Invoice /)).toBeVisible();
    await expect(page.getByText('Billed to')).toBeVisible();
    await expect(page.getByText(CUSTOMER, { exact: true })).toBeVisible();

    // `payable` and the pay-link route both exist on the wire (OB-150) with no
    // button behind either yet — see this file's header. Driven directly rather
    // than through a control that is not there.
    const view = await page.request.get(`/public/invoices/${token}`);
    expect(view.ok(), `GET /public/invoices/{token} → ${String(view.status())}`).toBeTruthy();
    const body = (await view.json()) as { payable: boolean; totals: { gross: string } };
    expect(body.payable).toBe(true);
    expect(body.totals.gross).toBe(GROSS_MINOR);

    const payLink = await page.request.post(`/public/invoices/${token}/pay-link`);
    expect(
      payLink.ok(),
      `POST /public/invoices/{token}/pay-link → ${String(payLink.status())}`,
    ).toBeTruthy();
    const link = (await payLink.json()) as { url: string };
    expect(link.url.length).toBeGreaterThan(0);
  });

  const chargeExternalObjectId = `ch_${randomUUID()}`;

  await test.step('the customer pays: a signed webhook clears the invoice, posts the payment and the fee', async () => {
    const charge: NormalizedProcessorEvent = {
      kind: 'charge',
      externalEventId: `evt_${randomUUID()}`,
      externalObjectId: chargeExternalObjectId,
      invoiceId,
      grossMinor: GROSS_MINOR,
      feeMinor: FEE_MINOR,
      netMinor: null,
      occurredAt: new Date().toISOString(),
    };

    const result = await postFakeWebhook(page.request, connectionId, WEBHOOK_SECRET, charge);
    expect(result.status).toBe('processed');

    const invoice = await getInvoice(page.request, invoiceId);
    expect(invoice.status).toBe('paid');
    expect(invoice.settlement.outstanding).toBe('0');

    // The payment landed in the clearing account — resolved the same way
    // `recordProcessorCharge`'s own idempotency check resolves it, over
    // `external_refs` (D-58), not guessed from the webhook's bare `{ status }` body.
    const paymentId = await lookupPaymentRef(page.request, chargeExternalObjectId);
    const payment = await getPayment(page.request, paymentId);
    expect(payment.accountId).toBe(clearingAccountId);
    expect(payment.amount).toBe(GROSS_MINOR);
    expect(payment.direction).toBe('received');

    // The fee's double-entry direction (D-104): debit the fee account, credit the
    // clearing account, for the fee alone.
    const feeLedger = await getGeneralLedger(page.request, feeAccountId);
    expect(feeLedger.entries).toHaveLength(1);
    expect(feeLedger.entries[0]?.debit).toBe(FEE_MINOR);
    expect(feeLedger.entries[0]?.credit).toBe('0');
    expect(feeLedger.closing.balance).toBe(FEE_MINOR);

    // The clearing account nets the gross charge against the fee — not yet the
    // payout's deposit, which has not arrived.
    const clearingLedger = await getGeneralLedger(page.request, clearingAccountId);
    expect(clearingLedger.closing.balance).toBe(NET_MINOR);
  });

  await test.step('the same delivery redelivered collapses to one payment (F9)', async () => {
    const redelivered: NormalizedProcessorEvent = {
      kind: 'charge',
      externalEventId: `evt_${randomUUID()}`, // A different delivery id …
      externalObjectId: chargeExternalObjectId, // … reporting the identical charge.
      invoiceId,
      grossMinor: GROSS_MINOR,
      feeMinor: FEE_MINOR,
      netMinor: null,
      occurredAt: new Date().toISOString(),
    };

    // A genuine redelivery carries the *same* `externalEventId` and would be caught
    // by `processor_events`' own unique key before dispatch ever runs; a poll
    // re-reporting the same charge under a fresh delivery id is what
    // `external_refs`' object-level guard exists for instead (`webhook.service.ts`'s
    // header) — this second call exercises that second guard.
    const result = await postFakeWebhook(page.request, connectionId, WEBHOOK_SECRET, redelivered);
    expect(result.status).toBe('processed');

    const paymentId = await lookupPaymentRef(page.request, chargeExternalObjectId);
    const payment = await getPayment(page.request, paymentId);
    expect(payment.amount).toBe(GROSS_MINOR);

    // Unchanged: no second payment, no second fee journal.
    const feeLedger = await getGeneralLedger(page.request, feeAccountId);
    expect(feeLedger.entries).toHaveLength(1);
    const clearingLedger = await getGeneralLedger(page.request, clearingAccountId);
    expect(clearingLedger.closing.balance).toBe(NET_MINOR);
  });

  await test.step('a payout arrives, and the real bank deposit reconciles against the clearing account', async () => {
    const occurredAt = new Date().toISOString();
    const payout: NormalizedProcessorEvent = {
      kind: 'payout',
      externalEventId: `evt_${randomUUID()}`,
      externalObjectId: `po_${randomUUID()}`,
      invoiceId: null,
      grossMinor: NET_MINOR,
      feeMinor: null,
      netMinor: NET_MINOR,
      occurredAt,
    };

    const result = await postFakeWebhook(page.request, connectionId, WEBHOOK_SECRET, payout);
    expect(result.status).toBe('processed');

    // `recordProcessorPayout` posts nothing itself (`posting.service.ts`'s header) —
    // it only advances the D-85 reconciliation cursor. That cursor moving is the one
    // thing this event alone is observable by.
    const connection = await getProcessorConnection(page.request, connectionId);
    expect(connection.reconciledThrough).not.toBeNull();

    // The real bank deposit, imported the way a statement always arrives (D-41), on
    // the ledger account the starter chart's own bank account is (code 1010, the
    // same account `support/banking.ts` seeds for `banking.spec.ts`).
    const chart = await chartByCode(page.request);
    const bankLedgerAccountId = chart.get('1010');
    if (bankLedgerAccountId === undefined) {
      throw new Error('The starter chart has no account 1010.');
    }
    bankAccountId = (
      await seedBankAccount(page.request, {
        accountId: bankLedgerAccountId,
        name: 'Everyday Checking',
        institutionName: 'Meridian Bank',
        externalAccountId: 'CHK-9901',
      })
    ).id;

    const importId = await importPayoutDeposit(page.request, {
      bankAccountId,
      postedDate: today,
      description: 'PROCESSOR PAYOUT',
      amount: NET_DECIMAL,
    });
    await waitForImportComplete(page.request, importId);

    const uncleared = await listUnclearedLines(page.request, bankAccountId);
    expect(uncleared).toHaveLength(1);
    const line = uncleared[0];
    if (line === undefined) throw new Error('Expected one uncleared statement line.');
    expect(line.amount).toBe(NET_MINOR);

    // Clear the deposit straight to the clearing account (`method: 'post_entry'`) —
    // the payout's own journal, debit bank, credit clearing, posted here rather than
    // by the webhook (D-82).
    const clearing = await clearLineToAccount(page.request, line.id, clearingAccountId);
    expect(clearing.clearedAmount).toBe(NET_MINOR);
    expect(clearing.differenceAmount).toBe('0');

    // The clearing account nets to zero: the gross charge in, the fee and the
    // payout both out.
    const clearingLedger = await getGeneralLedger(page.request, clearingAccountId);
    expect(clearingLedger.closing.balance).toBe('0');

    // And the bank's own ledger account lands at exactly what the statement
    // claimed — the figure a reconciliation would tie against.
    const bankLedger = await getGeneralLedger(page.request, bankLedgerAccountId);
    expect(bankLedger.closing.balance).toBe(NET_MINOR);
  });
});
