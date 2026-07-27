import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigValidationError } from '../../src/config/index';
import type { Config } from '../../src/config/index';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db/index';
import { resolveSessionIdentity, SESSION_COOKIE_NAME } from '../../src/modules/auth/index';
import type { App } from '../../src/transport/index';
import { IDEMPOTENCY_KEY_HEADER } from '../../src/transport/index';
import { useTestDatabase } from '../db';
import { buildTestApp, testConfig } from './harness';

/**
 * OB-029 — CORS, and the cookie posture it is inseparable from.
 *
 * The hosted layout is the only deployment that needs any of this, and it is also
 * the one nobody runs while developing: M2 works through the Vite proxy, which is
 * same-origin, so every one of these paths is exercised here or nowhere until the
 * first hosted deploy. Hence a suite that asserts the wire, not the config object —
 * the browser reads headers.
 */

const WEB_ORIGIN = 'https://app.example.com';
const OTHER_ORIGIN = 'https://evil.example.net';
const COOKIE_DOMAIN = 'example.com';

function corsConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return testConfig({
    CORS_ALLOWED_ORIGINS: WEB_ORIGIN,
    SESSION_COOKIE_DOMAIN: COOKIE_DOMAIN,
    ...overrides,
  });
}

function issuesOf(load: () => unknown): { variable: string; message: string }[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.issues.map((issue) => ({ variable: issue.variable, message: issue.message }));
    }
    throw error;
  }
  throw new Error('expected loadConfig to reject');
}

describe('CORS configuration', () => {
  it('is off unless CORS_ALLOWED_ORIGINS is set', () => {
    expect(testConfig().cors).toEqual({ enabled: false });
  });

  it('resolves a list into an exact allowlist', () => {
    const config = corsConfig({
      CORS_ALLOWED_ORIGINS: `${WEB_ORIGIN}, https://admin.example.com:8443`,
    });

    expect(config.cors).toEqual({
      enabled: true,
      allowedOrigins: [WEB_ORIGIN, 'https://admin.example.com:8443'],
    });
  });

  /**
   * The combination browsers reject outright. Accepting it here would mean the
   * operator's mistake surfaces as "every request fails" in a console rather than
   * as a refusal to start naming the variable.
   */
  it('refuses a wildcard origin, because every request here is credentialed', () => {
    const issues = issuesOf(() => corsConfig({ CORS_ALLOWED_ORIGINS: '*' }));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.variable).toBe('CORS_ALLOWED_ORIGINS');
    expect(issues[0]?.message).toContain('credentialed');
  });

  /**
   * The allowlist is compared by equality against the `Origin` header, so a form no
   * browser sends is an entry that matches nothing. The message names the fix.
   */
  it('refuses an origin a browser would never send verbatim', () => {
    for (const bad of [`${WEB_ORIGIN}/`, `${WEB_ORIGIN}/v1`, 'app.example.com']) {
      const issues = issuesOf(() => corsConfig({ CORS_ALLOWED_ORIGINS: bad }));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.variable).toBe('CORS_ALLOWED_ORIGINS');
    }

    expect(
      issuesOf(() => corsConfig({ CORS_ALLOWED_ORIGINS: `${WEB_ORIGIN}/` }))[0]?.message,
    ).toContain(`should be written "${WEB_ORIGIN}"`);
  });

  /**
   * The relationship this ticket exists to make explicit. A CORS allowlist the
   * SameSite=Lax session cookie cannot follow is a deployment where the preflight
   * passes, the request is sent with no cookie, and the API answers 401 — a failure
   * with nothing in the browser pointing at its cause.
   */
  it('requires a cookie domain once cross-origin callers are declared', () => {
    const issues = issuesOf(() => corsConfig({ SESSION_COOKIE_DOMAIN: '' }));

    expect(issues).toEqual([
      { variable: 'SESSION_COOKIE_DOMAIN', message: expect.stringContaining('SameSite=Lax') },
    ]);
  });

  it('refuses an allowed origin the session cookie could never reach', () => {
    const issues = issuesOf(() => corsConfig({ CORS_ALLOWED_ORIGINS: OTHER_ORIGIN }));

    expect(issues).toHaveLength(1);
    expect(issues[0]?.variable).toBe('CORS_ALLOWED_ORIGINS');
    expect(issues[0]?.message).toContain(`SESSION_COOKIE_DOMAIN=${COOKIE_DOMAIN}`);
  });

  /** A leading dot in a cookie domain is legal and means the same thing (RFC 6265). */
  it('accepts a leading-dot cookie domain and the domain itself as an origin host', () => {
    const config = corsConfig({
      SESSION_COOKIE_DOMAIN: `.${COOKIE_DOMAIN}`,
      CORS_ALLOWED_ORIGINS: `https://${COOKIE_DOMAIN}, ${WEB_ORIGIN}`,
    });

    expect(config.cors).toEqual({
      enabled: true,
      allowedOrigins: [`https://${COOKIE_DOMAIN}`, WEB_ORIGIN],
    });
  });
});

