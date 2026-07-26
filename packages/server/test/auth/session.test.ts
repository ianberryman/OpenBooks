import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  clearedSessionCookie,
  readSessionToken,
  register,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionCookie,
} from '../../src/modules/auth';
import {
  cookieJar,
  NO_COOKIES,
  TEST_SESSION_CONFIG,
  useServiceDatabase,
  VALID_PASSWORD,
} from './support';

/**
 * The session credential: what is issued, what is stored, and how it is carried
 * (spec §5, ROADMAP D-03).
 */
describe('the stored form of a session token is not the token', () => {
  const db = useServiceDatabase();

  it('stores a SHA-256 digest and nothing that can be presented as a credential', async () => {
    // Migration `0001_tenancy`'s requirement, stated for sessions, invites, and API keys
    // alike: "a database read must not yield a usable credential." This is the assertion
    // that holds it — everything a `SELECT *` on the row can see is checked against the
    // token that was issued.
    const { sessionToken } = await register({
      email: 'stored-hash@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Stored Hash',
      org: { name: 'Stored Hash Books' },
    });

    const row = await db.app.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();

    expect(row.token_hash).not.toBe(sessionToken);
    expect(row.token_hash).toBe(createHash('sha256').update(sessionToken, 'utf8').digest('hex'));
    // `token_hash` is CHAR(64); a longer value would be truncated by a non-strict SQL mode
    // into a prefix that collides with every token sharing it.
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // Nothing else on the row carries the token either, in any encoding a client sends.
    const serialized = JSON.stringify(row, (_key, value: unknown) =>
      Buffer.isBuffer(value) ? value.toString('hex') : value,
    );
    expect(serialized).not.toContain(sessionToken);
  });

  it('issues a distinct token per session', async () => {
    const first = await register({
      email: 'distinct-a@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Distinct A',
      org: { name: 'Distinct A Books' },
    });
    const second = await register({
      email: 'distinct-b@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Distinct B',
      org: { name: 'Distinct B Books' },
    });

    expect(first.sessionToken).not.toBe(second.sessionToken);
    // 32 bytes base64url. The entropy is the whole security of the token — see the note
    // on why a fast hash is correct for it in `src/modules/auth/tokens.ts`.
    expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sets expires_at from the configured lifetime', async () => {
    const before = Date.now();
    const { expiresAt } = await register({
      email: 'expiry@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Expiry',
      org: { name: 'Expiry Books' },
    });
    const after = Date.now();

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_TTL_MS);

    const row = await db.app.selectFrom('sessions').select('expires_at').executeTakeFirstOrThrow();
    // DATETIME(3), so the round trip is millisecond-exact.
    expect(row.expires_at.getTime()).toBe(expiresAt.getTime());
  });
});

describe('cookie attributes', () => {
  it('is HttpOnly, Secure, SameSite=Lax, and path-scoped to the whole app (spec §5)', () => {
    const cookie = sessionCookie('a-token', TEST_SESSION_CONFIG);

    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.value).toBe('a-token');
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.secure).toBe(true);
    expect(cookie.options.sameSite).toBe('lax');
    expect(cookie.options.path).toBe('/');
    expect(cookie.options.maxAge).toBe(SESSION_TTL_MS / 1000);
  });

  it('takes Secure from config so plain-HTTP development can opt out', () => {
    expect(sessionCookie('t', { cookieSecure: false }).options.secure).toBe(false);
  });

  it('omits Domain entirely when none is configured', () => {
    // Not `domain: undefined`. A cookie library handed an explicit undefined does not
    // reliably serialize the same as one handed nothing, and host-only is the safer
    // default — exactOptionalPropertyTypes is what makes the distinction expressible.
    expect('domain' in sessionCookie('t', { cookieSecure: true }).options).toBe(false);
    expect(
      sessionCookie('t', { cookieSecure: true, cookieDomain: '.openbooks.test' }).options.domain,
    ).toBe('.openbooks.test');
  });

  it('clears with the same attributes it set, and a zero lifetime', () => {
    // Every attribute has to match or the browser treats it as a different cookie and
    // leaves the original in place.
    const set = sessionCookie('t', { cookieSecure: true, cookieDomain: '.openbooks.test' });
    const cleared = clearedSessionCookie({ cookieSecure: true, cookieDomain: '.openbooks.test' });

    expect(cleared.name).toBe(set.name);
    expect(cleared.value).toBe('');
    expect(cleared.options).toEqual({ ...set.options, maxAge: 0 });
  });
});

describe('reading the token off a request', () => {
  it('finds the session cookie', () => {
    expect(readSessionToken(cookieJar('the-token'))).toBe('the-token');
  });

  it('treats no cookie and an emptied cookie alike', () => {
    // A browser may echo `ob_session=` after being sent the cleared cookie. That is the
    // absence of a credential, not a credential to reject.
    expect(readSessionToken(NO_COOKIES)).toBeUndefined();
    expect(readSessionToken(cookieJar(''))).toBeUndefined();
  });

  it('ignores other cookies', () => {
    expect(readSessionToken({ cookies: { other: 'value' } })).toBeUndefined();
  });
});
