import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque session tokens, stored as a SHA-256 digest (spec §5, ROADMAP D-03).
 *
 * ## Why the stored form is a hash
 *
 * Migration `0001_tenancy` states the requirement for session, invite, and API-key
 * material alike: "a database read must not yield a usable credential." A stolen
 * backup, a `SELECT` through an unrelated SQL-injection hole, or a support engineer
 * with read access to production must not come away able to impersonate anyone. So the
 * cookie carries the token and the row carries `SHA-256(token)`; the lookup hashes the
 * presented value and matches on `uq_sessions_token`.
 *
 * ## Why a fast hash is correct here, and a slow one would be wrong
 *
 * The instinct carried over from `password.ts` is that a credential digest should be
 * slow. It should not, and the reason is that Argon2's cost buys exactly one thing:
 * time per guess, for an attacker guessing a *low-entropy, human-chosen* secret. That
 * is the whole problem password hashing solves. This token is 256 bits from
 * `crypto.randomBytes`, so there is no guessing attack to slow down — the search space
 * is not merely large, it is the same size as the digest's own preimage space, and
 * `2^256` guesses at one microsecond each is indistinguishable from `2^256` guesses at
 * one second each. A KDF here would buy nothing measured against any threat.
 *
 * It would also cost something real, in three ways:
 *
 *  1. **It runs on every authenticated request**, not once per login. A 40 ms hash on
 *     the read path is a self-inflicted denial of service, and it is worse than that
 *     under load, because Argon2's memory cost is per concurrent hash.
 *  2. **The lookup could not be an index probe.** Argon2 salts each hash, so two
 *     digests of the same token differ; finding the session would mean scanning
 *     `sessions` and verifying row by row. `uq_sessions_token` exists because SHA-256
 *     is deterministic.
 *  3. **It confuses where the strength lives.** The token's security is its entropy.
 *     Making the digest expensive invites the belief that a shorter token would be
 *     acceptable, which is the one change that would actually break this.
 *
 * SHA-256 rather than HMAC-SHA-256 for a related reason: a keyed digest would tie
 * session validity to a secret in the environment, so rotating `SESSION_SECRET` would
 * invalidate every live session even though the `sessions` table is untouched. D-03
 * chose server-side sessions specifically so the database is the single authority on
 * whether a session is live, and a key would split that authority in two.
 *
 * `SHA-256(x)` of a uniformly random 256-bit `x` is not a shortcut to `x` either: the
 * value in the database is not usable as a credential and is not reversible into one,
 * which is the property migration `0001` asked for and the only one needed.
 */

/**
 * 32 bytes: 256 bits of entropy, matching SHA-256's own width so the digest is not the
 * weaker half of the pair. Encoded base64url, giving a 43-character cookie value with
 * no characters needing cookie or URL escaping.
 */
const SESSION_TOKEN_BYTES = 32;

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Lowercase hex, exactly 64 characters, which is what `sessions.token_hash`'s `CHAR(64)`
 * holds. The width is pinned by `test/auth/session.test.ts` against the stored row rather
 * than by a runtime check here: a non-strict SQL mode truncates an over-long value into a
 * prefix that collides with every token sharing it, and that is a claim worth asserting
 * about the database rather than about this function.
 */
export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
