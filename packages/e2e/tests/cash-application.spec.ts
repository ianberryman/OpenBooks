import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chartByCode, seedBankAccount } from './support/banking';
import { currentMonth, newRegistration } from './support/books';
import {
  addDays,
  clearStatementLineWithEntries,
  createAndApproveInvoice,
  createPaymentTerm,
  getDiscountSuggestion,
  getInvoice,
  nominateDiscountGivenAccount,
} from './support/cash-application';
import type { ClearingEntryInput } from './support/cash-application';
import {
  createAccount,
  createCustomer,
  getGeneralLedger,
  importPayoutDeposit,
  listUnclearedLines,
  waitForImportComplete,
} from './support/payments';

/**
 * The Cash-application narrative (OB-142; ROADMAP D-79…D-81, D-105…D-108;
 * criteria I2, I3, I4, I7).
 *
 * A lockbox deposit is one bank line that actually pays several customers at
 * once — a business's bank pools same-day receivables into one deposit long
 * before OpenBooks ever sees a statement. Before this initiative, a statement
 * line could clear against exactly one target, so a lockbox deposit had no
 * honest single acceptance: it had to be split into fictitious lines or coded
 * as an unexplained lump. D-80 generalises a clear to an **array of entries**,
 * and this is that seam's one browser proof, combined with the other half of
 * Cash application it lands alongside: a `2/10 Net 30` payment term that
 * computes a due date and an early-pay discount window (D-79), confirmed as
 * one of the entries in the same accepted action (D-106).
 *
 * The story: three customers' invoices, one of them on a `2/10 Net 30` term,
 * are settled by a single deposit that is net of the one discount taken. One
 * `POST /v1/statement-lines/{id}/clearing` carries three `allocate_document`
 * entries and one `discount` entry, the whole set summing to the line (E4),
 * and by the end all three invoices read `outstanding: "0"` and the discount
 * has posted to the org's nominated account.
 *
 * ## Why this narrative is API-first, like OB-153's
 *
 * `payment-integration.spec.ts` gives the reasoning this one borrows outright:
 * the assertions that matter are cents-exact ledger directions (a discount
 * debiting the nominated account, three invoices reaching zero outstanding),
 * best read off `GET /v1/reports/general-ledger` and `GET /v1/invoices/{id}`
 * exactly as a person would read them, not scraped off a screen that repeats
 * the same figures in several places. The multi-entry match row (OB-140) is a
 * real screen, but driving an add/remove-entries editor through four rows to
 * reach the same cents-exact assertions would be a second narrative wearing
 * this one's clothes (D-26) — `month-of-books.spec.ts` already proves a person
 * can drive an ordinary screen, and `banking.spec.ts` already proves the
 * single-entry match workbench. What is new here, and what nothing else
 * covers, is the seam itself: that an array of entries — three documents and a
 * discount — is accepted as one clear and balances exactly to one deposit.
 *
 * ## What this narrative does not claim
 *
 * `payment-terms.ts`'s own header notes `bill` targets accept the shared
 * `suggestDiscount` shape but resolve nothing until Pay Bills lands (D-108) —
 * this narrative is the AR side only, as CA itself is scoped. And the
 * multi-entry **screen** (OB-140) is not driven here for the reason above; its
 * own component/integration coverage is where an add/remove-entries UI click
 * is proven, the same division `recurring-and-dunning.spec.ts` draws around
 * `materializeCycle`.
 */

const CUSTOMER_A = 'Alpha Print Co';
const CUSTOMER_B = 'Beacon Facilities';
const CUSTOMER_C = 'Cascade Landscaping';

// The arithmetic, written down (D-13's cents strings, and the one decimal
// sibling the CSV statement speaks, the way a bank export does).
const INVOICE_A_GROSS_MINOR = '100000'; // 1,000.00 — the discounted invoice.
const INVOICE_B_GROSS_MINOR = '50000'; // 500.00
const INVOICE_C_GROSS_MINOR = '30000'; // 300.00
const DISCOUNT_RATE_PPM = 20_000; // 2% — `2/10 Net 30`.
const DISCOUNT_WINDOW_DAYS = 10;
const NET_DAYS = 30;
const EXPECTED_DISCOUNT_MINOR = '2000'; // 2% of 1,000.00.
const INVOICE_A_NET_OF_DISCOUNT_MINOR = '98000'; // 1,000.00 − 20.00.
// The lockbox deposit: every invoice's gross, net of the one discount taken.
const DEPOSIT_MINOR = '178000'; // 980.00 + 500.00 + 300.00
const DEPOSIT_DECIMAL = '1780.00'; // The same figure, as the bank's own export writes it.

