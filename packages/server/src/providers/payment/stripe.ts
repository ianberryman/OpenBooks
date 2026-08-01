import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  NormalizedProcessorEvent,
  PaymentProcessorProvider,
  PayoutBreakdown,
  PayoutCategoryAmount,
  PayoutReportingCategory,
  ProcessorCheckoutLink,
} from '@openbooks/plugin-api';

import type { PaymentAdapterDeps } from './types';

/**
 * The real Stripe `PaymentProcessorProvider` (initiative J, OB-145). Built against
 * Stripe's documented REST API using global `fetch` and `node:crypto` only — no
 * `stripe` npm SDK, per the "narrowest surface" discipline the rest of `providers/`
 * already keeps (no AWS SDK call in `secrets/local.ts`, no Anthropic SDK in
 * `extraction/deterministic.ts`'s sibling). Form-encoded bodies, not JSON: Stripe's
 * API has always taken `application/x-www-form-urlencoded`, including nested
 * bracket-notation keys (`line_items[0][price_data][unit_amount]`) for arrays and
 * objects — there is no JSON request body to construct.
 *
 * D-102: this file is **not** exercised by the gate. `yarn test` runs hermetically
 * against real MySQL and no external network (spec §11), so the gate's coverage of
 * `PaymentProcessorProvider` is `./fake.ts` — a third, real, deterministic
 * implementation, not a stub. This adapter is proven correct by matching Stripe's
 * published API shapes and is network-exercised only in a manual sandbox run
 * (OB-152/OB-153 assert the *contract*, against `fake`; nothing here is unit-tested
 * in-repo). Treat every field name and endpoint below as "believed correct from the
 * docs, confirm against the sandbox," not "proven."
 */