/**
 * The preflight and header assertions. These need an app but no data, so they build
 * their own instances; the credentialed round trip below needs a real session and
 * uses the shared container.
 */
describe('CORS on the wire', () => {
  const open: App[] = [];

  afterAll(async () => {
    await Promise.all(open.splice(0).map((app) => app.close()));
  });

  async function build(config: Config): Promise<App> {
    const { app } = await buildTestApp({ config });
    open.push(app);
    return app;
  }

  /** A preflight is OPTIONS *plus* Access-Control-Request-Method. */
  function preflight(origin: string, method = 'POST') {
    return {
      method: 'OPTIONS' as const,
      url: '/v1/accounts',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': `content-type, ${IDEMPOTENCY_KEY_HEADER}`,
      },
    };
  }

  /**
   * The assertion the whole ticket turns on. Spec §12 requires an `Idempotency-Key`
   * on every write and that header is not CORS-safelisted, so an allowlist without
   * it fails every write while leaving reads working.
   */
  it('allows Idempotency-Key on a write preflight', async () => {
    const app = await build(corsConfig());

    const response = await app.inject(preflight(WEB_ORIGIN));

    expect(response.statusCode).toBe(204);
    const allowed = (response.headers['access-control-allow-headers'] as string)
      .split(',')
      .map((header) => header.trim().toLowerCase());
    expect(allowed).toContain(IDEMPOTENCY_KEY_HEADER);
    // `application/json` is outside the safelist too, so a list with only the key
    // would fail the same requests for the other reason.
    expect(allowed).toContain('content-type');

    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-max-age']).toBe('600');
    expect(response.headers.vary).toContain('Origin');
  });

  /**
   * Refusal is the absence of the headers, not a status — see `src/transport/cors.ts`.
   * The browser is what enforces it; what the server owes is a log line naming the
   * origin, so the misconfiguration is diagnosable from the API's own logs.
   */
  it('refuses a preflight from an origin outside the allowlist', async () => {
    const { app, logs } = await buildTestApp({ config: corsConfig() });
    open.push(app);

    const response = await app.inject(preflight(OTHER_ORIGIN));

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['access-control-allow-headers']).toBeUndefined();
    expect(logs.text()).toContain(OTHER_ORIGIN);
  });

  /**
   * An `OPTIONS` carrying an `Origin` but no `Access-Control-Request-Method` is not a
   * preflight, and `@fastify/cors` refuses it rather than answering one — its
   * `strictPreflight` default, kept. Pinned because it is the one place the plugin
   * differs from the hand-written version this replaced, which let such a request
   * fall through to the 404 handler: no browser sends this shape, but a future real
   * `OPTIONS` route (M5) would be shadowed by it, and the shadowing should be
   * something a test failure announces rather than something a deploy discovers.
   */
  it('refuses an OPTIONS that is not a preflight rather than answering one', async () => {
    const app = await build(corsConfig());

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/accounts',
      headers: { origin: WEB_ORIGIN },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
    expect(response.headers['access-control-max-age']).toBeUndefined();
  });

  it('answers an actual request from a disallowed origin without CORS headers', async () => {
    const app = await build(corsConfig());

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: OTHER_ORIGIN },
    });

    // Served, because `Origin` is not a credential and non-browser callers send
    // anything or nothing. The browser discards it for want of the header.
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toContain('Origin');
  });

  /**
   * `x-request-id` is on every response so a client can quote it in a support
   * request; cross-origin it is unreadable by script unless exposed.
   */
  it('exposes the correlation id on an actual request', async () => {
    const app = await build(corsConfig());

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: WEB_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-expose-headers']).toContain('x-request-id');
  });

  /**
   * Headers are attached in `onSend` precisely so they survive the rejection paths
   * that skip the remaining `onRequest` hooks. A 400 the browser will not let the
   * client read is a 400 that reports as a generic CORS failure.
   */
  it('keeps the headers on a request rejected before any route runs', async () => {
    const app = await build(corsConfig());

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: WEB_ORIGIN, [IDEMPOTENCY_KEY_HEADER]: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });

  it('registers nothing when no origins are declared', async () => {
    const app = await build(testConfig());

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: WEB_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    // The preflight is not short-circuited either; OPTIONS falls through to the
    // 404 handler exactly as it did before this ticket.
    expect((await app.inject(preflight(WEB_ORIGIN))).statusCode).toBe(404);
  });
});

