import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { NormalizedProcessorEvent, PaymentProcessorProvider } from '@openbooks/plugin-api';

import type { PaymentAdapterDeps } from './types';

/**
 * The real Square `PaymentProcessorProvider` (initiative J, OB-146), for `./stripe.ts`'s
 * exact reasons: built against Square's documented Connect v2 REST API using global
 * `fetch` and `node:crypto` only (no `square` npm SDK), not exercised by the gate
 * (D-102 — `./fake.ts` is what `yarn check` runs), proven only in a manual sandbox.
 *
 * Two seams here are genuinely weaker than Stripe's and are flagged rather than
 * quietly assumed correct — see the comments on `computeSquareSignature` and
 * `listEventsSince` below. Everything else follows Square's published API shapes as
 * closely as `./stripe.ts` follows Stripe's.
 */
export function createSquarePaymentProcessor(deps: PaymentAdapterDeps): PaymentProcessorProvider {
  return {
    async createCheckoutLink(input) {
      const body: SquareCreatePaymentLinkRequest = {
        // A fresh key per call, not a stable one derived from `invoiceId`: unlike
        // Stripe's `Idempotency-Key`, Square's key is meant to make one specific
        // create call safe to retry verbatim, and this seam has no place to stash
        // "the key I used last time for this invoice" to retry with. Net effect:
        // calling `createCheckoutLink` twice for the same invoice mints two Square
        // payment links rather than returning the first one back — flagged as an
        // assumption, not a guarantee this adapter makes.
        idempotency_key: randomUUID(),
        order: {
          // `externalAccountId` is assumed to carry the Square **location id** the
          // order posts under — the field is deliberately generic in
          // `PaymentAdapterDeps` (Stripe has no equivalent use for it in this
          // adapter), so confirm this mapping against however OB-151's
          // connect-processor screen actually populates the connection row.
          location_id: deps.externalAccountId ?? '',
          line_items: [
            {
              name: `Invoice ${input.invoiceId}`,
              quantity: '1',
              base_price_money: {
                amount: toSquareAmount(input.amountMinor),
                currency: input.currency.toUpperCase(),
              },
            },
          ],
          // Square's Payment Links `quick_pay` shape has no metadata field at all;
          // `order` does (an Order's `metadata` is a real, documented map), which is
          // why this adapter builds a full order instead of the simpler quick-pay
          // request — the checkout metadata is where `invoiceId`'s certain identity
          // (D-83) has to live for the webhook side to read it back.
          metadata: { invoiceId: input.invoiceId, ...input.metadata },
        },
        checkout_options: {
          redirect_url: input.returnUrl,
        },
      };

      const result = await squareRequest<SquareCreatePaymentLinkResponse>(
        deps,
        'POST',
        '/online-checkout/payment-links',
        body,
      );
      return { url: result.payment_link.url, sessionId: result.payment_link.id };
    },

    async verifyAndParseWebhook(input): Promise<NormalizedProcessorEvent> {
      const rawBodyText = Buffer.from(input.rawBody).toString('utf8');
      const expected = computeSquareSignature(deps, rawBodyText);

      const expectedBuffer = Buffer.from(expected, 'utf8');
      const suppliedBuffer = Buffer.from(input.signatureHeader, 'utf8');
      if (
        expectedBuffer.length !== suppliedBuffer.length ||
        !timingSafeEqual(expectedBuffer, suppliedBuffer)
      ) {
        throw new Error('square webhook: signature does not match');
      }

      const envelope = parseSquareWebhookEnvelope(JSON.parse(rawBodyText));
      const normalized = await normalizeSquareEvent(deps, envelope);
      if (normalized === null) {
        throw new Error(`square webhook: unsupported event type "${envelope.type}"`);
      }
      return normalized;
    },

    async fetchBalanceMinor(): Promise<string> {
      // Square's Connect v2 API has no direct "available balance" endpoint the way
      // Stripe's `GET /v1/balance` is one — Square settles automatically and does
      // not expose a running merchant balance publicly. This is a best-effort
      // proxy for the clearing account's expected balance: completed payments not
      // yet paid out, minus payouts already sent, over the most recent page of
      // each (no pagination — a gap on an account with >100 outstanding rows,
      // flagged rather than silently wrong on a partial page).
      const [paymentsPage, payoutsPage] = await Promise.all([
        squareRequest<SquareListPaymentsResponse>(deps, 'GET', '/payments?limit=100'),
        squareRequest<SquareListPayoutsResponse>(deps, 'GET', '/payouts?limit=100'),
      ]);

      const completed = (paymentsPage.payments ?? []).reduce(
        (sum, payment) => sum + BigInt(payment.amount_money?.amount ?? 0),
        0n,
      );
      const paidOut = (payoutsPage.payouts ?? []).reduce(
        (sum, payout) => sum + BigInt(payout.amount_money?.amount ?? 0),
        0n,
      );

      return (completed - paidOut).toString();
    },

    listEventsSince(cursor) {
      // Square is webhook-first and documents no events-listing/poll endpoint
      // equivalent to Stripe's `GET /v1/events` — there is nothing here for the
      // D-85 backstop to page through. Returns the cursor unchanged, as agreed:
      // Square's half of the polling backstop is `fetchBalanceMinor`'s
      // payments/payouts scan above, not a missed-webhook replay like Stripe's.
      return Promise.resolve({ events: [], cursor: cursor ?? '0' });
    },

    fetchPayoutBreakdown(payoutId): Promise<never> {
      // Summary-sales payout sync (OB-237) is Stripe-first and US-only for v1 —
      // the account-mapping and grossed-up summary journal are built and proven
      // against Stripe's `balance_transactions`/`reporting_category` shape
      // (D-237-4). Square's payout-entries endpoint differs enough to be its own
      // ticket; until then a Square connection cannot be put in `summary_sales`
      // mode (the connect service refuses it), so this is unreachable rather than
      // a silent wrong answer — thrown, not stubbed, for `verifyAndParseWebhook`'s
      // reason: the caller has no fallback.
      return Promise.reject(
        new Error(
          `square payout breakdown is not implemented (OB-237 is Stripe-first); payout ${payoutId}`,
        ),
      );
    },
  };
}

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

