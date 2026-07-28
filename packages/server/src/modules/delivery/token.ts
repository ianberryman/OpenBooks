import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { selectDeliveryCredentialByKeyPrefix } from '../../db';

/**
 * The hosted invoice page's capability token (OB-121; ROADMAP D-74;
 * `shared-types/delivery/delivery.ts`'s file header, which this implements).
 *
 * `{prefix}.{secret}` — `prefix` is 6 random bytes, base64url (8 characters, no
 * padding: 6 bytes is exactly 48 bits, and base64 encodes 6 bits per character, so
 * the encoding divides evenly and Node's `base64url` needs no `=`). `secret` is 32
 * random bytes, base64url (43 characters) — the same width `sessionTokenHash`'s
 * header argues for a bearer credential: 256 bits is the digest's own preimage
 * space, so there is no guessing attack a slower hash would defend against.
 *
 * The row stores `key_prefix` (the lookup handle, not secret — an index over it is
 * only useful because it is not) and `SHA-256(token)` over the *whole* token,
 * prefix included, as the 32 raw bytes a `BINARY(32)` column holds. Hashing the
 * whole string rather than the secret alone costs nothing (the prefix is public
 * anyway, sitting beside the hash on the same row) and means there is exactly one
 * string this module ever hashes, not two call sites that could disagree about
 * which substring feeds the digest.
 *
 * SHA-256 rather than a slow KDF, for `sessionTokenHash`'s reason applied here
 * verbatim: the secret is 256 bits from `crypto.randomBytes`, not a human-chosen
 * password, so a fast deterministic hash is both correct (the lookup is an index
 * probe on `key_prefix`, not a row-by-row scan) and sufficient (there is no
 * low-entropy guessing attack to slow down).
 */
const KEY_PREFIX_BYTES = 6;
const TOKEN_SECRET_BYTES = 32;

export interface MintedDeliveryToken {
  /** `{prefix}.{secret}` — handed to the customer once, in the email link. Never stored. */
  readonly token: string;
  /** Stored in `invoice_deliveries.key_prefix`. Not secret; it is the index key. */
  readonly keyPrefix: string;
  /** Stored in `invoice_deliveries.token_hash`. The 32 raw bytes of `SHA-256(token)`. */
  readonly tokenHash: Buffer;
}

export function mintDeliveryToken(): MintedDeliveryToken {
  const keyPrefix = randomBytes(KEY_PREFIX_BYTES).toString('base64url');
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
  const token = `${keyPrefix}.${secret}`;

  return { token, keyPrefix, tokenHash: hashToken(token) };
}

/** What a verified token names: the org it belongs to and which delivery it is. */
export interface DeliveryTokenMatch {
  readonly orgId: Buffer;
  readonly deliveryId: Buffer;
}

/**
 * Verifies a presented token against `invoice_deliveries`, or returns `null`.
 *
 * `null` is the *only* outcome for every way a token can fail to match — an
 * unparseable value, an unknown prefix, a prefix that resolves but whose hash does
 * not match. There is no second return shape naming which of those happened,
 * because a token-holder and an attacker probing for valid prefixes must receive
 * the same answer either way (A7's argument, applied to a credential rather than a
 * resource id): the caller here is `public-invoice.service.ts`, which turns `null`
 * into the same 404 a genuinely nonexistent invoice produces.
 *
 * The two checks that can fail — "does this prefix name a row" and "does the hash
 * match" — are both taken to completion before returning, rather than the second
 * being skipped when the first already failed. `selectDeliveryCredentialByKeyPrefix`
 * returning `undefined` *does* short-circuit (there is nothing left to hash
 * against), but that branch and the hash-mismatch branch below produce the
 * identical `null`, so nothing observable — timing included, past the one query — a
 * caller could use to tell "no such prefix" from "wrong secret" apart. What
 * `timingSafeEqual` buys is the comparison itself: a byte-at-a-time `===` on the
 * digest would let an attacker who can measure response time learn the hash one
 * byte at a time, which two matching prefixes and 2^256 well-spent guesses would
 * turn into a working token.
 */
export async function verifyDeliveryToken(token: string): Promise<DeliveryTokenMatch | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [keyPrefix, secret] = parts;
  if (keyPrefix === undefined || keyPrefix.length === 0) return null;
  if (secret === undefined || secret.length === 0) return null;

  const row = await selectDeliveryCredentialByKeyPrefix(keyPrefix);
  if (row === undefined) return null;

  const presented = hashToken(token);

  // `timingSafeEqual` throws on a length mismatch rather than returning `false`; both
  // sides are SHA-256 digests here (32 bytes each, always), so this is a defensive
  // guard against a stored value that is not — never a branch production can reach —
  // rather than a check this function expects to fail.
  if (presented.length !== row.tokenHash.length) return null;
  if (!timingSafeEqual(presented, row.tokenHash)) return null;

  return { orgId: row.orgId, deliveryId: row.id };
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
