import { createHmac, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * The payment-integration vocabulary the OB-153 narrative is written in (ROADMAP
 * D-82…D-86, D-101…D-104, F9).
 *
 * Everything here is setup or plumbing that is not the point of the narrative — the
 * same reason `support/banking.ts` and `support/books.ts` keep their own vocabularies
 * out of the story they exist to tell. Two things live in this file that have no
 * precedent in the other support modules, because nothing before this ticket needed
 * them:
 *
 * ## Signing a `fake` webhook (D-102)
 *
 * `providers/payment/fake.ts` verifies an inbound delivery by recomputing
 * `HMAC-SHA256(webhookSecret, rawBody)` and comparing it, in hex, against the
 * `x-fake-signature` header. `postFakeWebhook` below signs the *exact* bytes it then
 * sends — `JSON.stringify(event)` computed once and reused for both the digest and
 * the request body — because Playwright would otherwise re-serialize an object body
 * itself, and a signature computed over one serialization and sent over a second,
 * merely-equivalent one is exactly the kind of mismatch this narrative exists to rule
 * out.
 *
 * ## Reading the ledger back over HTTP, not by clicking through it
 *
 * There is no UI screen this narrative could read "a fee journal posted, debit here,
 * credit there" off of — the closest is the general ledger report, and even that
 * would mean a fourth D-26 narrative reproving M2's own reading screen. So the two
 * assertions D-84/D-104 actually rest on — that a payment landed in the clearing
 * account, and that the processor's fee debited the fee account and credited the
 * same clearing account — are read off `GET /v1/reports/general-ledger`, the same
 * report a person would open, reached the way `support/banking.ts` reaches
 * `GET /v1/accounts`: through `page.request`, which is the real Fastify app under the
 * real two-user grant split, not a stub.
 */

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** A fresh key per call: each is one intent, issued once, never retried by hand. */
function writeHeaders(): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: randomUUID() };
}

// ---------------------------------------------------------------------------
// Accounts and contacts — the two nominated accounts an org creates by hand
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  readonly code: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly normalBalance: 'debit' | 'credit';
}

interface AccountResponse {
  readonly id: string;
}

/**
 * Creates one ledger account, and returns its id.
 *
 * The starter chart (`general_small_business`) has no clearing account and no
 * dedicated processor-fee account — a business wires those up itself when it
 * connects a processor (D-103's "nominate, don't invent" applies to the *nominating*
 * side too: an org's chart is the org's, so this narrative creates two accounts
 * rather than repurposing the starter chart's existing 5050 "Merchant and processing
 * fees").
 */
export async function createAccount(
  request: APIRequestContext,
  input: CreateAccountInput,
): Promise<string> {
  const response = await request.post('/v1/accounts', { headers: writeHeaders(), data: input });
  expect(response.ok(), `POST /v1/accounts → ${String(response.status())}`).toBeTruthy();
  const account = (await response.json()) as AccountResponse;
  return account.id;
}

interface ContactResponse {
  readonly id: string;
}

/** Creates a customer contact, and returns its id. */
export async function createCustomer(
  request: APIRequestContext,
  displayName: string,
): Promise<string> {
  const response = await request.post('/v1/contacts', {
    headers: writeHeaders(),
    data: { displayName, isCustomer: true },
  });
  expect(response.ok(), `POST /v1/contacts → ${String(response.status())}`).toBeTruthy();
  const contact = (await response.json()) as ContactResponse;
  return contact.id;
}

// ---------------------------------------------------------------------------
// Connecting the `fake` processor (D-82, D-83, D-103)
// ---------------------------------------------------------------------------

export interface ConnectFakeProcessorInput {
  readonly clearingAccountId: string;
  readonly feeAccountId: string;
  readonly webhookSecret: string;
}

interface ProcessorConnectionResponse {
  readonly id: string;
}

