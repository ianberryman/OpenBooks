import { hash as argon2Hash, argon2id } from 'argon2';
import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  needsPasswordRehash,
  PASSWORD_LENGTH_BOUNDS,
  passwordLength,
  verifyPassword,
} from '../../src/modules/auth/password';

/**
 * Argon2id password hashing (ROADMAP D-06).
 *
 * No database: hashing is pure. The suite still runs under the server project, so it pays
 * for the shared container — see the note in `test/README.md`.
 */
describe('password hashing round-trips', () => {
  it('verifies the password it was given', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(stored, 'correct horse battery stapler')).toBe(false);
    expect(await verifyPassword(stored, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword(stored, '')).toBe(false);
  });

  it('produces a different digest each time for the same password', async () => {
    // Per-hash salt. Two equal digests would mean an attacker could tell which accounts
    // share a password, and would make a precomputed table usable across the whole table.
    const [a, b] = await Promise.all([
      hashPassword('same password here'),
      hashPassword('same password here'),
    ]);

    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same password here')).toBe(true);
    expect(await verifyPassword(b, 'same password here')).toBe(true);
  });

  it('stores the chosen parameters in the digest, and they are the argued ones', async () => {
    // The parameters live in the digest, which is what lets `verify` read them and what
    // makes raising the cost a per-user rehash rather than a migration. Asserted literally
    // so that changing them is a deliberate edit in two places with a reason, not a
    // drive-by tweak — see the commentary in `src/modules/auth/password.ts`.
    const stored = await hashPassword('parameters are encoded here');

    // PHC string format, in the order libargon2 emits: m, then p, then t.
    expect(stored.startsWith('$argon2id$v=19$m=19456,p=1,t=2$')).toBe(true);
    // 32-byte output, base64 without padding.
    expect(stored.split('$').at(-1)).toHaveLength(43);
  });

  it('treats a stored value that is not an Argon2 digest as a failed authentication', async () => {
    // `test/db/factories.ts` writes exactly this shape so fixtures do not pay for real
    // hashes. It must be unsatisfiable rather than a 500 — a server error here would tell
    // an attacker which accounts have unusable hashes.
    const placeholder =
      '$argon2id$v=19$m=65536,t=3,p=4$dGVzdGZpeHR1cmVzYWx0$dGVzdGZpeHR1cmVub3RhcmVhbGhhc2g';

    await expect(verifyPassword(placeholder, 'anything')).resolves.toBe(false);
    await expect(verifyPassword('not a hash at all', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('', 'anything')).resolves.toBe(false);
  });
});

describe('rehash detection', () => {
  it('leaves a current hash alone', async () => {
    expect(needsPasswordRehash(await hashPassword('a fresh enough password'))).toBe(false);
  });

  it('flags a hash made with weaker parameters', async () => {
    // The upgrade path: `login` rehashes on the next successful sign-in, which is the only
    // moment the plaintext exists.
    const weak = await argon2Hash('a fresh enough password', {
      type: argon2id,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });

    expect(needsPasswordRehash(weak)).toBe(true);
    // Still verifiable: `verify` reads the parameters out of the digest.
    expect(await verifyPassword(weak, 'a fresh enough password')).toBe(true);
  });

  it('does not throw on an unparseable hash', () => {
    expect(needsPasswordRehash('not a hash at all')).toBe(false);
  });
});

describe('length is measured in code points', () => {
  it('counts an astral character once', () => {
    // `"🔐".length` is 2. A user whose passphrase is emoji should not be told it is twice
    // as long as it is, in either direction.
    expect(passwordLength('🔐🔐🔐')).toBe(3);
    expect(passwordLength('abc')).toBe(3);
  });

  it('states bounds a caller can render', () => {
    expect(PASSWORD_LENGTH_BOUNDS.min).toBe(12);
    expect(PASSWORD_LENGTH_BOUNDS.max).toBe(256);
  });
});
