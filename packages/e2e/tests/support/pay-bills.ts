import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * The Pay Bills vocabulary the OB-118 narrative is written in (ROADMAP D-63…D-69,
 * D-109…D-112; initiative G, criteria G1…G8).
 *
 * `support/payments.ts` and `support/banking.ts` already carry the generic pieces
 * this narrative also needs — creating an account, seeding a bank account, reading
 * the general ledger, importing and polling a one-line statement, listing uncleared
 * lines — and this file does not restate any of those; the spec imports them
 * directly. `support/cash-application.ts` carries the payment-term vocabulary
 * (`createPaymentTerm`, `getDiscountSuggestion`, `addDays`), which is AR/AP-shared
 * (D-108) and likewise imported straight from there rather than copied. What is new
 * here is specific to Pay Bills: vendors, bills, vendor credits, the discount-
 * *received* nomination (the AP mirror of `nominateDiscountGivenAccount`), the
 * pending-payment queue and its issue, reading a materialised `Payment` back for its
 * `reference`, and clearing a statement line by *linking* it to a journal that
 * already exists — the one clearing method none of the other narratives needed,
 * because none of them cleared a payment's own disbursement against a bank line.
 *
 * `@openbooks/shared-types` is not a dependency of this package, so every shape
 * below is the wire contract as `pay-bills.ts`, `subledger/bills.ts` and
 * `banking/clearing.ts` publish it, typed just enough for this narrative to build a
 * request and read a response — `cash-application.ts`'s own header gives the reason.
 */

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** A fresh key per call: each is one intent, issued once, never retried by hand. */
function writeHeaders(): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: randomUUID() };
}

// ---------------------------------------------------------------------------
// The vendor, its bills, and an approved vendor credit
// ---------------------------------------------------------------------------

interface ContactResponse {
  readonly id: string;
}

/** Creates a vendor contact, and returns its id — `createCustomer`'s AP mirror. */
export async function createVendor(
  request: APIRequestContext,
  displayName: string,
): Promise<string> {
  const response = await request.post('/v1/contacts', {
    headers: writeHeaders(),
    data: { displayName, isVendor: true },
  });
  expect(response.ok(), `POST /v1/contacts → ${String(response.status())}`).toBeTruthy();
  const contact = (await response.json()) as ContactResponse;
  return contact.id;
}

export interface CreateAndApproveBillInput {
  readonly contactId: string;
  readonly issueDate: string;
  readonly expenseAccountId: string;
  readonly description: string;
  /** The line's unit price, in minor units — quantity is always 1, so this is the gross total. */
  readonly grossMinor: string;
  readonly reference?: string;
  /** Overrides the vendor's default term for this one bill (create-only, D-108). */
  readonly paymentTermId?: string;
}

interface BillResponse {
  readonly id: string;
  readonly dueDate: string;
  readonly totals: { readonly gross: string };
  readonly settlement: { readonly outstanding: string };
}

/** Creates a draft bill and approves it in the same breath, returning its id. */
export async function createAndApproveBill(
  request: APIRequestContext,
  input: CreateAndApproveBillInput,
): Promise<string> {
  const created = await request.post('/v1/bills', {
    headers: writeHeaders(),
    data: {
      contactId: input.contactId,
      issueDate: input.issueDate,
      taxMode: 'exclusive',
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      ...(input.paymentTermId === undefined ? {} : { paymentTermId: input.paymentTermId }),
      lines: [
        {
          description: input.description,
          quantity: '1',
          unitAmount: input.grossMinor,
          accountId: input.expenseAccountId,
        },
      ],
    },
  });
  expect(created.ok(), `POST /v1/bills → ${String(created.status())}`).toBeTruthy();
  const bill = (await created.json()) as BillResponse;

  const approved = await request.post(`/v1/bills/${bill.id}/approve`, { headers: writeHeaders() });
  expect(approved.ok(), `POST /v1/bills/{id}/approve → ${String(approved.status())}`).toBeTruthy();

  return bill.id;
}

