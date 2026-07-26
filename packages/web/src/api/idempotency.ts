/**
 * `Idempotency-Key` — required on every write on this API (spec §12), so a client that
 * omits it fails every mutation with a 400.
 *
 * ## What makes it hard to forget, and what does not
 *
 * The generated types are the enforcement. Every write operation in `openapi.json`
 * declares the header as a **required** parameter, so `schema.d.ts` gives each one
 * `parameters: { header: { 'idempotency-key': string } }`, and `openapi-fetch` turns a
 * required `parameters` member into a required `init` argument. `api.POST('/v1/journals',
 * { body })` therefore does not compile. That is stronger than any wrapper: it is checked
 * at every call site, including ones written in M2 by someone who has not read this file.
 *
 * The rejected alternative was a wrapper that mints a key per HTTP request. It would
 * remove the friction and quietly destroy the guarantee, because the point of the header
 * is that a *retry* carries the **same** key: that is how the server distinguishes "the
 * user asked twice" from "the network dropped the response and the client asked again"
 * (OB-017). A fresh key per attempt makes every retry a second journal entry — exactly
 * the double-post the header exists to prevent. So the key is minted where the user's
 * intent is formed, once, and travels with it.
 *
 * `IdempotentVariables` is the shape that expresses that for TanStack Query, whose
 * `retry` re-invokes `mutationFn` with the same variables. Mint the key when the form is
 * submitted, put it in the variables, and every attempt for that intent — including
 * TanStack's retries and a user's second click on a stuck button — sends the key the
 * first attempt sent.
 */

/** Lowercase because that is how `openapi.json` names it; HTTP headers are case-insensitive. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * The `params.header` value for a write, so the header name is spelled once in this
 * package and a typo is a compile error at this line rather than a 400 at runtime.
 *
 * Returned separately from `params` rather than as a whole `init` object because most
 * writes also carry `params.path`, and a helper that owned all of `params` would have to
 * be spread into — where a later `params:` key silently replaces it.
 */
export function idempotencyHeader(key: string): { 'idempotency-key': string } {
  return { [IDEMPOTENCY_KEY_HEADER]: key };
}

/**
 * Mutation variables that carry their own idempotency key.
 *
 * ```ts
 * const post = useMutation({
 *   mutationFn: ({ idempotencyKey, ...entry }: IdempotentVariables<PostJournalRequest>) =>
 *     unwrap(await api.POST('/v1/journals', {
 *       body: entry,
 *       params: { header: idempotencyHeader(idempotencyKey) },
 *     })),
 * });
 * // At the point the user commits, not inside mutationFn:
 * post.mutate({ ...entry, idempotencyKey: newIdempotencyKey() });
 * ```
 */
export type IdempotentVariables<V> = V & { readonly idempotencyKey: string };

/**
 * A version-4 UUID from `crypto.getRandomValues`, not `crypto.randomUUID`.
 *
 * `randomUUID` is gated on a secure context, and self-hosting over plain HTTP on a LAN
 * is a supported way to run this (`SESSION_COOKIE_SECURE` defaults to `false` in
 * `.env.example`). There, `randomUUID` is `undefined` and every write in the application
 * throws. `getRandomValues` is available in every context, so this is one code path
 * instead of a fallback branch that only the deployment nobody tests would exercise.
 *
 * `Array.from` with a mapping function rather than indexed writes into the `Uint8Array`:
 * `noUncheckedIndexedAccess` makes `bytes[6]` `number | undefined`, and the `?? 0` that
 * silences it would be a lie about an index that is in range by construction.
 */
export function newIdempotencyKey(): string {
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
    // RFC 9562 §5.4: the version nibble and the two variant bits are fixed; the other
    // 122 bits are the random ones.
    if (index === 6) return (byte & 0x0f) | 0x40;
    if (index === 8) return (byte & 0x3f) | 0x80;
    return byte;
  });

  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
