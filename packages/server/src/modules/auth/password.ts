import { argon2id, hash, needsRehash, verify } from 'argon2';

/**
 * Password hashing (ROADMAP D-06: Argon2id, not bcrypt).
 *
 * ## The cost parameters, and why they are not the library's defaults
 *
 * `argon2`'s defaults are m=65536 KiB (64 MiB), t=3, p=4 — RFC 9106's *second*
 * recommended option. That recommendation is written for a key-derivation function:
 * one caller, deriving one key, on a machine doing nothing else. A login endpoint is
 * the opposite shape of workload, and two things follow from that.
 *
 * **Memory is the shared resource, and it is per concurrent hash.** At 64 MiB, eight
 * simultaneous logins reserve half a gigabyte. OB-007 provisions Fargate tasks, where
 * that is a substantial fraction of the task's memory, and an unauthenticated endpoint
 * that allocates 64 MiB per request is a memory-exhaustion vector aimed at the process
 * that also holds the database pool. The cost of resisting an offline cracking attack
 * must not be a cheap way to take the API down.
 *
 * **Lanes do not buy throughput here.** `node-argon2` runs the hash on the libuv
 * threadpool, whose default size is four and which `fs`, `dns`, and the rest of
 * `crypto` also draw from. p=4 divides one hash's work across lanes that compete with
 * every other threadpool consumer rather than adding parallel capacity, so it costs
 * scheduling contention and returns nothing.
 *
 * So: **m=19456 KiB (19 MiB), t=2, p=1, Argon2id, 32-byte output** — the OWASP
 * Password Storage configuration for interactive authentication. It is one of the
 * settings OWASP states as equivalent in strength to the RFC's second option (the
 * memory/time tradeoff is explicit: less memory, more passes), it measures at roughly
 * 30–50 ms per hash on the hardware this runs on, which is the right order for a login
 * a human is waiting on, and 19 MiB per concurrent login is a bounded amount of memory
 * rather than an invitation.
 *
 * The salt is left to the library: 16 random bytes per hash, from `crypto`. Passing
 * one here would only create the opportunity to reuse it.
 *
 * ## Changing these later
 *
 * Every parameter is encoded in the stored hash string, so `verify` reads the values a
 * hash was made with and old hashes keep working. `needsPasswordRehash` reports when a
 * stored hash was made with weaker parameters than these, and `login` rehashes on the
 * next successful sign-in — which is the only moment the plaintext exists. Raising the
 * cost is therefore an edit here plus a migration that happens by itself.
 */
const HASH_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

/**
 * The subset `needsRehash` compares. Derived from `HASH_OPTIONS` rather than
 * restated, so raising a cost cannot be applied to new hashes and forgotten for the
 * comparison that decides which old ones are stale. `hashLength` and `type` are
 * absent because the library's check does not read them.
 */
const REHASH_OPTIONS = {
  memoryCost: HASH_OPTIONS.memoryCost,
  timeCost: HASH_OPTIONS.timeCost,
  parallelism: HASH_OPTIONS.parallelism,
} as const;

/**
 * Bounds on the plaintext, in that order of importance.
 *
 * The maximum is a denial-of-service control, not a security policy: Argon2 hashes its
 * input into the first block, so a multi-megabyte "password" costs a multi-megabyte
 * read on an unauthenticated endpoint. 256 characters is far past any passphrase a
 * person or a password manager produces.
 *
 * The minimum is 12 rather than NIST SP 800-63B's floor of 8. Length is the only
 * property worth requiring — 800-63B is explicit that composition rules (an uppercase,
 * a digit, a symbol) push users toward predictable substitutions and are counter-
 * productive — so this file requires length and nothing else.
 *
 * Measured in code points via the spread, not `.length`: `"🔐".length` is 2, and a
 * user whose passphrase is emoji should not be told it is twice as long as it is.
 */
const MIN_PASSWORD_CODE_POINTS = 12;
const MAX_PASSWORD_CODE_POINTS = 256;

export const PASSWORD_LENGTH_BOUNDS = {
  min: MIN_PASSWORD_CODE_POINTS,
  max: MAX_PASSWORD_CODE_POINTS,
} as const;

export function passwordLength(password: string): number {
  return [...password].length;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/**
 * Whether `password` produced `hash`.
 *
 * Returns `false` for a stored value that is not a well-formed Argon2 hash instead of
 * propagating the library's parse error. Such a row exists — `test/db/factories.ts`
 * writes a deliberately fake hash so that fixtures do not pay for real ones — and it
 * also arrives from a future imported-account path. Either way it is a credential that
 * cannot be satisfied, which is a failed authentication and not a server fault: a
 * `500` here would tell an attacker which accounts have unusable hashes, and A7's
 * reasoning applied to login (see `UnauthenticatedError`) says those must look like
 * every other failure.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    // No options: `verify` reads the parameters out of the digest, which is what makes
    // a hash written under an older cost still verifiable.
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Whether a stored hash was made with weaker parameters than the current ones. */
export function needsPasswordRehash(storedHash: string): boolean {
  try {
    return needsRehash(storedHash, REHASH_OPTIONS);
  } catch {
    // Unparseable, so it cannot be verified either — `verifyPassword` has already
    // refused it and nothing will reach this with the plaintext to rehash from.
    return false;
  }
}
