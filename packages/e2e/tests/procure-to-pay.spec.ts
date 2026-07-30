import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { chartByCode, seedBankAccount } from './support/banking';
import { currentMonth, newRegistration } from './support/books';
import {
  buildPayBillsQueue,
  createVendor,
  getBill,
  getIssuedPayment,
  issuePendingPayment,
  listPayableBills,
} from './support/pay-bills';
import { getGeneralLedger } from './support/payments';

/**
 * The procure-to-pay narrative (OB-179; ROADMAP D-M1…D-M8, initiative M,
 * acceptance criteria M1…M8).
 *
 * Initiative M adds two non-posting pre-documents — purchase orders and
 * estimates — that convert losslessly into the AP/AR documents M3 already
 * proved (`purchase-orders.spec` and `estimates.spec` do not exist; this is
 * their only narrative, D-26), and one document that is not a new kind of
 * thing at all: an employee expense **is** an `ap_documents` bill whose
 * contact happens to be an employee (D-M2), reimbursed by Pay Bills settling
 * it exactly as it settles a vendor's. This narrative is the one story that
 * exercises all three at once and the seam between them: a purchase order
 * converting into a bill that then flows through the ordinary approval path,
 * an estimate converting into an invoice the same way, and an expense that
 * needs no new machinery to be paid because Pay Bills already understands
 * "an approved, non-void `document_type='bill'`" and does not care whose
 * contact flag put it there.
 *
 * ## Why this narrative is API-first, like OB-118's and OB-142's
 *
 * The claims that matter are cents-exact ledger directions once a purchase
 * order becomes a bill, once an estimate becomes an invoice, and once an
 * expense is reimbursed — read off `GET /v1/reports/general-ledger` exactly
 * as `pay-bills.spec.ts` reads them, not scraped off three screens that each
 * repeat the same figures. The three Wave-3 screens (`purchase-orders`,
 * `estimates`, `expenses`) have their own component and integration coverage;
 * driving them here to reach the same numbers would be a second narrative
 * wearing this one's clothes (D-26). What only this narrative proves is the
 * wire seam: that convert carries every line losslessly, that convert-once is
 * enforced, that each pre-document's own number series is independent of the
 * document it produces, and that an employee-contact bill needs nothing
 * special from Pay Bills to be paid.
 *
 * ## The arithmetic, written down
 *
 * ```
 *   Purchase order → bill         (D-M3, D-M4)
 *     Standing desks (2)     120000  (1,200.00)  → 6060 Office supplies
 *     Software licenses       45000  (  450.00)  → 6130 Software and technology
 *     ---------------------------------------------------------------------
 *     bill total, on approval 165000  (1,650.00)  → credit 2010 Accounts payable
 *
 *   Estimate → invoice             (D-M3, D-M4)
 *     Website redesign         80000  (  800.00)  → 4020 Service revenue
 *     Onboarding package        20000  (  200.00)  → 4010 Product sales
 *     ---------------------------------------------------------------------
 *     invoice total, on approval 100000  (1,000.00)  → debit 1100 Accounts receivable
 *
 *   Expense → reimbursement        (D-M2)
 *     Denver trip, client dinner  42500  (  425.00)  → 6150 Travel
 *     ---------------------------------------------------------------------
 *     payable, on approval        42500  (  425.00)  → credit 2010 (same series+account as the bill)
 *     reimbursed in full via ACH  42500              → debit 2010, credit 1010 Business checking
 * ```
 *
 * Accounts payable (2010) receives two credits — the PO's own bill and the
 * expense — and one debit, the expense's reimbursement: it closes at
 * `-165000`, exactly the PO-derived bill's own total, because that bill is
 * deliberately never paid in this narrative. That is the cents-exact tell
 * that the expense's reimbursement touched nothing else sharing the account.
 *
 * ## What this narrative does not claim
 *
 * - **Sending a purchase order or an estimate is not exercised.** D-M5 scopes
 *   v1 send as a lean, flagged email-plus-`predocument_deliveries`-row path,
 *   with the token-gated hosted page and themed PDF deferred; this narrative
 *   never calls either `/send` route.
 * - **No dimension tags.** D-M7 omits `dimensionValueIds` from every
 *   purchase-order and estimate line in v1; nothing here exercises adding one
 *   to the converted draft before its own approval.
 * - **No settlement discount or vendor credit on the reimbursement leg.**
 *   `pay-bills.spec.ts` already proves that machinery cents-exact; the point
 *   here is only that an employee-contact bill rides the same pipe
 *   unmodified, so the expense is paid in full, on one rail, with neither.
 * - **The three Wave-3 screens are not driven.** Each has its own
 *   component/integration tests; this narrative's business is the API seam
 *   convert and Pay Bills share, not re-proving a click path already covered
 *   elsewhere.
 */

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** A fresh key per call: each is one intent, issued once, never retried by hand. */
function writeHeaders(): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: randomUUID() };
}