export function createStripePaymentProcessor(deps: PaymentAdapterDeps): PaymentProcessorProvider {
  return {
    async createCheckoutLink(input): Promise<ProcessorCheckoutLink> {
      const params = new URLSearchParams();
      params.set('mode', 'payment');
      params.set('success_url', input.returnUrl);
      params.set('cancel_url', input.returnUrl);
      params.set('line_items[0][quantity]', '1');
      params.set('line_items[0][price_data][currency]', input.currency.toLowerCase());
      params.set('line_items[0][price_data][unit_amount]', input.amountMinor);
      params.set('line_items[0][price_data][product_data][name]', `Invoice ${input.invoiceId}`);
      params.set('metadata[invoiceId]', input.invoiceId);
      for (const [key, value] of Object.entries(input.metadata)) {
        params.set(`metadata[${key}]`, value);
      }

      const session = await stripeRequest<StripeCheckoutSession>(
        deps,
        'POST',
        '/checkout/sessions',
        params,
        // Retrying the same invoice's checkout-link request (a client timeout, a
        // caller-side retry) should not mint a second Stripe session — Stripe
        // dedupes a POST on this header for 24h, the same guarantee
        // `withIdempotency` gives the ledger side of this codebase.
        `checkout-session:${input.invoiceId}`,
      );

      if (session.url === null) {
        throw new Error(`stripe checkout session ${session.id} was created with no url`);
      }
      return { url: session.url, sessionId: session.id };
    },

    verifyAndParseWebhook(input): Promise<NormalizedProcessorEvent> {
      const rawBodyText = Buffer.from(input.rawBody).toString('utf8');
      const { timestamp, signatures } = parseStripeSignatureHeader(input.signatureHeader);

      const expected = createHmac('sha256', deps.webhookSecret)
        .update(`${timestamp}.${rawBodyText}`, 'utf8')
        .digest('hex');
      const expectedBuffer = Buffer.from(expected, 'utf8');

      // Stripe sends every signature the account's secret(s) produce (plural
      // during a rotation window) as repeated `v1=` pairs; a genuine webhook
      // matches at least one. Each candidate is still length-checked before
      // `timingSafeEqual`, which throws rather than returning false on a length
      // mismatch (`fake.ts`'s reason, restated here).
      const verified = signatures.some((signature) => {
        const suppliedBuffer = Buffer.from(signature, 'utf8');
        return (
          suppliedBuffer.length === expectedBuffer.length &&
          timingSafeEqual(expectedBuffer, suppliedBuffer)
        );
      });
      if (!verified) {
        throw new Error('stripe webhook: signature does not match');
      }

      const event = parseStripeEvent(JSON.parse(rawBodyText));
      const normalized = normalizeStripeEvent(event);
      if (normalized === null) {
        throw new Error(`stripe webhook: unsupported event type "${event.type}"`);
      }
      return Promise.resolve(normalized);
    },

    async fetchBalanceMinor(): Promise<string> {
      const balance = await stripeRequest<StripeBalance>(deps, 'GET', '/balance');
      const totalMinor = balance.available.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
      return totalMinor.toString();
    },

    async listEventsSince(cursor) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor !== null) query.set('starting_after', cursor);

      const page = await stripeRequest<StripeEventList>(deps, 'GET', `/events?${query.toString()}`);

      const events: NormalizedProcessorEvent[] = [];
      for (const event of page.data) {
        const normalized = normalizeStripeEvent(event);
        if (normalized !== null) events.push(normalized);
      }

      // The cursor advances to the last **raw** event id, not the last normalized
      // one — an unsupported event type (`customer.updated`, say) still has to be
      // paged past, or the next poll would re-fetch it forever.
      const lastEvent = page.data.length > 0 ? page.data[page.data.length - 1] : undefined;
      return { events, cursor: lastEvent?.id ?? cursor ?? '0' };
    },

    async fetchPayoutBreakdown(payoutId): Promise<PayoutBreakdown> {
      // One payout's underlying balance transactions, aggregated by
      // `reporting_category` (OB-237, D-237-4). The payout object itself carries
      // only the net `amount`; the detail is the balance-transactions list, paged
      // via `starting_after` exactly like the event feed. Per this file's header
      // (D-102), this is believed-correct-from-the-docs and confirmed only in a
      // sandbox — the gate exercises `fake.ts`, not this.
      const payout = await stripeRequest<StripePayout>(
        deps,
        'GET',
        `/payouts/${encodeURIComponent(payoutId)}`,
      );

      const totals = new Map<PayoutReportingCategory, { amount: bigint; count: number }>();
      // Stripe reports the per-charge fee in each transaction's own `fee` field
      // rather than as a separate line, so fees are summed here and added as the
      // `fee` category below, not read off a `fee`-category row.
      let feeTotal = 0n;
      let startingAfter: string | null = null;

      for (;;) {
        const query = new URLSearchParams({ payout: payoutId, limit: '100' });
        if (startingAfter !== null) query.set('starting_after', startingAfter);
        const page = await stripeRequest<StripeBalanceTransactionList>(
          deps,
          'GET',
          `/balance_transactions?${query.toString()}`,
        );

        for (const txn of page.data) {
          feeTotal += BigInt(txn.fee);
          const category = bucketReportingCategory(txn.reporting_category);
          // The payout line itself carries no category the builder places.
          if (category === null) continue;
          const bucket = totals.get(category) ?? { amount: 0n, count: 0 };
          bucket.amount += absBigInt(BigInt(txn.amount));
          bucket.count += 1;
          totals.set(category, bucket);
        }

        const last = page.data.length > 0 ? page.data[page.data.length - 1] : undefined;
        if (!page.has_more || last === undefined) break;
        startingAfter = last.id;
      }

      if (feeTotal > 0n) {
        const existing = totals.get('fee') ?? { amount: 0n, count: 0 };
        totals.set('fee', { amount: existing.amount + feeTotal, count: existing.count });
      }

      const categories: PayoutCategoryAmount[] = [...totals].map(
        ([reportingCategory, { amount, count }]) => ({
          reportingCategory,
          amountMinor: amount.toString(),
          count,
        }),
      );

      return {
        payoutId,
        netMinor: String(payout.amount),
        currency: payout.currency,
        occurredAt: new Date(payout.created * 1000).toISOString(),
        categories,
      };
    },
  };
}

