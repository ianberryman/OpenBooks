import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chartByCode, seedBankAccount } from './support/banking';
import { currentMonth, newRegistration } from './support/books';
import { addDays, createPaymentTerm, getDiscountSuggestion } from './support/cash-application';
import {
  buildPayBillsQueue,
  clearStatementLineByLinkingJournal,
  createAndApproveBill,
  createAndApproveVendorCredit,
  createVendor,
  getBill,
  getIssuedPayment,
  issuePendingPayment,
  listPayableBills,
  nominateDiscountReceivedAccount,
} from './support/pay-bills';
import {
  createAccount,
  getGeneralLedger,
  importPayoutDeposit,
  listUnclearedLines,
  waitForImportComplete,
} from './support/payments';

/**
 * The Pay Bills narrative (OB-118; ROADMAP D-63…D-69, D-109…D-112; initiative G,
 * criteria G1…G8).
 *
 * A Pay Bills run settles more than "pay this bill": a controller builds a queue
 * that reserves several bills' `committed` without touching the ledger (D-64,
 * G1), a settlement discount and a vendor credit both shrink what actually has to
 * move as cash, the payment fans out across whichever rails the vendor is paid on
 * (G6), and issuing is a distinct, separately gated act from building the queue
 * (D-109, G7). One vendor, two bills, one discount, one vendor credit, two rails,
 * and the check's own disbursement matched back against a bank line is the
 * smallest story that exercises all of that at once.
 *
 * ## Why this narrative is API-first, like OB-142's and OB-153's
 *
 * `cash-application.spec.ts` gives the reasoning this one borrows outright: the
 * assertions that matter are cents-exact ledger directions — the payables control
 * account debited down to zero, the bank account credited for each disbursement,
 * the discount landing in the nominated account — best read off
 * `GET /v1/reports/general-ledger` and `GET /v1/bills/{id}` exactly as a person
 * would read them, not scraped off a screen that repeats the same figures in
 * several places. `screens/pay-bills.tsx` and its dialogs (queue, issue, batch-
 * issue, cancel, disbursement-details) are a real screen, but driving them through
 * two bills, a discount, a vendor credit and two rails to reach the same
 * cents-exact assertions would be a second narrative wearing this one's clothes
 * (D-26) — that screen's own component/integration coverage is where its clicks
 * are proven. What is new here, and what nothing else covers, is the seam: that
 * building a queue truly posts nothing, that issuing posts exactly one balanced
 * journal per vendor with the discount and the credit landing correctly beside
 * it, and that the resulting disbursement is real enough to match against a bank
 * statement.
 *
 * ## What this narrative narrows, and why
 *
 * - **The batch issue endpoint (`POST /v1/disbursements/issue`) is not driven.**
 *   It takes one `date` for the whole call and no per-payment `reference`, and
 *   this narrative needs the ACH payment to carry its own supplied trace — only
 *   the singular `POST /v1/pending-payments/{id}/issue` has room for that. Both
 *   payments are issued through the singular endpoint instead; the batch
 *   endpoint's own atomicity guarantee (G2/D-63, one failure per vendor) is a
 *   property of `issuePendingPayment` either way, since the batch is a loop over
 *   it (`issue.service.ts`).
 * - **Vendor disbursement details are not set.** `preferredPaymentRail` and the
 *   ACH/wire coordinates on the contact seed a new pending payment's *default*
 *   rail; this narrative states the rail explicitly on each pending payment
 *   instead, so the default is never read.
 * - **How much of a vendor credit `appliedVendorCreditId` consumes is not on the
 *   wire** — only the credit's id is (`pendingPaymentIntentInputSchema`).
 *   `issue.service.ts`'s own header flags this as an inferred reading, not one
 *   the OB-111/112 spec pinned: at issue, whatever the bill still owes once its
 *   own `payAmount` and any discount have landed is what the credit clears, capped
 *   by the credit's own remaining balance. This narrative's numbers are chosen so
 *   that reading is exercised exactly at its boundary — the vendor credit's whole
 *   balance is exactly what Bill B has left after its `payAmount` — which is the
 *   sharpest check available without a second call the wire does not offer.
 *
 * ## The arithmetic, written down
 *
 * ```
 *   Bill A   gross   100000  (1,000.00)  — 2/10 Net 30, discount taken
 *     discount         2000  (   20.00)  — 2% early-pay, to discount-received
 *     pay amount      98000  (  980.00)  — the check
 *   Bill B   gross    60000  (  600.00)  — no term
 *     vendor credit   15000  (  150.00)  — approved, applied whole to Bill B
 *     pay amount      45000  (  450.00)  — the ACH transfer
 * ```
 *
 * Both bills reach `outstanding: '0'` by different arithmetic — A by cash plus a
 * discount, B by cash plus a credit — and the payables control account nets to
 * zero exactly when both have.
 */