test('a lockbox deposit is split across three invoices, one settled with an in-terms early-pay discount', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const today = month.day(new Date().getDate());
  const fiscalYear = new Date().getFullYear();
  // The deposit lands a few days after the invoices are issued — still inside
  // the ten-day discount window, and far enough from `today` that the two
  // discount-suggestion previews below (one at issue, one at the deposit's
  // own date) are genuinely different calls, not the same date twice.
  const depositDate = addDays(today, 3);

  let discountGivenAccountId: string;
  let invoiceAId: string;
  let invoiceBId: string;
  let invoiceCId: string;

  await test.step('register an org with the starter chart applied, and generate its fiscal year', async () => {
    // The register payload's own nested `org` shape (`createOrgRequestSchema`)
    // applies the chart in the same transaction (`orgs.service.ts`'s
    // `createOrgIn`), exactly as `payment-integration.spec.ts` does.
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

    // Nothing posts before a fiscal year exists (D-17) — the three invoices
    // below, the discount journal, and the payment journals all need this
    // first.
    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: { 'idempotency-key': randomUUID() },
      data: { fiscalYear },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  await test.step('nominate the discount-given account', async () => {
    // D-103's "nominate, don't invent" reasoning applies here too: the starter
    // chart's own contra-revenue line (4090, "Sales returns and allowances")
    // is a `revenue`-type account, and `discount-accounts.ts`'s own
    // `REQUIRED_TYPE` insists the *given* side is `expense` — a business
    // wires one up itself the day it first confirms an early-pay discount.
    discountGivenAccountId = await createAccount(page.request, {
      code: '6195',
      name: 'Early payment discounts given',
      type: 'expense',
      normalBalance: 'debit',
    });
    const nomination = await nominateDiscountGivenAccount(page.request, discountGivenAccountId);
    expect(nomination.discountGivenAccountId).toBe(discountGivenAccountId);
  });

  let paymentTermId: string;

  await test.step('create a 2/10 Net 30 payment term', async () => {
    paymentTermId = await createPaymentTerm(page.request, {
      name: '2/10 Net 30',
      netDays: NET_DAYS,
      discountRatePpm: DISCOUNT_RATE_PPM,
      discountWindowDays: DISCOUNT_WINDOW_DAYS,
    });
  });

  let customerAId: string;
  let customerBId: string;
  let customerCId: string;

  await test.step('add the three customers, and raise and approve their invoices, one on the 2/10 Net 30 term', async () => {
    const chart = await chartByCode(page.request);
    const revenueAccountId = chart.get('4020');
    if (revenueAccountId === undefined) {
      throw new Error('The starter chart has no account 4020.');
    }

    customerAId = await createCustomer(page.request, CUSTOMER_A);
    customerBId = await createCustomer(page.request, CUSTOMER_B);
    customerCId = await createCustomer(page.request, CUSTOMER_C);

    invoiceAId = await createAndApproveInvoice(page.request, {
      contactId: customerAId,
      issueDate: today,
      incomeAccountId: revenueAccountId,
      description: 'Signage and print run',
      grossMinor: INVOICE_A_GROSS_MINOR,
      paymentTermId,
    });
    invoiceBId = await createAndApproveInvoice(page.request, {
      contactId: customerBId,
      issueDate: today,
      incomeAccountId: revenueAccountId,
      description: 'Monthly facilities contract',
      grossMinor: INVOICE_B_GROSS_MINOR,
    });
    invoiceCId = await createAndApproveInvoice(page.request, {
      contactId: customerCId,
      issueDate: today,
      incomeAccountId: revenueAccountId,
      description: 'Grounds maintenance',
      grossMinor: INVOICE_C_GROSS_MINOR,
    });

    // I1: the term computes the due date (`issueDate + netDays`) on the one
    // invoice that named it — the other two, carrying no term, are left at
    // their `dueDate` default of `issueDate` (due on receipt) and are not
    // asserted here; this step is about the term's own arithmetic.
    const invoiceA = await getInvoice(page.request, invoiceAId);
    expect(invoiceA.dueDate).toBe(addDays(today, NET_DAYS));
    expect(invoiceA.totals.gross).toBe(INVOICE_A_GROSS_MINOR);

    // The discount window, previewed the moment the term resolves — the same
    // read a person would make before the money has even arrived, to see
    // whether an early-pay discount is worth offering. `asOfDate: today`
    // because the window opens the day the invoice is issued.
    const earlyPreview = await getDiscountSuggestion(page.request, {
      targetType: 'invoice',
      targetId: invoiceAId,
      asOfDate: today,
    });
    if (earlyPreview === null) {
      throw new Error('Expected a discount suggestion within the window; got none (204).');
    }
    expect(earlyPreview.deadline).toBe(addDays(today, DISCOUNT_WINDOW_DAYS));
  });

  let lineId: string;

  await test.step('a single lockbox deposit lands in the feed, net of the one discount', async () => {
    const chart = await chartByCode(page.request);
    const bankLedgerAccountId = chart.get('1010');
    if (bankLedgerAccountId === undefined) {
      throw new Error('The starter chart has no account 1010.');
    }

    const bankAccount = await seedBankAccount(page.request, {
      accountId: bankLedgerAccountId,
      name: 'Everyday Checking',
      institutionName: 'Meridian Bank',
      externalAccountId: 'CHK-4471',
    });

    const importId = await importPayoutDeposit(page.request, {
      bankAccountId: bankAccount.id,
      postedDate: depositDate,
      description: 'LOCKBOX DEPOSIT',
      amount: DEPOSIT_DECIMAL,
    });
    await waitForImportComplete(page.request, importId);

    const uncleared = await listUnclearedLines(page.request, bankAccount.id);
    expect(uncleared).toHaveLength(1);
    const line = uncleared[0];
    if (line === undefined) throw new Error('Expected one uncleared statement line.');
    expect(line.amount).toBe(DEPOSIT_MINOR);
    lineId = line.id;
  });

  await test.step('the discount suggestion, fetched again at the date the money actually lands (I4)', async () => {
    const suggestion = await getDiscountSuggestion(page.request, {
      targetType: 'invoice',
      targetId: invoiceAId,
      asOfDate: depositDate,
    });
    if (suggestion === null) {
      throw new Error('Expected a discount suggestion within the window; got none (204).');
    }

    // I4: computed from the term (2% of the gross), against the org's
    // nominated account — never auto-posted, only previewed here. This is the
    // figure the operator would confirm as the `discount` entry below.
    expect(suggestion.discountAmountMinor).toBe(EXPECTED_DISCOUNT_MINOR);
    expect(suggestion.accountId).toBe(discountGivenAccountId);
    expect(suggestion.targetId).toBe(invoiceAId);
  });

  await test.step('the deposit is cleared across all three invoices, one taking its discount, in one accepted action (I2, I3, I7)', async () => {
    // Lockbox (I3): three `allocate_document` entries, one per customer. Split
    // subsumed (I7): this is the exact mechanism OB-094 was deferred for, now
    // doing lockbox too. Discount (I4): a fourth entry funds the discounted
    // portion from the discount journal rather than from cash (D-106) — its
    // amount is excluded from what the *line* has to add up to.
    const entries: readonly ClearingEntryInput[] = [
      {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoiceAId,
        amount: INVOICE_A_NET_OF_DISCOUNT_MINOR,
      },
      {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoiceBId,
        amount: INVOICE_B_GROSS_MINOR,
      },
      {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoiceCId,
        amount: INVOICE_C_GROSS_MINOR,
      },
      {
        method: 'discount',
        accountId: discountGivenAccountId,
        targetType: 'invoice',
        targetId: invoiceAId,
        amount: EXPECTED_DISCOUNT_MINOR,
      },
    ];

    const clearing = await clearStatementLineWithEntries(page.request, lineId, entries);

    // E4, generalised (I2): the three `allocate_document` entries sum to the
    // line — the `discount` entry is deliberately excluded from that sum
    // (D-106) — and there is no residual.
    expect(clearing.entries).toHaveLength(4);
    expect(clearing.clearedAmount).toBe(DEPOSIT_MINOR);
    expect(clearing.differenceAmount).toBe('0');
  });

  await test.step('all three invoices are fully paid, and the discount posted to the nominated account', async () => {
    const invoiceA = await getInvoice(page.request, invoiceAId);
    const invoiceB = await getInvoice(page.request, invoiceBId);
    const invoiceC = await getInvoice(page.request, invoiceCId);

    expect(invoiceA.settlement.outstanding).toBe('0');
    expect(invoiceB.settlement.outstanding).toBe('0');
    expect(invoiceC.settlement.outstanding).toBe('0');

    // The discount journal's own direction (D-106): debit the discount-given
    // account, for the discount alone — read off the general ledger the same
    // way a person reconciling the month would, rather than assumed from the
    // request that confirmed it.
    const discountLedger = await getGeneralLedger(page.request, discountGivenAccountId);
    expect(discountLedger.entries).toHaveLength(1);
    expect(discountLedger.entries[0]?.debit).toBe(EXPECTED_DISCOUNT_MINOR);
    expect(discountLedger.entries[0]?.credit).toBe('0');
    expect(discountLedger.closing.balance).toBe(EXPECTED_DISCOUNT_MINOR);
  });
});
