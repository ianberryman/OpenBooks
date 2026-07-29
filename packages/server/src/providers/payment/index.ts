import type { PaymentProcessorProvider, ProcessorKind } from '@openbooks/plugin-api';

import { createFakePaymentProcessor } from './fake';
import { createSquarePaymentProcessor } from './square';
import { createStripePaymentProcessor } from './stripe';
import type { PaymentAdapterDeps } from './types';

export type { PaymentAdapterDeps } from './types';

/**
 * Builds the `PaymentProcessorProvider` for one processor connection (D-07,
 * D-86). Exhaustive over `ProcessorKind`, mirroring `createStorageProvider`/
 * `createSecretsProvider`: a new processor id does not compile until it has
 * an adapter here.
 *
 * Deliberately a function of `(processor, deps)` and not a lazy process-wide
 * accessor like `storageProvider()` — see the comment beside `Providers` in
 * plugin-api's `providers.ts` for why: a connection carries its own key and
 * an org can hold more than one, so the caller (the service that resolved a
 * `processor_connections` row) constructs one per call rather than reusing a
 * single resolved instance.
 */
function defaultPaymentProcessorFor(
  processor: ProcessorKind,
  deps: PaymentAdapterDeps,
): PaymentProcessorProvider {
  switch (processor) {
    case 'fake':
      return createFakePaymentProcessor(deps);
    case 'stripe':
      return createStripePaymentProcessor(deps);
    case 'square':
      return createSquarePaymentProcessor(deps);
  }
}

type PaymentProcessorFactory = typeof defaultPaymentProcessorFor;

let factory: PaymentProcessorFactory = defaultPaymentProcessorFor;

export function paymentProcessorFor(
  processor: ProcessorKind,
  deps: PaymentAdapterDeps,
): PaymentProcessorProvider {
  return factory(processor, deps);
}

/**
 * Installs a substitute factory for the rest of the process, or restores the
 * default. The same seam `setStorageProvider`/`setDocumentExtractionProvider`
 * are, applied to a function instead of a single resolved instance — that
 * shape, and not a lazy accessor, is what a per-connection provider needs
 * (see `paymentProcessorFor`'s own comment).
 *
 * Its point is letting a suite exercise the webhook receiver and the
 * clearing-account posting model against a connection whose `processor` is
 * `'stripe'` or `'square'` without touching a network: install a factory that
 * routes every processor to `createFakePaymentProcessor`, run the scenario,
 * and restore the default (or pass `undefined`) once it is done — spec §11's
 * "no mocks" kept intact, because what runs underneath is still the real,
 * deterministic `fake` implementation, never a stand-in for Stripe's own API.
 */
export function setPaymentProcessorFactory(value: PaymentProcessorFactory | undefined): void {
  factory = value ?? defaultPaymentProcessorFor;
}

export { createFakePaymentProcessor } from './fake';
export { createSquarePaymentProcessor } from './square';
export { createStripePaymentProcessor } from './stripe';
