import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  NormalizedProcessorEvent,
  PaymentProcessorProvider,
  PayoutBreakdown,
} from '@openbooks/plugin-api';

import type { PaymentAdapterDeps } from './types';

/**
 * The `fake` processor (D-102): real and deterministic, not a stub bolted on
 * for tests — `providers/extraction/deterministic.ts`'s reasoning applied to
 * this initiative. Stripe and Square are both network, so proving the
 * webhook receiver's signature verification and the two-level idempotency
 * (F9, D-85) against either would mean either mocking an HTTP client (spec
 * §11 forbids it) or a live sandbox call on every test run. `fake` is what
 * the gate exercises instead: its own hosted-checkout link, its own signing
 * scheme, its own on-the-wire body — a third, real implementation of
 * `PaymentProcessorProvider` alongside the two deferred ones, exactly as the
 * `deterministic` extraction adapter is a third real implementation
 * alongside a hosted deferral.
 *
 * Stripe and Square themselves are proven manually, in a sandbox, per D-102 —
 * OB-145/OB-146 are network and cannot run in the gate.
 */
export function createFakePaymentProcessor(deps: PaymentAdapterDeps): PaymentProcessorProvider {
  return {
    createCheckoutLink(input) {
      return Promise.resolve({
        url: `${input.returnUrl}?session=fake_${input.invoiceId}`,
        sessionId: `fake_sess_${input.invoiceId}`,
      });
    },

    verifyAndParseWebhook(input) {
      const expected = createHmac('sha256', deps.webhookSecret).update(input.rawBody).digest('hex');
      const expectedBuffer = Buffer.from(expected, 'utf8');
      const suppliedBuffer = Buffer.from(input.signatureHeader, 'utf8');

      // Length-checked before `timingSafeEqual`, which throws rather than
      // returning false on a length mismatch — `verifyPkce`'s reason
      // (`modules/oauth/credentials.ts`): both sides are fixed-width hex of a
      // 32-byte digest in the reachable case, so this is a defensive guard,
      // not a branch a genuine webhook takes.
      if (
        expectedBuffer.length !== suppliedBuffer.length ||
        !timingSafeEqual(expectedBuffer, suppliedBuffer)
      ) {
        throw new Error('fake processor webhook: signature does not match');
      }

      const parsed: unknown = JSON.parse(Buffer.from(input.rawBody).toString('utf8'));
      return Promise.resolve(assertNormalizedEvent(parsed));
    },

    fetchBalanceMinor() {
      // Leaf work (OB-148/OB-152) extends this to a balance that actually
      // moves against the fake's own event stream; `'0'` is enough for the
      // reconciliation seam to have something to compare against today.
      return Promise.resolve('0');
    },

    listEventsSince(cursor) {
      return Promise.resolve({ events: [], cursor: cursor ?? '0' });
    },

    fetchPayoutBreakdown(payoutId) {
      // OB-237b/D-102: the `fake` is the gate's real implementation, so it models
      // all three routes deterministically off the payout id — no network, no
      // magic beyond a substring the tests choose:
      //  • `manual` → the async Reporting-API path (D-237-8/D-237-10): no
      //    synchronous breakdown, `awaiting_report` carrying a report-run id the
      //    finalize sweep then polls with `fetchPayoutReport`.
      //  • `boom` → a breakdown fetch that fails (D-237-11): the visible-skip
      //    path, proving a throw becomes a `skipped` row, not a swallowed failure.
      //  • anything else → the synchronous automatic path (original OB-237).
      if (payoutId.includes('boom')) {
        return Promise.reject(new Error(`fake payout breakdown failed for ${payoutId}`));
      }
      if (payoutId.includes('manual')) {
        return Promise.resolve({
          kind: 'awaiting_report',
          reportRunId: `fake_report_${payoutId}`,
          netMinor: '9200',
          currency: 'usd',
          occurredAt: '2024-01-01T00:00:00.000Z',
        });
      }
      return Promise.resolve({ kind: 'ready', breakdown: fixedPayoutBreakdown(payoutId) });
    },

    fetchPayoutReport(reportRunId) {
      // Immediately succeeded (D-102): the gate has no real report-generation lag
      // to wait on, so the finalize sweep resolves on its first pass — except a
      // `pending`-tagged run, which lets a test assert an unfinalized report never
      // posts. The breakdown matches the automatic path's, so both routes reach an
      // identical balanced journal.
      if (reportRunId.includes('pending')) {
        return Promise.resolve({ kind: 'pending' });
      }
      const payoutId = reportRunId.replace('fake_report_', '');
      return Promise.resolve({ kind: 'ready', breakdown: fixedPayoutBreakdown(payoutId) });
    },
  };
}

/**
 * The fake's fixed, balanced breakdown (OB-237, D-237-4). Grosses up to a journal
 * that balances: charge 10000 credited to revenue; fee 300 and refund 500 debited;
 * clearing debited the net 9200 (= 10000 − 300 − 500), so Dr(9200+300+500) ===
 * Cr(10000). Shared by the synchronous and report-finalize paths so both land the
 * same numbers.
 */
function fixedPayoutBreakdown(payoutId: string): PayoutBreakdown {
  return {
    payoutId,
    netMinor: '9200',
    currency: 'usd',
    occurredAt: '2024-01-01T00:00:00.000Z',
    categories: [
      { reportingCategory: 'charge', amountMinor: '10000', count: 2 },
      { reportingCategory: 'fee', amountMinor: '300', count: 2 },
      { reportingCategory: 'refund', amountMinor: '500', count: 1 },
    ],
  };
}

/**
 * The fake's on-the-wire webhook body *is* a `NormalizedProcessorEvent` — see
 * this file's header — so there is no processor-specific shape to translate,
 * only a check that what arrived actually has the fields the interface
 * promises. Throws rather than returning `null`/`undefined`, for
 * `InboundMailProvider.parse`'s reason (plugin-api `providers.ts`): the
 * caller has no session to fall back to.
 */
function assertNormalizedEvent(value: unknown): NormalizedProcessorEvent {
  if (typeof value !== 'object' || value === null) {
    throw new Error('fake processor webhook: body is not a NormalizedProcessorEvent object');
  }

  const candidate = value as Partial<Record<keyof NormalizedProcessorEvent, unknown>>;
  const requiredStrings: readonly (keyof NormalizedProcessorEvent)[] = [
    'kind',
    'externalEventId',
    'externalObjectId',
    'grossMinor',
    'occurredAt',
  ];
  for (const field of requiredStrings) {
    if (typeof candidate[field] !== 'string') {
      throw new Error(`fake processor webhook: missing or non-string "${field}"`);
    }
  }

  const nullableStrings: readonly (keyof NormalizedProcessorEvent)[] = [
    'invoiceId',
    'feeMinor',
    'netMinor',
  ];
  for (const field of nullableStrings) {
    const fieldValue = candidate[field];
    if (typeof fieldValue !== 'string' && fieldValue !== null) {
      throw new Error(`fake processor webhook: "${field}" must be a string or null`);
    }
  }

  return candidate as unknown as NormalizedProcessorEvent;
}
