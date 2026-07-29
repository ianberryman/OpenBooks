/**
 * Everything a `PaymentProcessorProvider` adapter needs off a decrypted
 * `processor_connections` row (initiative J, D-101). The caller — the service
 * that resolves a connection — reads `secretKey`/`webhookSecret` out of the
 * secrets provider via `secret_ref`/`webhook_secret_ref` and hands the plain
 * values here; no adapter ever reads a `secrets` row itself.
 *
 * Its own file rather than declared in `index.ts`: `fake.ts`, `stripe.ts` and
 * `square.ts` all need the shape, and `index.ts` imports the three of them —
 * a type declared there and imported back would be the exact cycle
 * `.dependency-cruiser.cjs`'s `no-circular` rule refuses.
 */
export interface PaymentAdapterDeps {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly publishableKey: string | null;
  readonly externalAccountId: string | null;
  readonly appBaseUrl?: string;
}
