import type {
  BankFeedAccountRef,
  BankFeedProvider,
  BankFeedTransaction,
} from '@openbooks/plugin-api';

import type { BankFeedAdapterDeps } from './types';

/**
 * The `fake` bank feed (OB-227, D-102): real and deterministic, not a stub
 * bolted on for tests — `payment/fake.ts`'s reasoning applied to this
 * initiative. Stripe Financial Connections is a network product, so proving the
 * ingest's fingerprint dedup (D-127), the per-connection cursor advance (D-128)
 * and the re-sync-is-a-no-op idempotency against it would mean either mocking an
 * HTTP client (spec §11 forbids it) or a live sandbox call on every test run.
 * `fake` is what the gate exercises instead: a third, real implementation of
 * `BankFeedProvider` alongside the deferred `stripe_financial_connections` one,
 * exactly as `createFakePaymentProcessor` is for PAY.
 *
 * Every value it returns is a pure function of `(externalAccountId, cursor)` —
 * no `Math.random`, no `Date.now`, only fixed literals — so a test can drive
 * genuine behaviour: the first pull (`cursor: null`) yields a fixed batch, and a
 * re-sync with the returned cursor yields nothing, which is what makes an
 * idempotency assertion meaningful rather than staged.
 *
 * `stripe_financial_connections` itself is proven manually, in a sandbox, per
 * D-102 — it is network and cannot run in the gate.
 */
export function createFakeBankFeed(deps: BankFeedAdapterDeps): BankFeedProvider {
  const { externalAccountId } = deps;

  return {
    name: 'fake',

    listLinkedAccounts(): Promise<readonly BankFeedAccountRef[]> {
      // v1 feeds asset accounts only (D-130), so the deterministic set is all
      // `category: 'cash'` — the same classification Stripe FC reports for a
      // bank account, which is what the credit-card follow-on (OB-227b) keys on.
      return Promise.resolve([
        {
          externalAccountId,
          institution: 'Fake Bank',
          displayName: `Fake Checking (${externalAccountId})`,
          category: 'cash',
        },
      ]);
    },

    fetchTransactions({ cursor }): Promise<{
      readonly transactions: readonly BankFeedTransaction[];
      readonly cursor: string;
      readonly hasMore: boolean;
    }> {
      // A re-sync (any non-null cursor) is a genuine no-op: nothing new since the
      // first pull, the cursor held steady, `hasMore: false`. This is the shape
      // that lets a suite assert D-127's idempotency — a second sync writes zero
      // rows — without contriving it in the test itself.
      if (cursor !== null) {
        return Promise.resolve({ transactions: [], cursor, hasMore: false });
      }

      // The first pull: a fixed batch keyed on the linked account, so two
      // connections never collide on `externalId` (it carries into
      // `bank_statement_lines.bank_reference` for the fingerprint, D-127).
      // Mixed signs in the asset frame (D-13) — positive is money *into* the
      // account, negative is money out — as signed cents strings, never floats.
      const transactions: readonly BankFeedTransaction[] = [
        {
          externalId: `${externalAccountId}-txn-1`,
          postedDate: '2026-01-05',
          valueDate: '2026-01-05',
          amountMinor: '150000',
          description: 'Customer deposit',
          counterparty: 'ACME Corp',
        },
        {
          externalId: `${externalAccountId}-txn-2`,
          postedDate: '2026-01-06',
          valueDate: '2026-01-07',
          amountMinor: '-4200',
          description: 'Card processing fee',
          counterparty: null,
        },
        {
          externalId: `${externalAccountId}-txn-3`,
          postedDate: '2026-01-08',
          valueDate: null,
          amountMinor: '-90000',
          description: 'Rent payment',
          counterparty: 'Landlord LLC',
        },
      ];

      return Promise.resolve({ transactions, cursor: 'cursor-1', hasMore: false });
    },
  };
}
