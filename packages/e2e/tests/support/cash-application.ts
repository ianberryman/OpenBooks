import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * The cash-application vocabulary the OB-142 narrative is written in (ROADMAP
 * D-79…D-81, D-105…D-108; initiative I, criteria I2…I4, I7).
 *
 * Restated rather than imported: `@openbooks/shared-types` is not a dependency of
 * this package (`support/payments.ts`'s own header gives the reason), so every
 * shape below is the wire contract as `payment-terms.ts` and `clearing.ts`
 * publish it, typed just enough for this narrative to build a request and read a
 * response.
 *
 * `support/payments.ts` and `support/banking.ts` already carry the generic
 * pieces this narrative also needs — creating an account, creating a customer,
 * reading the general ledger, importing a one-line statement — and this file
 * does not restate any of those; the spec imports them directly. What is new
 * here is specific to Cash application: payment terms, the discount-account
 * nomination, an invoice that can carry a term, the discount-suggestion
 * preview, and the multi-entry clear (`entries` as an array, where every other
 * narrative's clear was still the one-element case).
 */

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** A fresh key per call: each is one intent, issued once, never retried by hand. */
function writeHeaders(): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: randomUUID() };
}

// ---------------------------------------------------------------------------
// Calendar arithmetic — the due date and the discount deadline are both
// `issueDate + N days`, and there is no screen here to read either off.
// ---------------------------------------------------------------------------

/**
 * `iso + days`, in UTC so the answer does not depend on the runner's own
 * timezone — a calendar date on the wire (`calendarDateSchema`) has no time
 * component, and parsing `"2026-07-29"` as `"2026-07-29T00:00:00Z"` is what
 * keeps day-of-month arithmetic exact across a month or a year boundary.
 */
export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The discount-given account nomination (D-106, D-107)
// ---------------------------------------------------------------------------

interface DiscountAccountsResponse {
  readonly discountGivenAccountId: string | null;
  readonly discountReceivedAccountId: string | null;
}

/**
 * Nominates the org's discount-given account — the expense side `2/10 Net 30`'s
 * confirmed discount debits (D-106). `PATCH`, not `PUT` (`settings.ts`'s own
 * header): an omitted side is left alone, so this narrative, which never gives
 * a vendor's discount, leaves `discountReceivedAccountId` untouched.
 */
