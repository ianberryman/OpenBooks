import type { BankFeedProvider, BankFeedSource } from '@openbooks/plugin-api';

import { createFakeBankFeed } from './fake';
import { createStripeFinancialConnectionsBankFeed } from './stripe-financial-connections';
import type { BankFeedAdapterDeps } from './types';

export type { BankFeedAdapterDeps } from './types';

/**
 * Builds the `BankFeedProvider` for one `bank_feed_connections` connection
 * (OB-227, D-126). Exhaustive over `BankFeedSource`, mirroring
 * `paymentProcessorFor`: a new feed id does not compile until it has an adapter
 * here.
 *
 * Deliberately a function of `(source, deps)` and not a lazy process-wide
 * accessor — see the comment beside `BankFeedProvider` in plugin-api's
 * `providers.ts`: a connection carries its own restricted key and linked
 * account and an org can hold more than one, so the caller (the service that
 * resolved a `bank_feed_connections` row) constructs one per call rather than
 * reusing a single resolved instance.
 */
function defaultBankFeedProviderFor(
  source: BankFeedSource,
  deps: BankFeedAdapterDeps,
): BankFeedProvider {
  switch (source) {
    case 'fake':
      return createFakeBankFeed(deps);
    case 'stripe_financial_connections':
      return createStripeFinancialConnectionsBankFeed(deps);
  }
}

type BankFeedProviderFactory = typeof defaultBankFeedProviderFor;

let factory: BankFeedProviderFactory = defaultBankFeedProviderFor;

export function bankFeedProviderFor(
  source: BankFeedSource,
  deps: BankFeedAdapterDeps,
): BankFeedProvider {
  return factory(source, deps);
}

/**
 * Installs a substitute factory for the rest of the process, or restores the
 * default — the exact seam `setPaymentProcessorFactory` is, applied to a
 * function instead of a single resolved instance.
 *
 * Its point is letting a suite exercise the ingest, the fingerprint dedup
 * (D-127) and the per-connection cursor advance (D-128) against a connection
 * whose `source` is `'stripe_financial_connections'` without touching a
 * network: install a factory that routes every source to `createFakeBankFeed`,
 * run the scenario, and restore the default (or pass `undefined`) once it is
 * done — spec §11's "no mocks" kept intact, because what runs underneath is
 * still the real, deterministic `fake` implementation, never a stand-in for
 * Stripe's own API.
 */
export function setBankFeedProviderFactory(value: BankFeedProviderFactory | undefined): void {
  factory = value ?? defaultBankFeedProviderFor;
}

export { createFakeBankFeed } from './fake';
export { createStripeFinancialConnectionsBankFeed } from './stripe-financial-connections';
