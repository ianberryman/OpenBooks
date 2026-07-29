import type { PaymentProcessorProvider } from '@openbooks/plugin-api';

import type { PaymentAdapterDeps } from './types';

/**
 * The Square `PaymentProcessorProvider`, deferred (initiative J). Not
 * implemented, for `./stripe.ts`'s exact reason: the real adapter is network
 * and is proven manually in a sandbox (D-102, OB-146), the second
 * implementation that proves the `PaymentProcessorProvider` abstraction the
 * way M5's real consumers proved the platform contracts (D-86).
 */
export function createSquarePaymentProcessor(_deps: PaymentAdapterDeps): PaymentProcessorProvider {
  throw new Error(
    'The square payment-processor adapter is not implemented yet (OB-146). Built and ' +
      'network-exercised only in a manual sandbox run (D-102); the gate proves the webhook ' +
      'receiver and the clearing-account posting model against the fake processor instead.',
  );
}