/**
 * Square's date-versioned API — every request pins one so a merchant account's
 * behaviour cannot shift under Square's rolling deprecations between adapter
 * changes. Picked a recent version at time of writing; bump and re-verify against
 * the sandbox account periodically (D-102 — nothing in the gate would catch drift).
 */
const SQUARE_API_VERSION = '2024-01-18';

interface SquareMoney {
  readonly amount: number;
  readonly currency: string;
}

interface SquareCreatePaymentLinkRequest {
  readonly idempotency_key: string;
  readonly order: {
    readonly location_id: string;
    readonly line_items: readonly {
      readonly name: string;
      readonly quantity: string;
      readonly base_price_money: SquareMoney;
    }[];
    readonly metadata: Readonly<Record<string, string>>;
  };
  readonly checkout_options: {
    readonly redirect_url: string;
  };
}

interface SquareCreatePaymentLinkResponse {
  readonly payment_link: {
    readonly id: string;
    readonly url: string;
  };
}

interface SquareOrder {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface SquarePayment {
  readonly id: string;
  readonly amount_money?: SquareMoney;
  readonly processing_fee?: readonly { readonly amount_money: SquareMoney }[];
  readonly order_id?: string;
}

interface SquareRefund {
  readonly id: string;
  readonly amount_money?: SquareMoney;
  readonly order_id?: string;
}

interface SquareDispute {
  readonly id: string;
  readonly amount_money?: SquareMoney;
}

interface SquarePayout {
  readonly id: string;
  readonly amount_money?: SquareMoney;
}

interface SquareListPaymentsResponse {
  readonly payments?: readonly SquarePayment[];
}

interface SquareListPayoutsResponse {
  readonly payouts?: readonly SquarePayout[];
}

/**
 * Square's webhook envelope: `type` names the event, `data.object` is a record
 * keyed by the object's own type name (`{ payment: {...} }`, `{ refund: {...} }`,
 * ...) rather than a flat object the way Stripe's `data.object` is — narrowed
 * further per-kind in `normalizeSquareEvent`.
 */
interface SquareWebhookEnvelope {
  readonly event_id: string;
  readonly type: string;
  readonly created_at: string;
  readonly data: {
    readonly object: Readonly<Record<string, unknown>>;
  };
}

interface SquareErrorPayload {
  readonly errors: readonly { readonly code: string; readonly detail?: string }[];
}

function isSquareErrorPayload(value: unknown): value is SquareErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

/** The one HTTP call every Square operation goes through: bearer auth, JSON body, pinned API version. */
async function squareRequest<T>(
  deps: PaymentAdapterDeps,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${SQUARE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.secretKey}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isSquareErrorPayload(payload)
      ? payload.errors.map((error) => error.detail ?? error.code).join('; ')
      : `HTTP ${response.status}`;
    throw new Error(`square API error on ${method} ${path}: ${message}`);
  }
  return payload as T;
}

/**
 * Cents string (D-13) to the JSON integer Square's API requires — the boundary
 * conversion `Number()` on a branded `Money` value would be (`no-float-money`
 * bans exactly that), but `amountMinor` here is a plain wire `string`, not the
 * ledger's branded type, so the rule does not apply; this is purely "make the
 * outbound HTTP body's number field," not ledger arithmetic.
 */
function toSquareAmount(amountMinor: string): number {
  return Number.parseInt(amountMinor, 10);
}

