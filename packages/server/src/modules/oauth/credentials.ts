import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { sessionTokenHash } from '../auth/tokens';

/**
 * Opaque credential minting for the OAuth authorization server (OB-098; ROADMAP D-53,
 * D-61): client secrets, access tokens, and refresh tokens.
 *
 * ## One shape, reused three ways
 *
 * Every credential below is `{typePrefix}{32 random bytes, base64url}` — 256 bits of
 * `crypto.randomBytes`, matching the width `tokens.ts` argues a bearer credential
 * should have, and hashed with `sessionTokenHash`, the same SHA-256-hex digest
 * sessions use. That file's reasoning transfers verbatim: these are high-entropy
 * random strings, not human-chosen secrets, so a slow KDF would cost real latency on
 * every authenticated request and buy nothing — there is no guessing attack to slow
 * down. Reusing the function rather than a second copy is D-61's "opaque, not JWT"
 * applied consistently: one hashing decision for every credential in the system, not
 * one per module that mints one.
 *
 * `typePrefix` (`oba_`, `obr_`, `obs_`, `obc_`) is a display aid — it is what makes a
 * leaked token identifiable in a log line as "an OAuth access token" rather than an
 * opaque blob — and costs nothing: the prefix is public by construction (it has to be,
 * to be recognisable), so folding it into the hashed string rather than treating it as
 * a separate secret changes nothing about what an attacker who reads it can do.
 *
 * `keyPrefix` truncates the *whole* minted string (prefix included) to
 * `secret_prefix`/`key_prefix`'s column width (`VARCHAR(16)`), for
 * `mintDeliveryToken`'s reason: hashing and displaying the same string, rather than
 * splitting it into a public half and a secret half, means there is exactly one
 * string this module ever has to agree with itself about.
 */
const CREDENTIAL_SECRET_BYTES = 32;

/** Fits `oauth_clients.secret_prefix` / `oauth_tokens.key_prefix`, both `VARCHAR(16)`. */
const DISPLAY_PREFIX_CHARS = 12;

export interface MintedCredential {
  /** The full value. Shown to the caller exactly once; only its hash is stored. */
  readonly token: string;
  /** Stored alongside the hash — not secret, a display/lookup aid. */
  readonly keyPrefix: string;
  /** `sessionTokenHash(token)` — lowercase hex, `CHAR(64)`. */
  readonly hash: string;
}

export function mintCredential(typePrefix: string): MintedCredential {
  const token = `${typePrefix}${randomBytes(CREDENTIAL_SECRET_BYTES).toString('base64url')}`;
  return {
    token,
    keyPrefix: token.slice(0, DISPLAY_PREFIX_CHARS),
    hash: sessionTokenHash(token),
  };
}

/**
 * The public `client_id` — an identifier, not a secret. It is what the `authorize`
 * endpoint resolves an org from before any session exists (`0010_platform`'s
 * `oauth_clients` header), so it is stored and returned in the clear rather than
 * hashed; `mintCredential` is for the values that must never be recovered from the
 * row, and this is not one of them.
 */
export function mintPublicClientId(): string {
  return `obc_${randomBytes(CREDENTIAL_SECRET_BYTES).toString('base64url')}`;
}

export interface MintedAuthorizationCode {
  /** Handed to the client in the redirect. Never stored. */
  readonly code: string;
  /** `sessionTokenHash(code)` — what `oauth_grants.code_hash` holds. */
  readonly hash: string;
}

/**
 * No prefix and no `keyPrefix`: `oauth_grants` has no `key_prefix` column, because a
 * code is redeemed once, seconds after it is minted, by a client that already has the
 * whole string — there is no listing or display use for a prefix the way a
 * long-lived client secret or token has.
 */
export function mintAuthorizationCode(): MintedAuthorizationCode {
  const code = randomBytes(CREDENTIAL_SECRET_BYTES).toString('base64url');
  return { code, hash: sessionTokenHash(code) };
}

/**
 * RFC 7636 §4.6, `S256` only — the one method `pkceMethodSchema` admits (`plain` is a
 * downgrade PKCE exists to close, per its own comment in `shared-types/platform/oauth.ts`).
 *
 * `timingSafeEqual` rather than `===`: the digest is compared against a value that
 * ultimately came from the token endpoint's request body, and a byte-at-a-time
 * comparison would let response timing narrow down the expected challenge the same
 * way `verifyDeliveryToken`'s header argues for a bearer secret. Both sides are
 * fixed-width base64url of a 32-byte digest, so the lengths always agree in the
 * reachable case; the length check is a defensive guard, not a branch production
 * takes.
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const computedBuffer = Buffer.from(computed, 'utf8');
  const challengeBuffer = Buffer.from(codeChallenge, 'utf8');

  if (computedBuffer.length !== challengeBuffer.length) return false;
  return timingSafeEqual(computedBuffer, challengeBuffer);
}