export async function nominateDiscountGivenAccount(
  request: APIRequestContext,
  discountGivenAccountId: string,
): Promise<DiscountAccountsResponse> {
  const response = await request.patch('/v1/settings/discount-accounts', {
    headers: writeHeaders(),
    data: { discountGivenAccountId },
  });
  expect(
    response.ok(),
    `PATCH /v1/settings/discount-accounts → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as DiscountAccountsResponse;
}

// ---------------------------------------------------------------------------
// Payment terms (D-79)
// ---------------------------------------------------------------------------

export interface CreatePaymentTermInput {
  readonly name: string;
  readonly netDays: number;
  /** Supplied together with `discountWindowDays`, or omitted together — a simple term. */
  readonly discountRatePpm?: number;
  readonly discountWindowDays?: number;
}

interface PaymentTermResponse {
  readonly id: string;
}

/** Creates a payment term (active), and returns its id. */
export async function createPaymentTerm(
  request: APIRequestContext,
  input: CreatePaymentTermInput,
): Promise<string> {
  const response = await request.post('/v1/payment-terms', {
    headers: writeHeaders(),
    data: input,
  });
  expect(response.ok(), `POST /v1/payment-terms → ${String(response.status())}`).toBeTruthy();
  const term = (await response.json()) as PaymentTermResponse;
  return term.id;
}

// ---------------------------------------------------------------------------
// Raising and approving an invoice that may carry a payment term
// ---------------------------------------------------------------------------

export interface CreateAndApproveInvoiceInput {
  readonly contactId: string;
  readonly issueDate: string;
  readonly incomeAccountId: string;
  readonly description: string;
  /** The line's unit price, in minor units — quantity is always 1, so this is the gross total. */
  readonly grossMinor: string;
  /** Overrides the customer's default term for this one invoice (create-only, D-108). */
  readonly paymentTermId?: string;
}

interface InvoiceResponse {
  readonly id: string;
  readonly status: string;
  readonly dueDate: string;
  readonly totals: { readonly gross: string };
  readonly settlement: { readonly outstanding: string };
}

/** Creates a draft invoice and approves it in the same breath, returning its id. */
export async function createAndApproveInvoice(
  request: APIRequestContext,
  input: CreateAndApproveInvoiceInput,
): Promise<string> {
  const created = await request.post('/v1/invoices', {
    headers: writeHeaders(),
    data: {
      contactId: input.contactId,
      issueDate: input.issueDate,
      taxMode: 'exclusive',
      ...(input.paymentTermId === undefined ? {} : { paymentTermId: input.paymentTermId }),
      lines: [
        {
          description: input.description,
          quantity: '1',
          unitAmount: input.grossMinor,
          accountId: input.incomeAccountId,
        },
      ],
    },
  });
  expect(created.ok(), `POST /v1/invoices → ${String(created.status())}`).toBeTruthy();
  const invoice = (await created.json()) as InvoiceResponse;

  const approved = await request.post(`/v1/invoices/${invoice.id}/approve`, {
    headers: writeHeaders(),
  });
  expect(
    approved.ok(),
    `POST /v1/invoices/{id}/approve → ${String(approved.status())}`,
  ).toBeTruthy();

  return invoice.id;
}

/** Re-reads an invoice — used to read `dueDate` (the term's computed due date) and `settlement`. */
export async function getInvoice(
  request: APIRequestContext,
  invoiceId: string,
): Promise<InvoiceResponse> {
  const response = await request.get(`/v1/invoices/${invoiceId}`);
  expect(response.ok(), `GET /v1/invoices/{id} → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as InvoiceResponse;
}

// ---------------------------------------------------------------------------
// The discount-suggestion preview (D-79, D-106, OB-138)
// ---------------------------------------------------------------------------

export interface DiscountSuggestionQuery {
  readonly targetType: 'invoice' | 'bill';
  readonly targetId: string;
  /** "If this were settled today" — the date money is applied, not necessarily today's date. */
  readonly asOfDate: string;
}

export interface DiscountSuggestion {
  readonly targetId: string;
  readonly discountAmountMinor: string;
  readonly deadline: string;
  readonly accountId: string;
}

/**
 * Previews the early-pay discount available on a document, or `null` when none
 * applies — a document with no term, a simple term, or a window already passed
 * answers `204` (`payment-terms.ts`'s own header: an ordinary answer, not a
 * refusal), which this helper turns into `null` rather than a thrown assertion.
 */
export async function getDiscountSuggestion(
  request: APIRequestContext,
  query: DiscountSuggestionQuery,
): Promise<DiscountSuggestion | null> {
  // A named interface has no index signature, so it is built into a plain
  // literal here rather than passed straight to `URLSearchParams` — the same
  // shape `support/payments.ts`'s `lookupPaymentRef` builds its query in.
  const search = new URLSearchParams({
    targetType: query.targetType,
    targetId: query.targetId,
    asOfDate: query.asOfDate,
  });
  const response = await request.get(`/v1/payment-terms/discount-suggestion?${search.toString()}`);
  expect(
    response.ok(),
    `GET /v1/payment-terms/discount-suggestion → ${String(response.status())}`,
  ).toBeTruthy();
  if (response.status() === 204) return null;
  return (await response.json()) as DiscountSuggestion;
}

// ---------------------------------------------------------------------------
// The multi-entry clear (D-80, D-105, D-106, OB-137) — the load-bearing change
// ---------------------------------------------------------------------------

/**
 * One entry of a multi-entry clear, restated from `clearing.ts`'s discriminated
 * union — only the two members this narrative needs (`allocate_document` and
 * `discount`); `post_entry`/`link_entry` are `support/payments.ts`'s own
 * `clearLineToAccount` concern, not this one.
 */
export type ClearingEntryInput =
  | {
      readonly method: 'allocate_document';
      readonly targetType: 'invoice' | 'bill';
      readonly targetId: string;
      readonly amount: string;
    }
  | {
      readonly method: 'discount';
      readonly accountId: string;
      readonly targetType: 'invoice' | 'bill';
      readonly targetId: string;
      readonly amount: string;
    };

interface ClearingEntryResponse {
  readonly id: string;
  readonly entryType: string;
  readonly amount: string;
}

export interface ClearingResult {
  readonly id: string;
  readonly lineId: string;
  readonly entries: readonly ClearingEntryResponse[];
  /** Signed, in the line's frame — the sum of `entries`' amounts, excluding any `discount` (E4). */
  readonly clearedAmount: string;
  readonly differenceAmount: string;
}

/**
 * Clears one statement line against several entries in a single accepted action
 * — the lockbox mechanism (D-80, I2, I3, I7): `entries` carries one
 * `allocate_document` per invoice the deposit settles, plus a `discount` entry
 * where one of them is taking its early-pay discount. Every entry but
 * `discount` must sum to the line's own amount (E4); the discount entry settles
 * the *document* through its own allocation and is excluded from that sum by
 * design (D-106).
 */
export async function clearStatementLineWithEntries(
  request: APIRequestContext,
  lineId: string,
  entries: readonly ClearingEntryInput[],
): Promise<ClearingResult> {
  const response = await request.post(`/v1/statement-lines/${lineId}/clearing`, {
    headers: writeHeaders(),
    data: { entries },
  });
  expect(
    response.ok(),
    `POST /v1/statement-lines/{id}/clearing → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as ClearingResult;
}