const VENDOR = 'Fixture Supply Co';

const BILL_A_GROSS_MINOR = '100000'; // 1,000.00
const DISCOUNT_RATE_PPM = 20_000; // 2% — `2/10 Net 30`.
const DISCOUNT_WINDOW_DAYS = 10;
const NET_DAYS = 30;
const BILL_A_DISCOUNT_MINOR = '2000'; // 2% of 1,000.00.
const BILL_A_PAY_MINOR = '98000'; // 1,000.00 − 20.00.

const BILL_B_GROSS_MINOR = '60000'; // 600.00
const VENDOR_CREDIT_MINOR = '15000'; // 150.00 — exactly what Bill B has left after its payAmount.
const BILL_B_PAY_MINOR = '45000'; // 600.00 − 150.00.

const ACH_TRACE = 'ACH-TRACE-88123';

test('a Pay Bills queue carries a discount and a vendor credit, issues across a check and an ACH rail, and the check clears against a bank line', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const today = month.day(new Date().getDate());
  const fiscalYear = new Date().getFullYear();

  let discountReceivedAccountId: string;
  let vendorId: string;
  let billAId: string;
  let billBId: string;
  let vendorCreditId: string;
  let bankAccountId: string;
  let bankLedgerAccountId: string;

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

    // The starter chart's own template nominates the AP payables control account
    // (code 2010) as part of applying it (`chart-templates.service.ts`) — nothing
    // else here has to set one up. Nothing posts before a fiscal year exists
    // (D-17), which every approval and every issue below needs.
    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: { 'idempotency-key': randomUUID() },
      data: { fiscalYear },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  await test.step('set up the bank account and the discount-received nomination', async () => {
    const chart = await chartByCode(page.request);
    const accountId = (code: string): string => {
      const id = chart.get(code);
      if (id === undefined) throw new Error(`The starter chart has no account ${code}.`);
      return id;
    };

    bankLedgerAccountId = accountId('1010');
    const bankAccount = await seedBankAccount(page.request, {
      accountId: bankLedgerAccountId,
      name: 'Operating Checking',
      institutionName: 'Meridian Bank',
      externalAccountId: 'CHK-9912',
    });
    bankAccountId = bankAccount.id;

    // D-103's "nominate, don't invent" reasoning applies here as it did in
    // `cash-application.spec.ts`: the starter chart has no purchase-discount
    // account, and the *received* side must be `revenue`-typed
    // (`discount-accounts.ts`'s own `REQUIRED_TYPE`), so this org wires one up
    // the day it first confirms a vendor's early-pay discount.
    discountReceivedAccountId = await createAccount(page.request, {
      code: '4095',
      name: 'Early payment discounts received',
      type: 'revenue',
      normalBalance: 'credit',
    });
    const nomination = await nominateDiscountReceivedAccount(
      page.request,
      discountReceivedAccountId,
    );
    expect(nomination.discountReceivedAccountId).toBe(discountReceivedAccountId);
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

  await test.step('add the vendor, raise and approve two bills (one on the term), and an approved vendor credit', async () => {
    const chart = await chartByCode(page.request);
    const advertisingAccountId = chart.get('6010');
    const repairsAccountId = chart.get('6090');
    if (advertisingAccountId === undefined || repairsAccountId === undefined) {
      throw new Error('The starter chart is missing 6010 or 6090.');
    }

    vendorId = await createVendor(page.request, VENDOR);

    billAId = await createAndApproveBill(page.request, {
      contactId: vendorId,
      issueDate: today,
      expenseAccountId: advertisingAccountId,
      description: 'Trade show signage',
      grossMinor: BILL_A_GROSS_MINOR,
      reference: 'INV-8841',
      paymentTermId,
    });
    billBId = await createAndApproveBill(page.request, {
      contactId: vendorId,
      issueDate: today,
      expenseAccountId: repairsAccountId,
      description: 'Warehouse racking repair',
      grossMinor: BILL_B_GROSS_MINOR,
      reference: 'INV-8842',
    });

    // I1's own check, restated for a bill: the term computes `dueDate` as
    // `issueDate + netDays` on the one bill that named it.
    const billA = await getBill(page.request, billAId);
    expect(billA.dueDate).toBe(addDays(today, NET_DAYS));
    expect(billA.totals.gross).toBe(BILL_A_GROSS_MINOR);

    vendorCreditId = await createAndApproveVendorCredit(page.request, {
      contactId: vendorId,
      issueDate: today,
      expenseAccountId: repairsAccountId,
      description: 'Credit for damaged racking, returned',
      grossMinor: VENDOR_CREDIT_MINOR,
    });
  });

  await test.step('preview the early-pay discount on Bill A, before any payment is built', async () => {
    const suggestion = await getDiscountSuggestion(page.request, {
      targetType: 'bill',
      targetId: billAId,
      asOfDate: today,
    });
    if (suggestion === null) {
      throw new Error('Expected a discount suggestion within the window; got none (204).');
    }

    // The AP mirror of I4: computed from the term (2% of the gross), against the
    // org's nominated *received* account — never auto-posted, only previewed
    // here. This is the figure the pending payment's `discountAmount` below
    // confirms.
    expect(suggestion.discountAmountMinor).toBe(BILL_A_DISCOUNT_MINOR);
    expect(suggestion.accountId).toBe(discountReceivedAccountId);
    expect(suggestion.deadline).toBe(addDays(today, DISCOUNT_WINDOW_DAYS));
  });

  let payablesControlAccountId: string;
  let baselineDebits: string;
  let baselineCredits: string;
  let baselineBalance: string;

  await test.step('the payables control account before any queue is built — the baseline the next step proves unchanged', async () => {
    const chart = await chartByCode(page.request);
    const controlId = chart.get('2010');
    if (controlId === undefined) throw new Error('The starter chart has no account 2010.');
    payablesControlAccountId = controlId;

    // Two bills approved (credit 100000 + 60000) and one vendor credit approved
    // (debit 15000) is everything that has posted so far: 15000 − 160000.
    const ledger = await getGeneralLedger(page.request, payablesControlAccountId);
    expect(ledger.closing.debits).toBe('15000');
    expect(ledger.closing.credits).toBe('160000');
    expect(ledger.closing.balance).toBe('-145000');

    baselineDebits = ledger.closing.debits;
    baselineCredits = ledger.closing.credits;
    baselineBalance = ledger.closing.balance;
  });

  let checkPendingPaymentId: string;
  let achPendingPaymentId: string;

  await test.step('build the Pay Bills queue — a settlement discount on Bill A, the vendor credit on Bill B, routed to a check and an ACH — and assert nothing has posted yet (G1)', async () => {
    const queue = await buildPayBillsQueue(page.request, [
      {
        contactId: vendorId,
        bankAccountId,
        rail: 'check',
        memo: 'Fixture Supply Co — July disbursement',
        intents: [
          {
            billId: billAId,
            payAmount: BILL_A_PAY_MINOR,
            discountAmount: BILL_A_DISCOUNT_MINOR,
            discountAccountId: discountReceivedAccountId,
          },
        ],
      },
      {
        contactId: vendorId,
        bankAccountId,
        rail: 'ach',
        memo: 'Fixture Supply Co — July disbursement',
        intents: [
          { billId: billBId, payAmount: BILL_B_PAY_MINOR, appliedVendorCreditId: vendorCreditId },
        ],
      },
    ]);

    expect(queue).toHaveLength(2);
    const [checkPayment, achPayment] = queue;
    if (checkPayment === undefined || achPayment === undefined) {
      throw new Error('Expected two pending payments.');
    }
    expect(checkPayment.rail).toBe('check');
    expect(checkPayment.status).toBe('open');
    expect(checkPayment.totalAmount).toBe(BILL_A_PAY_MINOR);
    expect(achPayment.rail).toBe('ach');
    expect(achPayment.totalAmount).toBe(BILL_B_PAY_MINOR);
    checkPendingPaymentId = checkPayment.id;
    achPendingPaymentId = achPayment.id;

    // D-64: a pending payment is pencil. Neither bill's `outstanding` has moved,
    // and the payables control account reads exactly as it did before the queue
    // existed.
    const billA = await getBill(page.request, billAId);
    const billB = await getBill(page.request, billBId);
    expect(billA.settlement.outstanding).toBe(BILL_A_GROSS_MINOR);
    expect(billB.settlement.outstanding).toBe(BILL_B_GROSS_MINOR);

    const ledger = await getGeneralLedger(page.request, payablesControlAccountId);
    expect(ledger.closing.debits).toBe(baselineDebits);
    expect(ledger.closing.credits).toBe(baselineCredits);
    expect(ledger.closing.balance).toBe(baselineBalance);

    // G4: `availableToPay = outstanding − committed`, so an open pending payment
    // already reduces what a second one could still queue against the same
    // bill — the "not re-queueable" half of the claim. `committed` never counts
    // the discount or the credit, only the cash `payAmount` reserved.
    const payable = await listPayableBills(page.request);
    const payableA = payable.find((bill) => bill.billId === billAId);
    const payableB = payable.find((bill) => bill.billId === billBId);
    if (payableA === undefined || payableB === undefined) {
      throw new Error('Expected both bills on the Pay Bills window.');
    }
    expect(payableA.committed).toBe(BILL_A_PAY_MINOR);
    expect(payableA.availableToPay).toBe(BILL_A_DISCOUNT_MINOR); // 100000 − 98000 committed.
    expect(payableB.committed).toBe(BILL_B_PAY_MINOR);
    expect(payableB.availableToPay).toBe(VENDOR_CREDIT_MINOR); // 60000 − 45000 committed.
  });

  let checkPaymentId: string;
  let checkNumber: string;
  let achPaymentId: string;

  await test.step('issue both pending payments (G2, G7) — the check draws a number, the ACH carries its supplied trace (G6)', async () => {
    const checkOutcome = await issuePendingPayment(page.request, checkPendingPaymentId, {
      date: today,
    });
    expect(checkOutcome.status).toBe('issued');
    if (checkOutcome.paymentId === null || checkOutcome.checkNumber === null) {
      throw new Error('Expected a paymentId and a checkNumber on the check outcome.');
    }
    checkPaymentId = checkOutcome.paymentId;
    checkNumber = checkOutcome.checkNumber;

    const achOutcome = await issuePendingPayment(page.request, achPendingPaymentId, {
      date: today,
      reference: ACH_TRACE,
    });
    expect(achOutcome.status).toBe('issued');
    expect(achOutcome.checkNumber).toBeNull();
    if (achOutcome.paymentId === null) {
      throw new Error('Expected a paymentId on the ACH outcome.');
    }
    achPaymentId = achOutcome.paymentId;
  });

  await test.step('the ledger ties out: the payables control account nets to zero, the bank is credited, and the discount landed in its nominated account', async () => {
    const controlLedger = await getGeneralLedger(page.request, payablesControlAccountId);
    // 15000 (vendor credit) + 98000 (Bill A payAmount) + 2000 (discount) + 45000
    // (Bill B payAmount) = 160000, matching the 160000 credited at approval — the
    // account both bills' full settlement clears to zero (G1/G2, D-65).
    expect(controlLedger.closing.debits).toBe('160000');
    expect(controlLedger.closing.credits).toBe('160000');
    expect(controlLedger.closing.balance).toBe('0');

    const bankLedger = await getGeneralLedger(page.request, bankLedgerAccountId);
    expect(bankLedger.closing.debits).toBe('0');
    expect(bankLedger.closing.credits).toBe('143000'); // 98000 + 45000
    expect(bankLedger.closing.balance).toBe('-143000');

    const discountLedger = await getGeneralLedger(page.request, discountReceivedAccountId);
    expect(discountLedger.entries).toHaveLength(1);
    expect(discountLedger.entries[0]?.debit).toBe('0');
    expect(discountLedger.entries[0]?.credit).toBe(BILL_A_DISCOUNT_MINOR);
    expect(discountLedger.closing.balance).toBe(`-${BILL_A_DISCOUNT_MINOR}`);

    // Both bills reach zero by different arithmetic — A by cash plus a discount,
    // B by cash plus the whole of the vendor credit — and both are gone from the
    // Pay Bills window (it lists only the not-fully-paid).
    const billA = await getBill(page.request, billAId);
    const billB = await getBill(page.request, billBId);
    expect(billA.settlement.outstanding).toBe('0');
    expect(billB.settlement.outstanding).toBe('0');

    const payable = await listPayableBills(page.request);
    expect(payable.some((bill) => bill.billId === billAId)).toBe(false);
    expect(payable.some((bill) => bill.billId === billBId)).toBe(false);

    // G6: the rail's own identifier lands on the payment — the drawn check
    // number for `check`, the supplied trace for `ach`.
    const checkPayment = await getIssuedPayment(page.request, checkPaymentId);
    expect(checkPayment.reference).toBe(checkNumber);
    const achPayment = await getIssuedPayment(page.request, achPaymentId);
    expect(achPayment.reference).toBe(ACH_TRACE);
  });

  await test.step("match the check's own disbursement against an imported bank line — the seam nothing else covers", async () => {
    const checkPayment = await getIssuedPayment(page.request, checkPaymentId);

    // A one-line statement for the check's own outflow — a real bank export
    // would show it as a negative, exactly the magnitude the check was drawn
    // for (never the discount, which moved no cash).
    const importId = await importPayoutDeposit(page.request, {
      bankAccountId,
      postedDate: today,
      description: 'CHECK DISBURSEMENT',
      amount: '-980.00',
    });
    await waitForImportComplete(page.request, importId);

    const uncleared = await listUnclearedLines(page.request, bankAccountId);
    expect(uncleared).toHaveLength(1);
    const line = uncleared[0];
    if (line === undefined) throw new Error('Expected one uncleared statement line.');
    expect(line.amount).toBe(`-${BILL_A_PAY_MINOR}`);

    // `link_entry`: the ledger already knows this movement — the check payment's
    // own journal — so clearing links the two rather than posting a second
    // entry. `clearedAmount` is the linked journal's own net bank movement,
    // which matches the line exactly, leaving no difference.
    const clearing = await clearStatementLineByLinkingJournal(
      page.request,
      line.id,
      checkPayment.journalId,
    );
    expect(clearing.clearedAmount).toBe(`-${BILL_A_PAY_MINOR}`);
    expect(clearing.differenceAmount).toBe('0');

    // Linking posts nothing new — the bank account's own ledger is exactly as
    // it read at the end of the previous step.
    const bankLedger = await getGeneralLedger(page.request, bankLedgerAccountId);
    expect(bankLedger.closing.credits).toBe('143000');
  });
});
