import type { Form1099AdapterDeps, Form1099Provider } from '@openbooks/plugin-api';

/**
 * The IRS IRIS A2A e-file transmitter, deferred (OB-228's pinned contract, D-228-7).
 * Not implemented: the real adapter authenticates to IRIS (or a vendor such as
 * Tax1099) and transmits over global `fetch`, never an SDK — which is not something
 * the gate can exercise, so this throws at construction exactly as
 * `createAnthropicExtractionProvider` does (`providers/extraction/anthropic.ts`) and
 * the hosted `sqs` queue adapter does (`providers/index.ts`'s `selectQueueProvider`).
 * Self-file runs the `manual` adapter (`./manual.ts`, a real, deterministic
 * implementation, not a stub); this adapter lands with the feature that actually
 * transmits to IRIS.
 */
export function createIrisForm1099Provider(_deps: Form1099AdapterDeps): Form1099Provider {
  throw new Error(
    'IRIS e-file transmit is deferred (D-228-7). Self-file uses the manual adapter; ' +
      'the hosted IRIS transmitter lands with the feature that calls it.',
  );
}