interface ContactResponse {
  readonly id: string;
}

/**
 * Creates a contact carrying whichever of `isCustomer`/`isEmployee` is given —
 * `createVendor`'s own shape, restated for the two flags Pay Bills' support
 * file has no reason to carry.
 */
async function createContact(
  request: APIRequestContext,
  displayName: string,
  flags: { readonly isCustomer?: boolean; readonly isEmployee?: boolean },
): Promise<string> {
  const response = await request.post('/v1/contacts', {
    headers: writeHeaders(),
    data: { displayName, ...flags },
  });
  expect(response.ok(), `POST /v1/contacts → ${String(response.status())}`).toBeTruthy();
  const contact = (await response.json()) as ContactResponse;
  return contact.id;
}

/**
 * One priced line, restated from `documentLineSchema` down to the five fields
 * a line's own request carries — enough to prove convert carried it over
 * unchanged (M1, M2), and no more: `lineId`, `lineNumber`, the tax
 * percentage, and the three posted amounts are recomputed by whichever
 * document reads the line back, not values a request supplies.
 */
interface DocumentLineResponse {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly accountId: string;
  readonly taxRateId: string | null;
}

/** Keeps only the fields a line's own request supplies — `toEqual`'s comparison base. */
function lineFingerprint(line: DocumentLineResponse): Omit<DocumentLineResponse, never> {
  return {
    description: line.description,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    accountId: line.accountId,
    taxRateId: line.taxRateId,
  };
}

interface PurchaseOrderResponse {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly status: 'draft' | 'approved' | 'converted';
  readonly convertedBillId: string | null;
  readonly lines: readonly DocumentLineResponse[];
  readonly totals: { readonly gross: string };
}

interface EstimateResponse {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly status: 'draft' | 'approved' | 'converted';
  readonly convertedInvoiceId: string | null;
  readonly lines: readonly DocumentLineResponse[];
  readonly totals: { readonly gross: string };
}

/** What a converted-then-approved bill or invoice looks like, read back generically. */
interface SubledgerDocumentResponse {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly status: string;
  readonly lines: readonly DocumentLineResponse[];
  readonly totals: { readonly gross: string };
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly details?: { readonly precondition?: string };
  };
}