/**
 * The credentialed round trip, against real MySQL.
 *
 * The header assertions above prove the response says the right things. This proves
 * the request the browser would actually make — preflight, then a write carrying the
 * session cookie and an `Idempotency-Key` from an allowed origin — is served as an
 * authenticated request rather than as an anonymous one. It needs the real identity
 * resolver and a real session row, so it cannot be done without the database.
 */
describe('a credentialed cross-origin write', () => {
  const db = useTestDatabase();
  let app: App | undefined;

  beforeAll(async () => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
    const built = await buildTestApp({
      config: corsConfig(),
      resolveIdentity: resolveSessionIdentity,
    });
    app = built.app;
  });

  afterAll(async () => {
    await app?.close();
    app = undefined;
    await destroyDatabase();
  });

  it('preflights, then posts with the session cookie and is authenticated', async () => {
    const instance = app;
    if (instance === undefined) throw new Error('app builds in beforeAll');

    const options = await instance.inject({
      method: 'OPTIONS',
      url: '/v1/auth/register',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': `content-type, ${IDEMPOTENCY_KEY_HEADER}`,
      },
    });
    expect(options.statusCode).toBe(204);
    expect(options.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);

    const registered = await instance.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: WEB_ORIGIN, [IDEMPOTENCY_KEY_HEADER]: 'cors-register' },
      payload: {
        email: 'cors@example.invalid',
        password: 'correct horse battery staple',
        displayName: 'Cross Origin',
        org: { name: 'Cross Origin Books' },
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(registered.headers['access-control-allow-credentials']).toBe('true');

    /**
     * The cookie the browser is told to keep. `Domain` has to be present and has to
     * cover the calling origin, or SameSite=Lax withholds it on the very next
     * request and the session silently does not exist — the failure `corsIssues`
     * refuses to let a deployment reach.
     */
    const setCookie = registered.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
    expect(setCookie?.['domain']).toBe(COOKIE_DOMAIN);
    expect(setCookie?.sameSite?.toLowerCase()).toBe('lax');
    expect(setCookie?.httpOnly).toBe(true);

    const token = setCookie?.value;
    if (token === undefined || token === '') throw new Error('register set no session cookie');

    // The write the cookie was for: an allowed origin, credentials attached, and a
    // response that is about this user rather than a 401.
    const created = await instance.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: {
        origin: WEB_ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        [IDEMPOTENCY_KEY_HEADER]: 'cors-account',
      },
      payload: {
        code: '1000',
        name: 'Operating bank account',
        type: 'asset',
        normalBalance: 'debit',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(created.headers['access-control-expose-headers']).toContain('x-request-id');

    // Without the cookie the same request is refused, which is what makes the line
    // above a statement about credentials rather than about an open endpoint.
    const anonymous = await instance.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { origin: WEB_ORIGIN, [IDEMPOTENCY_KEY_HEADER]: 'cors-account-anon' },
      payload: {
        code: '1001',
        name: 'Second account',
        type: 'asset',
        normalBalance: 'debit',
      },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });
});
