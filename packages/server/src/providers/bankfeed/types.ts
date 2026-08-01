/**
 * Everything a `BankFeedProvider` adapter needs off a decrypted
 * `bank_feed_connections` row (OB-227, D-126). BYO credentials (D-131): the org
 * supplies its own Stripe restricted key, so the caller — the service that
 * resolves a connection — reads `restrictedKey` out of the secrets provider via
 * the row's `secret_ref` and hands the plain value here; no adapter ever reads a
 * `secrets` row itself, exactly as `PaymentAdapterDeps` keeps it for PAY.
 *
 * Its own file rather than declared in `index.ts` for `payment/types.ts`'s
 * reason: `fake.ts` and `stripe-financial-connections.ts` both need the shape,
 * and `index.ts` imports both of them — a type declared there and imported back
 * would be the exact cycle `.dependency-cruiser.cjs`'s `no-circular` rule refuses.
 */
export interface BankFeedAdapterDeps {
  readonly restrictedKey: string;
  readonly externalAccountId: string;
  readonly appBaseUrl?: string;
}