test('a purchase order converts into a bill, an estimate converts into an invoice, and an employee expense is reimbursed through Pay Bills', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const today = month.day(new Date().getDate());
  const fiscalYear = new Date().getFullYear();

  await test.step('register an org with the starter chart applied, and generate its fiscal year', async () => {
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

    // The starter chart's own template nominates both the AP payables control
    // account (2010) and the AR receivables control account (1100) as part of
    // applying it (`chart-templates.ts`'s `controlAccountCodes`) — nothing
    // else here has to set either up. Nothing posts before a fiscal year
    // exists (D-17), which every approval below needs.
    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: { 'idempotency-key': randomUUID() },
      data: { fiscalYear },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  let bankAccountId: string;
  let bankLedgerAccountId: string;
  let officeSuppliesAccountId: string;
  let softwareAccountId: string;
  let serviceRevenueAccountId: string;
  let productSalesAccountId: string;
  let travelAccountId: string;
  let apControlAccountId: string;
  let arControlAccountId: string;

  await test.step('seed a bank account for the reimbursement, and read the chart of accounts', async () => {
    const chart = await chartByCode(page.request);
    const accountId = (code: string): string => {
      const id = chart.get(code);
      if (id === undefined) throw new Error(`The starter chart has no account ${code}.`);
      return id;
    };

    bankLedgerAccountId = accountId('1010');
    officeSuppliesAccountId = accountId('6060');
    softwareAccountId = accountId('6130');
    serviceRevenueAccountId = accountId('4020');
    productSalesAccountId = accountId('4010');
    travelAccountId = accountId('6150');
    apControlAccountId = accountId('2010');
    arControlAccountId = accountId('1100');

    const bankAccount = await seedBankAccount(page.request, {
      accountId: bankLedgerAccountId,
      name: 'Business Checking',
      institutionName: 'Cascade Bank',
      externalAccountId: 'CHK-5502',
    });
    bankAccountId = bankAccount.id;
  });

  let vendorId: string;
  let customerId: string;
  let employeeId: string;

  await test.step('add a vendor, a customer, and an employee contact', async () => {
    vendorId = await createVendor(page.request, 'Meridian Office Supply');
    customerId = await createContact(page.request, 'Ashgrove Consulting Group', {
      isCustomer: true,
    });
    employeeId = await createContact(page.request, 'Priya Desai', { isEmployee: true });
  });

  let purchaseOrderId: string;
  let draftBillId: string;

  await test.step('raise a purchase order, approve it (allocating its own number), and convert it into a draft bill (M1, M3, M6)', async () => {
    const created = await page.request.post('/v1/purchase-orders', {
      headers: writeHeaders(),
      data: {
        contactId: vendorId,
        issueDate: today,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Standing desks (2)',
            quantity: '1',
            unitAmount: '120000',
            accountId: officeSuppliesAccountId,
          },
          {
            description: 'Software licenses, annual',
            quantity: '1',
            unitAmount: '45000',
            accountId: softwareAccountId,
          },
        ],
      },
    });
    expect(created.ok(), `POST /v1/purchase-orders → ${String(created.status())}`).toBeTruthy();
    const draft = (await created.json()) as PurchaseOrderResponse;
    purchaseOrderId = draft.id;
    expect(draft.documentNumber).toBeNull();
    expect(draft.status).toBe('draft');

    const approved = await page.request.post(`/v1/purchase-orders/${purchaseOrderId}/approve`, {
      headers: writeHeaders(),
    });
    expect(
      approved.ok(),
      `POST /v1/purchase-orders/{id}/approve → ${String(approved.status())}`,
    ).toBeTruthy();
    const approvedPo = (await approved.json()) as PurchaseOrderResponse;
    // The purchase-order series' first allocation — independent of the bill
    // series a convert is about to reach into (M6).
    expect(approvedPo.documentNumber).toBe('1');
    expect(approvedPo.status).toBe('approved');
    expect(approvedPo.totals.gross).toBe('165000');

    const converted = await page.request.post(`/v1/purchase-orders/${purchaseOrderId}/convert`, {
      headers: writeHeaders(),
    });
    expect(
      converted.ok(),
      `POST /v1/purchase-orders/{id}/convert → ${String(converted.status())}`,
    ).toBeTruthy();
    const draftBill = (await converted.json()) as SubledgerDocumentResponse;
    draftBillId = draftBill.id;
    expect(draftBill.status).toBe('draft');
    expect(draftBill.documentNumber).toBeNull();
    expect(draftBill.totals.gross).toBe('165000');

    // M1/M2: every line survived the round trip through the draft bill,
    // unchanged and in the same order — `purchase-orders.property.test.ts`
    // proves this for arbitrary line sets; this is the one fixed example a
    // reader can see the figures next to.
    expect(draftBill.lines.map(lineFingerprint)).toEqual(approvedPo.lines.map(lineFingerprint));
  });

  await test.step('approve the draft bill, and assert the purchase order refuses a second convert (D-M4)', async () => {
    const approved = await page.request.post(`/v1/bills/${draftBillId}/approve`, {
      headers: writeHeaders(),
    });
    expect(
      approved.ok(),
      `POST /v1/bills/{id}/approve → ${String(approved.status())}`,
    ).toBeTruthy();
    const bill = (await approved.json()) as SubledgerDocumentResponse;
    // The bill series' own first allocation — "1" here and "1" on the
    // purchase order above are two different counters (M6), not a
    // coincidence: `document_sequences` keys on `(org_id, document_type)`.
    expect(bill.documentNumber).toBe('1');
    expect(bill.status).toBe('approved');

    const secondConvert = await page.request.post(
      `/v1/purchase-orders/${purchaseOrderId}/convert`,
      { headers: writeHeaders() },
    );
    expect(secondConvert.status()).toBe(412);
    const error = (await secondConvert.json()) as ErrorEnvelope;
    expect(error.error.code).toBe('precondition_failed');
    expect(error.error.details?.precondition).toBe('purchase_order_already_converted');
  });

  let estimateId: string;
  let draftInvoiceId: string;

  await test.step('raise an estimate, approve it, and convert it into a draft invoice (M2)', async () => {
    const created = await page.request.post('/v1/estimates', {
      headers: writeHeaders(),
      data: {
        contactId: customerId,
        issueDate: today,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Website redesign',
            quantity: '1',
            unitAmount: '80000',
            accountId: serviceRevenueAccountId,
          },
          {
            description: 'Onboarding package',
            quantity: '1',
            unitAmount: '20000',
            accountId: productSalesAccountId,
          },
        ],
      },
    });
    expect(created.ok(), `POST /v1/estimates → ${String(created.status())}`).toBeTruthy();
    const draft = (await created.json()) as EstimateResponse;
    estimateId = draft.id;
    expect(draft.documentNumber).toBeNull();

    const approved = await page.request.post(`/v1/estimates/${estimateId}/approve`, {
      headers: writeHeaders(),
    });
    expect(
      approved.ok(),
      `POST /v1/estimates/{id}/approve → ${String(approved.status())}`,
    ).toBeTruthy();
    const approvedEstimate = (await approved.json()) as EstimateResponse;
    // The estimate series' own first allocation — a third counter, distinct
    // from both the purchase-order and the bill series above.
    expect(approvedEstimate.documentNumber).toBe('1');
    expect(approvedEstimate.totals.gross).toBe('100000');

    const converted = await page.request.post(`/v1/estimates/${estimateId}/convert`, {
      headers: writeHeaders(),
    });
    expect(
      converted.ok(),
      `POST /v1/estimates/{id}/convert → ${String(converted.status())}`,
    ).toBeTruthy();
    const draftInvoice = (await converted.json()) as SubledgerDocumentResponse;
    draftInvoiceId = draftInvoice.id;
    expect(draftInvoice.status).toBe('draft');
    expect(draftInvoice.totals.gross).toBe('100000');
    expect(draftInvoice.lines.map(lineFingerprint)).toEqual(
      approvedEstimate.lines.map(lineFingerprint),
    );
  });

  await test.step('approve the draft invoice', async () => {
    const approved = await page.request.post(`/v1/invoices/${draftInvoiceId}/approve`, {
      headers: writeHeaders(),
    });
    expect(
      approved.ok(),
      `POST /v1/invoices/{id}/approve → ${String(approved.status())}`,
    ).toBeTruthy();
    const invoice = (await approved.json()) as SubledgerDocumentResponse;
    // The invoice series' own first allocation — a fourth counter.
    expect(invoice.documentNumber).toBe('1');
    expect(invoice.status).toBe('approved');
  });

  let expenseId: string;

  await test.step("enter an employee expense and approve it into a payable, sharing the bill's own number series (D-M2)", async () => {
    const created = await page.request.post('/v1/expenses', {
      headers: writeHeaders(),
      data: {
        contactId: employeeId,
        issueDate: today,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Denver trip, client dinner',
            quantity: '1',
            unitAmount: '42500',
            accountId: travelAccountId,
          },
        ],
      },
    });
    expect(created.ok(), `POST /v1/expenses → ${String(created.status())}`).toBeTruthy();
    const draft = (await created.json()) as SubledgerDocumentResponse;
    expenseId = draft.id;

    const approved = await page.request.post(`/v1/expenses/${expenseId}/approve`, {
      headers: writeHeaders(),
    });
    expect(
      approved.ok(),
      `POST /v1/expenses/{id}/approve → ${String(approved.status())}`,
    ).toBeTruthy();
    const expense = (await approved.json()) as SubledgerDocumentResponse;
    // D-M2's own consequence, made visible: an expense is `document_type='bill'`
    // in the same `ap_documents` table, so it draws from the *same*
    // `document_sequences` row the PO's own bill already claimed "1" from —
    // this is "2", not a fresh "1" of its own.
    expect(expense.documentNumber).toBe('2');
    expect(expense.status).toBe('approved');
    expect(expense.totals.gross).toBe('42500');

    // Nothing about being an employee's bill excludes it from the Pay Bills
    // window: `selectPayableBillCandidates` filters on `document_type='bill'`,
    // approved and non-void, and does not look at the contact's own flags.
    const payable = await listPayableBills(page.request);
    const payableExpense = payable.find((bill) => bill.billId === expenseId);
    expect(payableExpense?.outstanding).toBe('42500');
    expect(payableExpense?.committed).toBe('0');
  });

  let issuedPaymentId: string;

  await test.step('build a Pay Bills queue that includes the expense, and issue it over ACH (M4, M5)', async () => {
    const queue = await buildPayBillsQueue(page.request, [
      {
        contactId: employeeId,
        bankAccountId,
        rail: 'ach',
        memo: 'Priya Desai — expense reimbursement',
        intents: [{ billId: expenseId, payAmount: '42500' }],
      },
    ]);
    expect(queue).toHaveLength(1);
    const pendingPayment = queue[0];
    if (pendingPayment === undefined) throw new Error('Expected one pending payment.');
    expect(pendingPayment.totalAmount).toBe('42500');

    const outcome = await issuePendingPayment(page.request, pendingPayment.id, { date: today });
    expect(outcome.status).toBe('issued');
    if (outcome.paymentId === null) throw new Error('Expected a paymentId on the outcome.');
    issuedPaymentId = outcome.paymentId;
    expect(outcome.checkNumber).toBeNull();

    // Reading the expense back through `GET /v1/bills/{id}` rather than
    // `GET /v1/expenses/{id}` is deliberate: D-M2's claim is that these are
    // the *same row*, and the bill route answering for an employee's id is
    // exactly that claim, exercised rather than assumed.
    const expenseAsBill = await getBill(page.request, expenseId);
    expect(expenseAsBill.settlement.outstanding).toBe('0');

    const payable = await listPayableBills(page.request);
    expect(payable.some((bill) => bill.billId === expenseId)).toBe(false);
  });

  await test.step('the ledger ties out across all three legs, cents-exact', async () => {
    const officeSupplies = await getGeneralLedger(page.request, officeSuppliesAccountId);
    expect(officeSupplies.closing.debits).toBe('120000');
    expect(officeSupplies.closing.credits).toBe('0');

    const software = await getGeneralLedger(page.request, softwareAccountId);
    expect(software.closing.debits).toBe('45000');
    expect(software.closing.credits).toBe('0');

    const serviceRevenue = await getGeneralLedger(page.request, serviceRevenueAccountId);
    expect(serviceRevenue.closing.credits).toBe('80000');
    expect(serviceRevenue.closing.debits).toBe('0');

    const productSales = await getGeneralLedger(page.request, productSalesAccountId);
    expect(productSales.closing.credits).toBe('20000');
    expect(productSales.closing.debits).toBe('0');

    const receivable = await getGeneralLedger(page.request, arControlAccountId);
    expect(receivable.closing.debits).toBe('100000');
    expect(receivable.closing.credits).toBe('0');
    expect(receivable.closing.balance).toBe('100000');

    const travel = await getGeneralLedger(page.request, travelAccountId);
    expect(travel.closing.debits).toBe('42500');
    expect(travel.closing.credits).toBe('0');

    // 2010 receives two credits (the PO's own bill and the expense) and one
    // debit (the expense's reimbursement) — see the arithmetic in this
    // file's header for why the closing balance is exactly the PO-derived
    // bill's own total: that bill is never paid in this narrative.
    const payable = await getGeneralLedger(page.request, apControlAccountId);
    expect(payable.closing.debits).toBe('42500');
    expect(payable.closing.credits).toBe('207500');
    expect(payable.closing.balance).toBe('-165000');

    const bank = await getGeneralLedger(page.request, bankLedgerAccountId);
    expect(bank.closing.debits).toBe('0');
    expect(bank.closing.credits).toBe('42500');
    expect(bank.closing.balance).toBe('-42500');

    const issuedPayment = await getIssuedPayment(page.request, issuedPaymentId);
    expect(issuedPayment.reference).toBeNull();
  });
});