/** `|n|` on a bigint — Stripe reports refunds and other money-out lines as negative amounts. */
function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Buckets Stripe's many raw `reporting_category` values into the six the
 * summary-journal builder knows how to place (OB-237, D-237-6). `null` for the
 * `payout` line itself, which is the transfer, not a category to post. Kept
 * deliberately loose (prefix/substring) because Stripe's category vocabulary is
 * broad and versioned — an unrecognised money-moving line falls to `adjustment`
 * rather than being silently dropped.
 */
function bucketReportingCategory(raw: string): PayoutReportingCategory | null {
  if (raw === 'payout') return null;
  if (raw.startsWith('charge') || raw === 'partial_capture_reversal') return 'charge';
  if (raw.includes('refund')) return 'refund';
  if (raw.includes('dispute')) return 'dispute';
  if (raw === 'tax') return 'tax';
  if (raw.includes('fee') || raw === 'network_cost') return 'fee';
  return 'adjustment';
}

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** One Stripe checkout session, the fields `createCheckoutLink` reads off the response. */
interface StripeCheckoutSession {
  readonly id: string;
  readonly url: string | null;
}

interface StripeBalanceEntry {
  readonly amount: number;
  readonly currency: string;
}

interface StripeBalance {
  readonly available: readonly StripeBalanceEntry[];
}

interface StripeBalanceTransaction {
  readonly id: string;
  readonly fee: number;
}

/** A `balance_transaction` row as `fetchPayoutBreakdown` reads it (OB-237). */
interface StripeBalanceTransactionRow {
  readonly id: string;
  readonly amount: number;
  readonly fee: number;
  readonly reporting_category: string;
}

interface StripeBalanceTransactionList {
  readonly data: readonly StripeBalanceTransactionRow[];
  readonly has_more: boolean;
}

/** The bare payout object — only its net `amount` and `created` are read (OB-237). */
interface StripePayout {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
  readonly created: number;
}

/**
 * The one event-object shape every Stripe webhook/poll normalisation reads off —
 * a union of the fields `charge`, `checkout.session`, `refund`, `dispute` and
 * `payout` objects actually carry, narrowed to only what `normalizeStripeEvent`
 * uses (D-07's "narrowest surface" rule applied to a third-party response, not
 * just to our own provider contract).
 */
interface StripeEventObject {
  readonly id: string;
  readonly amount?: number;
  readonly amount_total?: number;
  readonly amount_refunded?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly balance_transaction?: string | StripeBalanceTransaction | null;
}

interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: StripeEventObject };
}

interface StripeEventList {
  readonly data: readonly StripeEvent[];
}

interface StripeErrorPayload {
  readonly error: { readonly message: string };
}

function isStripeErrorPayload(value: unknown): value is StripeErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: unknown }).error !== null
  );
}

/**
 * The one HTTP call every Stripe operation goes through: bearer auth, and a
 * form-encoded body for a POST (GET carries its query string in `path` already).
 * Idempotency key is optional — only `createCheckoutLink`'s POST supplies one
 * today; Stripe ignores the header entirely on a GET.
 */
async function stripeRequest<T>(
  deps: PaymentAdapterDeps,
  method: 'GET' | 'POST',
  path: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.secretKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: body.toString() }),
  });

  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isStripeErrorPayload(payload)
      ? payload.error.message
      : `HTTP ${response.status}`;
    throw new Error(`stripe API error on ${method} ${path}: ${message}`);
  }
  return payload as T;
}

/**
 * A minimal runtime check that the parsed JSON body actually has the shape
 * `StripeEvent` promises, for `assertNormalizedEvent`'s reason in `fake.ts`: an
 * unverified structural assumption is exactly the kind of mistake a webhook
 * receiver with no session to fall back on should throw on, not silently coerce.
 */
function parseStripeEvent(raw: unknown): StripeEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('stripe webhook: body is not a JSON object');
  }
  const candidate = raw as Partial<StripeEvent>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.type !== 'string' ||
    typeof candidate.created !== 'number'
  ) {
    throw new Error('stripe webhook: missing "id", "type" or "created" on the event');
  }

  const object: unknown = candidate.data?.object;
  if (
    typeof object !== 'object' ||
    object === null ||
    typeof (object as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('stripe webhook: missing "data.object.id" on the event');
  }

  return candidate as StripeEvent;
}