/**
 * Connects the `fake` processor to the two nominated accounts, and returns the
 * connection id the webhook URL and `resolveActiveConnectionForOrg` both key off.
 *
 * `secretKey` is never read back by anything (D-83), so a random value stands in for
 * whatever a real Stripe/Square secret would be — `webhookSecret` is the one the test
 * actually cares about, because it is what `postFakeWebhook` signs against.
 */
export async function connectFakeProcessor(
  request: APIRequestContext,
  input: ConnectFakeProcessorInput,
): Promise<string> {
  const response = await request.post('/v1/processing/connections', {
    headers: writeHeaders(),
    data: {
      processor: 'fake',
      clearingAccountId: input.clearingAccountId,
      feeAccountId: input.feeAccountId,
      secretKey: `fake_secret_${randomUUID()}`,
      webhookSecret: input.webhookSecret,
    },
  });
  expect(
    response.ok(),
    `POST /v1/processing/connections → ${String(response.status())}`,
  ).toBeTruthy();
  const connection = (await response.json()) as ProcessorConnectionResponse;
  return connection.id;
}

interface ProcessorConnectionDetail {
  readonly reconciledThrough: string | null;
}

/** Reads a connection back — used to observe the D-85 poll cursor a payout advances. */
export async function getProcessorConnection(
  request: APIRequestContext,
  connectionId: string,
): Promise<ProcessorConnectionDetail> {
  const response = await request.get(`/v1/processing/connections/${connectionId}`);
  expect(
    response.ok(),
    `GET /v1/processing/connections/{id} → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as ProcessorConnectionDetail;
}

// ---------------------------------------------------------------------------
// Raising, approving and sending the invoice the customer pays
// ---------------------------------------------------------------------------

export interface CreateAndSendInvoiceInput {
  readonly contactId: string;
  readonly issueDate: string;
  readonly incomeAccountId: string;
  readonly description: string;
  /** The line's unit price, in minor units — quantity is always 1, so this is the gross total. */
  readonly grossMinor: string;
}

interface InvoiceResponse {
  readonly id: string;
  readonly status: string;
  readonly settlement: { readonly outstanding: string };
}

/** Creates a draft invoice and approves it in the same breath, returning its id. */
export async function createAndApproveInvoice(
  request: APIRequestContext,
  input: CreateAndSendInvoiceInput,
): Promise<string> {
  const created = await request.post('/v1/invoices', {
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

/** Re-reads an invoice — used to watch `status` move to `paid` (D-38, computed on read). */
export async function getInvoice(
  request: APIRequestContext,
  invoiceId: string,
): Promise<InvoiceResponse> {
  const response = await request.get(`/v1/invoices/${invoiceId}`);
  expect(response.ok(), `GET /v1/invoices/{id} → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as InvoiceResponse;
}

/**
 * Sends the approved invoice, and returns the hosted-page token carried in the
 * delivery's `publicUrl` (`{appBaseUrl}/i/{token}` — `send-invoice.service.ts`'s own
 * construction). The token itself is never on the wire as its own field (D-74's
 * capability-token scheme keeps only a prefix and a hash server-side), so this is the
 * one place that ever has to pick it back out of the link.
 */
export async function sendInvoiceAndGetToken(
  request: APIRequestContext,
  invoiceId: string,
): Promise<string> {
  const response = await request.post(`/v1/invoices/${invoiceId}/send`, {
    headers: writeHeaders(),
    data: {},
  });
  expect(
    response.ok(),
    `POST /v1/invoices/{id}/send → ${String(response.status())}`,
  ).toBeTruthy();
  const delivery = (await response.json()) as { publicUrl: string };

  const token = delivery.publicUrl.split('/i/').pop();
  if (token === undefined || token.length === 0) {
    throw new Error(`Delivery publicUrl ${delivery.publicUrl} carried no /i/{token} segment.`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// The fake processor's webhook — signed the way `fake.ts` verifies it
// ---------------------------------------------------------------------------

/** `NormalizedProcessorEvent`, restated (`@openbooks/plugin-api` is not a dependency here). */
export interface NormalizedProcessorEvent {
  readonly kind: 'charge' | 'fee' | 'refund' | 'dispute' | 'payout';
  readonly externalEventId: string;
  readonly externalObjectId: string;
  readonly invoiceId: string | null;
  readonly grossMinor: string;
  readonly feeMinor: string | null;
  readonly netMinor: string | null;
  readonly occurredAt: string;
}

/**
 * Delivers one webhook event to the `fake` connection, signed the way
 * `createFakePaymentProcessor` verifies it (`providers/payment/fake.ts`): hex
 * `HMAC-SHA256(webhookSecret, rawBody)` in `x-fake-signature`, computed over the
 * *exact* bytes sent.
 *
 * `data` is passed as the already-serialized string, not the object, and
 * `content-type` is set by hand — Playwright's default is to `JSON.stringify` an
 * object body itself, which would compute this signature over one string and send a
 * second, merely-equivalent one. Passing the string directly is what keeps the two
 * identical.
 */
export async function postFakeWebhook(
  request: APIRequestContext,
  connectionId: string,
  webhookSecret: string,
  event: NormalizedProcessorEvent,
): Promise<{ readonly status: string }> {
  const rawBody = JSON.stringify(event);
  const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

  const response = await request.post(`/public/processing/${connectionId}/webhook`, {
    headers: { 'content-type': 'application/json', 'x-fake-signature': signature },
    data: rawBody,
  });
  expect(
    response.ok(),
    `POST /public/processing/{connectionId}/webhook → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as { status: string };
}

// ---------------------------------------------------------------------------
// Reading the ledger back — external refs and the general ledger
// ---------------------------------------------------------------------------

/**
 * Resolves an upstream object id to the OpenBooks entity it produced (D-58) — the
 * same correlation `recordProcessorCharge`'s own idempotency check reads, reached
 * over `GET /v1/external-refs/lookup` rather than by guessing an id off a webhook
 * response that only ever reports `{ status }`.
 */
export async function lookupPaymentRef(
  request: APIRequestContext,
  externalObjectId: string,
): Promise<string> {
  const query = new URLSearchParams({
    externalSystem: 'fake',
    entityType: 'payment',
    externalId: externalObjectId,
  });
  const response = await request.get(`/v1/external-refs/lookup?${query.toString()}`);
  expect(
    response.ok(),
    `GET /v1/external-refs/lookup → ${String(response.status())}`,
  ).toBeTruthy();
  const ref = (await response.json()) as { entityId: string };
  return ref.entityId;
}

export interface Payment {
  readonly id: string;
  readonly accountId: string;
  readonly amount: string;
  readonly direction: string;
}

export async function getPayment(request: APIRequestContext, paymentId: string): Promise<Payment> {
  const response = await request.get(`/v1/payments/${paymentId}`);
  expect(response.ok(), `GET /v1/payments/{id} → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as Payment;
}

interface GlAmounts {
  readonly debits: string;
  readonly credits: string;
  readonly balance: string;
}

interface GlEntry {
  readonly debit: string;
  readonly credit: string;
  readonly journalMemo: string | null;
}

export interface GeneralLedger {
  readonly opening: GlAmounts;
  readonly movement: GlAmounts;
  readonly closing: GlAmounts;
  readonly entries: readonly GlEntry[];
}

/** One account's whole history, all-time (`from`/`to` both omitted) — see this file's header. */
export async function getGeneralLedger(
  request: APIRequestContext,
  accountId: string,
): Promise<GeneralLedger> {
  const response = await request.get(`/v1/reports/general-ledger?accountId=${accountId}`);
  expect(
    response.ok(),
    `GET /v1/reports/general-ledger → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as GeneralLedger;
}

// ---------------------------------------------------------------------------
// The payout's bank deposit — import, then clear against the clearing account
// ---------------------------------------------------------------------------

export interface ImportPayoutDepositInput {
  readonly bankAccountId: string;
  readonly postedDate: string;
  readonly description: string;
  /** A positive decimal, as the bank's own statement would show a deposit — e.g. `"1495.65"`. */
  readonly amount: string;
}

interface QueuedImport {
  readonly id: string;
}

/**
 * Imports a one-line CSV statement for the payout's net deposit, and returns the
 * queued import's id to poll.
 *
 * An inline `mapping` rather than a saved one, matching `support/banking.ts`'s
 * `csvStatement`'s own header row (`Date,Description,Amount`) and default reading
 * (`ymd`/`signed`) — the same shape `banking.spec.ts` drives through the import
 * screen's own defaults, restated here because this narrative reaches the route
 * directly rather than through the mapping editor's UI controls.
 */
export async function importPayoutDeposit(
  request: APIRequestContext,
  input: ImportPayoutDepositInput,
): Promise<string> {
  const row = `${input.postedDate},${input.description},${input.amount}`;
  const content = `Date,Description,Amount\n${row}\n`;

  const response = await request.post('/v1/bank-statement-imports', {
    headers: writeHeaders(),
    data: {
      bankAccountId: input.bankAccountId,
      format: 'csv',
      filename: 'payout.csv',
      content,
      mapping: {
        hasHeaderRow: true,
        delimiter: ',',
        dateOrder: 'ymd',
        amountConvention: 'signed',
        columns: {
          postedDate: 0,
          description: 1,
          amount: 2,
          debit: null,
          credit: null,
          valueDate: null,
          counterparty: null,
          bankReference: null,
        },
      },
    },
  });
  expect(
    response.ok(),
    `POST /v1/bank-statement-imports → ${String(response.status())}`,
  ).toBeTruthy();
  const queued = (await response.json()) as QueuedImport;
  return queued.id;
}

interface CompletedImport {
  readonly status: string;
  readonly result: { readonly linesImported: number } | null;
}

/**
 * Polls a queued import to `complete` (D-47, E10) — the same "parse runs on the
 * worker, so there is no synchronous completion signal" shape
 * `recurring-and-dunning.spec.ts` and `bill-capture.spec.ts` both document for their
 * own async work, applied here to `expect(...).toPass` rather than a `page.reload`
 * loop, because there is no screen in this narrative to reload.
 */
export async function waitForImportComplete(
  request: APIRequestContext,
  importId: string,
): Promise<void> {
  await expect(async () => {
    const response = await request.get(`/v1/bank-statement-imports/${importId}`);
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as CompletedImport;
    expect(body.status).toBe('complete');
  }).toPass({ timeout: 15_000 });
}

interface StatementLine {
  readonly id: string;
  readonly amount: string;
}

interface StatementLinePage {
  readonly items: readonly StatementLine[];
}

/** The uncleared lines on one bank account — this narrative expects exactly one. */
export async function listUnclearedLines(
  request: APIRequestContext,
  bankAccountId: string,
): Promise<readonly StatementLine[]> {
  const query = new URLSearchParams({ bankAccountId, cleared: 'false' });
  const response = await request.get(`/v1/statement-lines?${query.toString()}`);
  expect(response.ok(), `GET /v1/statement-lines → ${String(response.status())}`).toBeTruthy();
  const page = (await response.json()) as StatementLinePage;
  return page.items;
}

interface LineClearing {
  readonly clearedAmount: string;
  readonly differenceAmount: string;
}

/**
 * Clears a statement line by coding it straight to an account (`method: 'post_entry'`
 * — `clearing.ts`'s own three shapes). This is the payout's own journal: D-82 posts
 * it here, when the real bank deposit is cleared against the clearing account, and
 * deliberately not by `recordProcessorPayout` itself (`posting.service.ts`'s header).
 */
export async function clearLineToAccount(
  request: APIRequestContext,
  lineId: string,
  accountId: string,
): Promise<LineClearing> {
  const response = await request.post(`/v1/statement-lines/${lineId}/clearing`, {
    headers: writeHeaders(),
    data: { method: 'post_entry', accountId },
  });
  expect(
    response.ok(),
    `POST /v1/statement-lines/{id}/clearing → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as LineClearing;
}