/**
 * Square's documented webhook scheme: `HMAC-SHA256(signatureKey, notificationUrl +
 * rawBody)`, base64-encoded, compared against `x-square-hmacsha256-signature`.
 *
 * **The gap**: the scheme signs the exact URL Square was configured to POST to,
 * and `PaymentAdapterDeps`/`verifyAndParseWebhook`'s signature carry no such URL —
 * only `rawBody` and the header. This falls back to `deps.appBaseUrl` (present for
 * a hosted hook, `undefined`/empty for a self-host deployment with none
 * configured), which is a best-effort guess at the notification URL, not the
 * verified value Square's own docs assume the verifier has. **Flag for OB-148**:
 * either thread the actual configured webhook URL through `PaymentAdapterDeps`
 * (a new field) or resolve it from route config at the call site, or this
 * signature check is weaker than Stripe's for any deployment where the
 * notification URL isn't exactly `appBaseUrl` plus nothing else.
 */
function computeSquareSignature(deps: PaymentAdapterDeps, rawBody: string): string {
  const notificationUrl = deps.appBaseUrl ?? '';
  return createHmac('sha256', deps.webhookSecret)
    .update(notificationUrl + rawBody, 'utf8')
    .digest('base64');
}

function parseSquareWebhookEnvelope(raw: unknown): SquareWebhookEnvelope {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('square webhook: body is not a JSON object');
  }
  const candidate = raw as Partial<SquareWebhookEnvelope>;
  if (typeof candidate.event_id !== 'string' || typeof candidate.type !== 'string') {
    throw new Error('square webhook: missing "event_id" or "type" on the event');
  }
  if (typeof candidate.data?.object !== 'object' || candidate.data.object === null) {
    throw new Error('square webhook: missing "data.object" on the event');
  }
  return candidate as SquareWebhookEnvelope;
}

/**
 * Square's Payment/Refund webhook objects carry no metadata of their own (unlike
 * Stripe's checkout session, which is itself the webhook's event object) —
 * `createCheckoutLink` above put `invoiceId` on the **order**, not the payment, so
 * recovering it costs one extra read against `GET /orders/{id}`. Failure here (the
 * order lookup errors, or the payment somehow carries no `order_id`) degrades to
 * `null` rather than failing the whole webhook: the signature already proved the
 * request is genuinely from Square, so a metadata-lookup miss is a
 * data-completeness gap, not a forged request — the same distinction
 * `ExtractedBill`'s nullable fields make for a parse that read less than everything.
 */
async function resolveInvoiceId(
  deps: PaymentAdapterDeps,
  orderId: string | undefined,
): Promise<string | null> {
  if (orderId === undefined) return null;
  try {
    const response = await squareRequest<{ readonly order: SquareOrder }>(
      deps,
      'GET',
      `/orders/${orderId}`,
    );
    return response.order.metadata?.['invoiceId'] ?? null;
  } catch {
    return null;
  }
}

function sumSquareFees(fees: readonly { readonly amount_money: SquareMoney }[]): number {
  return fees.reduce((sum, fee) => sum + fee.amount_money.amount, 0);
}

async function normalizeSquareEvent(
  deps: PaymentAdapterDeps,
  envelope: SquareWebhookEnvelope,
): Promise<NormalizedProcessorEvent | null> {
  const occurredAt = new Date(envelope.created_at).toISOString();

  if (envelope.type.startsWith('payment.')) {
    const payment = envelope.data.object['payment'] as SquarePayment | undefined;
    if (payment === undefined) return null;
    return {
      kind: 'charge',
      externalEventId: envelope.event_id,
      externalObjectId: payment.id,
      invoiceId: await resolveInvoiceId(deps, payment.order_id),
      grossMinor: String(payment.amount_money?.amount ?? 0),
      feeMinor:
        payment.processing_fee !== undefined && payment.processing_fee.length > 0
          ? String(sumSquareFees(payment.processing_fee))
          : null,
      netMinor: null,
      occurredAt,
    };
  }

  if (envelope.type.startsWith('refund.')) {
    const refund = envelope.data.object['refund'] as SquareRefund | undefined;
    if (refund === undefined) return null;
    return {
      kind: 'refund',
      externalEventId: envelope.event_id,
      externalObjectId: refund.id,
      invoiceId: await resolveInvoiceId(deps, refund.order_id),
      grossMinor: String(refund.amount_money?.amount ?? 0),
      feeMinor: null,
      netMinor: null,
      occurredAt,
    };
  }

  if (envelope.type.startsWith('dispute.')) {
    const dispute = envelope.data.object['dispute'] as SquareDispute | undefined;
    if (dispute === undefined) return null;
    return {
      kind: 'dispute',
      externalEventId: envelope.event_id,
      externalObjectId: dispute.id,
      invoiceId: null,
      grossMinor: String(dispute.amount_money?.amount ?? 0),
      feeMinor: null,
      netMinor: null,
      occurredAt,
    };
  }

  if (envelope.type.startsWith('payout.')) {
    const payout = envelope.data.object['payout'] as SquarePayout | undefined;
    if (payout === undefined) return null;
    const netMinor = String(payout.amount_money?.amount ?? 0);
    return {
      kind: 'payout',
      externalEventId: envelope.event_id,
      externalObjectId: payout.id,
      invoiceId: null,
      grossMinor: netMinor,
      feeMinor: null,
      netMinor,
      occurredAt,
    };
  }

  return null;
}
