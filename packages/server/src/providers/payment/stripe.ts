import type { PaymentProcessorProvider } from '@openbooks/plugin-api';

import type { PaymentAdapterDeps } from './types';

/**
 * The Stripe `PaymentProcessorProvider`, deferred (initiative J). Not
 * implemented: the real adapter calls the Stripe API — hosted checkout
 * sessions and webhook signature verification against a live account — which
 * is network and not something the gate can exercise, so this throws at
 * construction exactly as the `sqs` queue adapter does
 * (`providers/index.ts`'s `selectQueueProvider`) and the `anthropic`
 * extraction adapter does (`providers/extraction/anthropic.ts`). It is built
 * and network-exercised only in a manual sandbox run (D-102, OB-145); the
 * gate proves the webhook receiver and the clearing-account posting model
 * against `fake` instead (`./fake.ts`).
 */
export function createStripePaymentProcessor(_deps: PaymentAdapterDeps): PaymentProcessorProvider {
  throw new Error(
    'The stripe payment-processor adapter is not implemented yet (OB-145). Built and ' +
      'network-exercised only in a manual sandbox run (D-102); the gate proves the webhook ' +
      'receiver and the clearing-account posting model against the fake processor instead.',
  );
}