/** Stripe's `t=<ts>,v1=<sig>[,v1=<sig>...]` header, parsed into the parts the HMAC needs. */
function parseStripeSignatureHeader(header: string): {
  readonly timestamp: string;
  readonly signatures: readonly string[];
} {
  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }

  if (timestamp === null || signatures.length === 0) {
    throw new Error('stripe webhook: signatureHeader is missing "t" or "v1"');
  }
  return { timestamp, signatures };
}

type NormalizedKind = 'charge' | 'refund' | 'dispute' | 'payout';

/**
 * Which `NormalizedProcessorEvent.kind` a Stripe event type maps to, or `null`
 * for a type this integration does not act on (`customer.updated` and the like)
 * — `listEventsSince` skips those; `verifyAndParseWebhook` throws, because a
 * webhook endpoint only Stripe is configured to call with the types PAY
 * subscribes to should never see one.
 */
function classifyStripeEventType(type: string): NormalizedKind | null {
  if (type === 'charge.succeeded' || type === 'checkout.session.completed') return 'charge';
  if (type === 'charge.refunded' || type.startsWith('refund.')) return 'refund';
  if (type.startsWith('charge.dispute.')) return 'dispute';
  if (type.startsWith('payout.')) return 'payout';
  return null;
}

/** `amount`, already integer minor units on Stripe's own wire (D-13) — `String(n)`, never a divide. */
function toMinorString(amount: number | undefined): string {
  return String(amount ?? 0);
}

/**
 * The per-charge fee (D-84, J4) only exists when `balance_transaction` arrived
 * *expanded* to an object rather than left as its bare id string — the caller
 * would need `expand[]=data.object.balance_transaction` on the event, which this
 * adapter does not request today (kept simple for the first cut); `null` here is
 * the honest "we don't know the fee from this delivery alone" case D-84's own
 * text anticipates ("the adapter normalising processors that only report fees at
 * payout"). OB-148's webhook receiver can add the expand param later without
 * changing this function's shape.
 */
function extractBalanceTransactionFee(
  balanceTransaction: string | StripeBalanceTransaction | null | undefined,
): string | null {
  if (
    balanceTransaction === null ||
    balanceTransaction === undefined ||
    typeof balanceTransaction === 'string'
  ) {
    return null;
  }
  return String(balanceTransaction.fee);
}

function normalizeStripeEvent(event: StripeEvent): NormalizedProcessorEvent | null {
  const kind = classifyStripeEventType(event.type);
  if (kind === null) return null;

  const object = event.data.object;
  const invoiceId = object.metadata?.['invoiceId'] ?? null;
  const occurredAt = new Date(event.created * 1000).toISOString();

  switch (kind) {
    case 'charge':
      return {
        kind,
        externalEventId: event.id,
        externalObjectId: object.id,
        invoiceId,
        grossMinor: toMinorString(object.amount ?? object.amount_total),
        feeMinor: extractBalanceTransactionFee(object.balance_transaction),
        netMinor: null,
        occurredAt,
      };

    case 'refund':
      return {
        kind,
        externalEventId: event.id,
        externalObjectId: object.id,
        invoiceId,
        grossMinor: toMinorString(object.amount_refunded ?? object.amount),
        feeMinor: null,
        netMinor: null,
        occurredAt,
      };

    case 'dispute':
      return {
        kind,
        externalEventId: event.id,
        externalObjectId: object.id,
        // A dispute names no invoice (plugin-api `providers.ts`'s own contract).
        invoiceId: null,
        grossMinor: toMinorString(object.amount),
        feeMinor: null,
        netMinor: null,
        occurredAt,
      };

    case 'payout': {
      // A payout's `amount` is already Stripe's net transfer — there is no
      // separate "gross" figure for a payout the way a charge has one, so
      // `grossMinor` carries the same value `netMinor` does.
      const netMinor = toMinorString(object.amount);
      return {
        kind,
        externalEventId: event.id,
        externalObjectId: object.id,
        invoiceId: null,
        grossMinor: netMinor,
        feeMinor: null,
        netMinor,
        occurredAt,
      };
    }
  }
}