/** Re-reads a bill — used to read `dueDate` and `settlement.outstanding`. */
export async function getBill(request: APIRequestContext, billId: string): Promise<BillResponse> {
  const response = await request.get(`/v1/bills/${billId}`);
  expect(response.ok(), `GET /v1/bills/{id} → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as BillResponse;
}

export interface CreateAndApproveVendorCreditInput {
  readonly contactId: string;
  readonly issueDate: string;
  readonly expenseAccountId: string;
  readonly description: string;
  readonly grossMinor: string;
}

interface VendorCreditResponse {
  readonly id: string;
}

/**
 * Creates a draft vendor credit and approves it, returning its id. Approving posts
 * the mirror of a bill's journal — debiting payables, crediting the expense
 * account named here — which is what makes the credit available to apply; applying
 * it to a bill happens later, at issue (D-39, `bills.ts`'s own header).
 */
export async function createAndApproveVendorCredit(
  request: APIRequestContext,
  input: CreateAndApproveVendorCreditInput,
): Promise<string> {
  const created = await request.post('/v1/vendor-credits', {
    headers: writeHeaders(),
    data: {
      contactId: input.contactId,
      issueDate: input.issueDate,
      taxMode: 'exclusive',
      lines: [
        {
          description: input.description,
          quantity: '1',
          unitAmount: input.grossMinor,
          accountId: input.expenseAccountId,
        },
      ],
    },
  });
  expect(created.ok(), `POST /v1/vendor-credits → ${String(created.status())}`).toBeTruthy();
  const vendorCredit = (await created.json()) as VendorCreditResponse;

  const approved = await request.post(`/v1/vendor-credits/${vendorCredit.id}/approve`, {
    headers: writeHeaders(),
  });
  expect(
    approved.ok(),
    `POST /v1/vendor-credits/{id}/approve → ${String(approved.status())}`,
  ).toBeTruthy();

  return vendorCredit.id;
}

// ---------------------------------------------------------------------------
// The discount-received account nomination — the AP mirror of
// `nominateDiscountGivenAccount` (D-106, D-107)
// ---------------------------------------------------------------------------

interface DiscountAccountsResponse {
  readonly discountGivenAccountId: string | null;
  readonly discountReceivedAccountId: string | null;
}

/**
 * Nominates the org's discount-received account — the income side a vendor's
 * early-pay discount credits (D-106). `PATCH`, not `PUT`
 * (`nominateDiscountGivenAccount`'s own reason): this narrative never gives a
 * customer's discount, so `discountGivenAccountId` is left untouched.
 */
export async function nominateDiscountReceivedAccount(
  request: APIRequestContext,
  discountReceivedAccountId: string,
): Promise<DiscountAccountsResponse> {
  const response = await request.patch('/v1/settings/discount-accounts', {
    headers: writeHeaders(),
    data: { discountReceivedAccountId },
  });
  expect(
    response.ok(),
    `PATCH /v1/settings/discount-accounts → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as DiscountAccountsResponse;
}

// ---------------------------------------------------------------------------
// The pending-payment queue (D-63, D-64, D-68) — pencil until issue
// ---------------------------------------------------------------------------

/** Restated from `pendingPaymentIntentInputSchema` — one bill's share of a payment. */
export interface PendingPaymentIntentInput {
  readonly billId: string;
  readonly payAmount: string;
  /** Supplied together with `discountAccountId`, or omitted together. */
  readonly discountAmount?: string;
  readonly discountAccountId?: string;
  readonly appliedVendorCreditId?: string;
}

export type PaymentRail = 'check' | 'ach' | 'wire';

/** Restated from `createPendingPaymentRequestSchema` — one vendor, one rail. */
export interface CreatePendingPaymentInput {
  readonly contactId: string;
  readonly bankAccountId: string;
  readonly rail: PaymentRail;
  readonly memo?: string;
  readonly intents: readonly PendingPaymentIntentInput[];
}

export interface PendingPaymentIntent {
  readonly id: string;
  readonly billId: string;
  readonly payAmount: string;
  readonly discountAmount: string | null;
  readonly discountAccountId: string | null;
  readonly appliedVendorCreditId: string | null;
}

export interface PendingPayment {
  readonly id: string;
  readonly contactId: string;
  readonly bankAccountId: string;
  readonly rail: PaymentRail;
  readonly status: 'open' | 'issued' | 'cancelled';
  readonly issuedPaymentId: string | null;
  readonly intents: readonly PendingPaymentIntent[];
  readonly totalAmount: string;
}

interface PendingPaymentListResponse {
  readonly pendingPayments: readonly PendingPayment[];
}

/**
 * Builds a batch of pending payments in one call — one per vendor (D-63), though
 * this narrative's fan-out is one vendor across two rails, which is just as valid
 * a batch: each element is built independently, so one vendor's refusal never
 * loses the rest. Posts no journal (D-64) — only `buildPendingPayment`'s own
 * reservation of each named bill's `committed`.
 */
export async function buildPayBillsQueue(
  request: APIRequestContext,
  payments: readonly CreatePendingPaymentInput[],
): Promise<readonly PendingPayment[]> {
  const response = await request.post('/v1/pay-bills', {
    headers: writeHeaders(),
    data: { payments },
  });
  expect(response.ok(), `POST /v1/pay-bills → ${String(response.status())}`).toBeTruthy();
  const result = (await response.json()) as PendingPaymentListResponse;
  return result.pendingPayments;
}

/** Restated from `payableBillSchema` — one bill on the Pay Bills window. */
export interface PayableBill {
  readonly billId: string;
  readonly outstanding: string;
  readonly committed: string;
  readonly availableToPay: string;
}

interface PayableBillListResponse {
  readonly bills: readonly PayableBill[];
}

/**
 * The Pay Bills window: every approved, non-void, not-fully-paid bill, with
 * `outstanding`, `committed` and `availableToPay` computed on read (D-34, D-68).
 */
export async function listPayableBills(
  request: APIRequestContext,
): Promise<readonly PayableBill[]> {
  const response = await request.get('/v1/payable-bills');
  expect(response.ok(), `GET /v1/payable-bills → ${String(response.status())}`).toBeTruthy();
  const page = (await response.json()) as PayableBillListResponse;
  return page.bills;
}

// ---------------------------------------------------------------------------
// Issuing a pending payment (D-65, D-110…D-112) — the separation-of-duties gate
// ---------------------------------------------------------------------------

export interface IssuePendingPaymentInput {
  readonly date: string;
  /** The rail's own trace/confirmation for `ach`/`wire` — left absent for `check`. */
  readonly reference?: string;
}

export interface IssueOutcome {
  readonly pendingPaymentId: string;
  readonly status: 'issued' | 'failed';
  readonly paymentId: string | null;
  readonly checkNumber: string | null;
  readonly error: string | null;
}

/**
 * Issues one pending payment, materialising it into a real `Payment` — the
 * journal, the `payAmount` allocations, any settlement discount, and any applied
 * vendor credit all post in one transaction (D-65). Called once per pending
 * payment rather than through the batch `/v1/disbursements/issue` endpoint,
 * because the batch shape takes one `date` for the whole call and no per-payment
 * `reference` — this narrative needs the ACH payment to carry its own supplied
 * trace, which only the singular endpoint's body has room for.
 */
export async function issuePendingPayment(
  request: APIRequestContext,
  pendingPaymentId: string,
  input: IssuePendingPaymentInput,
): Promise<IssueOutcome> {
  const response = await request.post(`/v1/pending-payments/${pendingPaymentId}/issue`, {
    headers: writeHeaders(),
    data: input,
  });
  expect(
    response.ok(),
    `POST /v1/pending-payments/{id}/issue → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as IssueOutcome;
}

// ---------------------------------------------------------------------------
// Reading the materialised Payment back — `reference` carries the rail's trace
// ---------------------------------------------------------------------------

export interface IssuedPayment {
  readonly id: string;
  readonly reference: string | null;
  /** The journal this payment posted — what a `link_entry` clear below names. */
  readonly journalId: string;
}

export async function getIssuedPayment(
  request: APIRequestContext,
  paymentId: string,
): Promise<IssuedPayment> {
  const response = await request.get(`/v1/payments/${paymentId}`);
  expect(response.ok(), `GET /v1/payments/{id} → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as IssuedPayment;
}

// ---------------------------------------------------------------------------
// Matching the check's disbursement against a bank line (`link_entry`, D-43)
// ---------------------------------------------------------------------------

interface LineClearing {
  readonly clearedAmount: string;
  readonly differenceAmount: string;
}

/**
 * Clears a statement line by linking it to a journal that already exists
 * (`method: 'link_entry'`) — the shape none of the other narratives needed,
 * because none of them cleared a payment's own disbursement against a bank
 * line. `link_entry` carries no `amount`: what it accounts for is the linked
 * journal's own net movement on the bank account, a fact rather than a choice
 * (`clearing.ts`'s own header), which is exactly the check payment's `-payAmount`
 * on this account.
 */
export async function clearStatementLineByLinkingJournal(
  request: APIRequestContext,
  lineId: string,
  journalId: string,
): Promise<LineClearing> {
  const response = await request.post(`/v1/statement-lines/${lineId}/clearing`, {
    headers: writeHeaders(),
    data: { entries: [{ method: 'link_entry', journalId }] },
  });
  expect(
    response.ok(),
    `POST /v1/statement-lines/{id}/clearing → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as LineClearing;
}
