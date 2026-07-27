import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getContext } from '../../src/context/index';
import {
  ConflictError,
  IdempotencyKeyConflictError,
  InternalError,
  PermissionDeniedError,
  PreconditionFailedError,
  UnauthenticatedError,
  assertFound,
  assertOrgMatch,
} from '../../src/errors/index';
import type { App, IdentityResolver } from '../../src/transport/index';
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_RESPONSE_HEADER,
  isAuthenticatedContext,
  requireIdempotencyKey,
} from '../../src/transport/index';
import type { TestApp } from './harness';
import { buildTestApp, errorBody } from './harness';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Every built instance is closed, or swagger-ui's file handles keep the process alive. */
const open: App[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function build(...args: Parameters<typeof buildTestApp>): Promise<TestApp> {
  const built = await buildTestApp(...args);
  open.push(built.app);
  return built;
}

describe('GET /health', () => {
  it('answers 200 with the documented body', async () => {
    const { app } = await build();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  /**
   * The image's HEALTHCHECK (Dockerfile) runs
   * `fetch('http://127.0.0.1:' + (HTTP_PORT || 3000) + '/health').then(r => r.ok ? 0 : 1)`,
   * so the contract it depends on is exactly: this path, and `response.ok`. The port
   * comes from `HTTP_PORT`, which `config.http.port` is the only reader of and
   * `src/entrypoints/api.ts` passes straight to `listen`, so there is no second
   * place a port could be decided.
   */
  it('satisfies the image HEALTHCHECK contract', async () => {
    const { app } = await build();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
  });

  it('does not open a database connection', async () => {
    // `initializeDatabase` was never called in this process. A health check that
    // queried would throw "Database not initialized" (src/db/client.ts) and this
    // test would be a 500.
    const { app } = await build();

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('request context', () => {
  function contextRoute(app: App): void {
    app.get('/t/context', { schema: { hide: true } }, () => {
      const context = getContext();
      return {
        requestId: context.requestId,
        orgId: context.orgId,
        userId: context.userId,
        roleId: context.roleId,
        actorType: context.actorType,
        actorId: context.actorId,
        idempotencyKey: context.idempotencyKey,
        authenticated: isAuthenticatedContext(context),
      };
    });
  }

  it('is populated inside a handler', async () => {
    const { app } = await build();
    contextRoute(app);

    const body = (await app.inject({ method: 'GET', url: '/t/context' })).json<{
      requestId: string;
      orgId: string;
      authenticated: boolean;
    }>();

    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    // Pre-auth: the nil UUID, which names no row. See src/transport/context.ts.
    expect(body.orgId).toBe(NIL_UUID);
    expect(body.authenticated).toBe(false);
  });

  it('echoes the request id and adopts a safe inbound one', async () => {
    const { app } = await build();
    contextRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/t/context',
      headers: { 'x-request-id': 'trace-abc.123:9' },
    });

    expect(response.headers[REQUEST_ID_RESPONSE_HEADER]).toBe('trace-abc.123:9');
    expect(response.json<{ requestId: string }>().requestId).toBe('trace-abc.123:9');
  });

  it('ignores an inbound request id that could corrupt a log line or a header', async () => {
    const { app } = await build();
    contextRoute(app);

    for (const hostile of ['x'.repeat(200), 'has space', 'line\nbreak']) {
      const response = await app.inject({
        method: 'GET',
        url: '/t/context',
        headers: { 'x-request-id': hostile },
      });

      expect(response.json<{ requestId: string }>().requestId).not.toBe(hostile);
      expect(response.headers[REQUEST_ID_RESPONSE_HEADER]).not.toBe(hostile);
    }
  });

  it('carries the request id on an error response too', async () => {
    const { app } = await build();

    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers[REQUEST_ID_RESPONSE_HEADER]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('re-scopes to the resolved identity while preserving the request id', async () => {
    const resolveIdentity: IdentityResolver = () =>
      Promise.resolve({
        orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        roleId: '00000000-0000-4000-8000-000000000001',
        actorType: 'user',
        actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        invocationMode: 'interactive',
      });

    const { app } = await build({ resolveIdentity });
    contextRoute(app);

    const body = (
      await app.inject({
        method: 'GET',
        url: '/t/context',
        headers: { 'x-request-id': 'inbound-1' },
      })
    ).json<{ requestId: string; orgId: string; userId: string; authenticated: boolean }>();

    expect(body.orgId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(body.userId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(body.authenticated).toBe(true);
    // Derived, not re-minted: the correlation id survives authentication.
    expect(body.requestId).toBe('inbound-1');
  });

  it('leaves the scope unauthenticated when the resolver finds no identity', async () => {
    const { app } = await build({ resolveIdentity: () => Promise.resolve(null) });
    contextRoute(app);

    const body = (await app.inject({ method: 'GET', url: '/t/context' })).json<{
      authenticated: boolean;
    }>();

    expect(body.authenticated).toBe(false);
  });

  it('maps a resolver that rejects the credentials it found to 401', async () => {
    const { app } = await build({
      resolveIdentity: () => Promise.reject(new UnauthenticatedError()),
    });
    contextRoute(app);

    const response = await app.inject({ method: 'GET', url: '/t/context' });

    expect(response.statusCode).toBe(401);
    expect(errorBody(response.body).error.code).toBe('unauthenticated');
  });

  /**
   * A stale or revoked `HttpOnly` session cookie makes the resolver reject, and the browser
   * cannot clear such a cookie itself — so if that rejection 401'd `login`/`register`/`logout`
   * too, the holder would be locked out of the only routes that can replace or clear it. The
   * hook therefore skips resolution on those three routes. They reach their handlers here
   * (and fail on their own terms — this transport-only app has no database — rather than on
   * the hook's `unauthenticated`), while every other route still 401s, as the test above pins.
   */
  it('does not let a rejecting resolver 401 the routes that establish or clear a session', async () => {
    const { app } = await build({
      resolveIdentity: () => Promise.reject(new UnauthenticatedError()),
    });

    for (const url of ['/v1/auth/login', '/v1/auth/register', '/v1/auth/logout']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { [IDEMPOTENCY_KEY_HEADER]: 'stale-cookie-must-not-lock-the-door' },
        payload: {},
      });

      expect(response.statusCode, `${url} must not be blocked by the identity hook`).not.toBe(401);
    }
  });
});

describe('error handling', () => {
  /**
   * The status and code come from `ERROR_CODE_STATUS`, which is
   * `Record<ErrorCode, HttpErrorStatus>` — exhaustive, so the handler needs no
   * fallback and this table is the whole mapping.
   */
  const cases = [
    { name: 'unauthenticated', error: () => new UnauthenticatedError(), status: 401 },
    {
      name: 'permission_denied',
      error: () => new PermissionDeniedError('journals.post'),
      status: 403,
    },
    {
      name: 'conflict',
      error: () => new ConflictError('Account code already in use.'),
      status: 409,
    },
    {
      name: 'idempotency_key_conflict',
      error: () => new IdempotencyKeyConflictError(),
      status: 409,
    },
    {
      name: 'precondition_failed',
      error: () => new PreconditionFailedError('period.closed', 'The fiscal period is closed.'),
      status: 412,
    },
  ] as const;

  it.each(cases)('maps a $name domain error to $status', async ({ name, error, status }) => {
    const { app } = await build();
    app.get('/t/throw', { schema: { hide: true } }, () => {
      throw error();
    });

    const response = await app.inject({ method: 'GET', url: '/t/throw' });

    expect(response.statusCode).toBe(status);
    expect(errorBody(response.body).error.code).toBe(name);
  });

  const SECRET = 'mysql://openbooks_app:pa55word@10.0.0.5:3306/openbooks';

  it.each([
    { kind: 'an unrecognised error', build: () => new Error(`connect ECONNREFUSED ${SECRET}`) },
    { kind: 'an InternalError', build: () => new InternalError(`pool exhausted for ${SECRET}`) },
    { kind: 'a non-Error throw', build: () => SECRET as unknown as Error },
  ])('turns $kind into an opaque internal_error', async ({ build: makeError }) => {
    const { app, logs } = await build();
    app.get('/t/boom', { schema: { hide: true } }, () => {
      throw makeError();
    });

    const response = await app.inject({ method: 'GET', url: '/t/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal_error', message: 'An internal error occurred.' },
    });
    // The operator message must exist — in the log, and only there.
    expect(response.body).not.toContain('pa55word');
    expect(response.body).not.toContain('10.0.0.5');
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(logs.text()).toContain(SECRET);
  });

  it('does not leak the reason a response failed its own output schema', async () => {
    const { app, logs } = await build();
    app.get(
      '/t/bad-output',
      {
        schema: {
          hide: true,
          response: { 200: z.object({ total: z.string() }) },
        },
      },
      // A number where the schema promises a minor-unit string — the mistake the
      // money-on-the-wire rule exists to catch.
      () => ({ total: 1999 }) as unknown as { total: string },
    );

    const response = await app.inject({ method: 'GET', url: '/t/bad-output' });

    expect(response.statusCode).toBe(500);
    expect(errorBody(response.body).error).toEqual({
      code: 'internal_error',
      message: 'An internal error occurred.',
    });
    // The reason exists — for the operator, in the log, and nowhere else. The body
    // carries no `details`, because `toWireError` forwards `details` even for a 500.
    expect(response.body).not.toContain('expected string');
    expect(logs.text()).toContain('declared output schema');
    expect(logs.text()).toContain('expected string, received number');
  });

  it('logs 5xx at error and 4xx at warn', async () => {
    const { app, logs } = await build();
    app.get('/t/boom', { schema: { hide: true } }, () => {
      throw new Error('boom');
    });
    app.get('/t/denied', { schema: { hide: true } }, () => {
      throw new PermissionDeniedError('journals.post');
    });

    await app.inject({ method: 'GET', url: '/t/boom' });
    await app.inject({ method: 'GET', url: '/t/denied' });

    const levels = logs
      .records()
      .filter(
        (record) => record['msg'] === 'request failed' || record['msg'] === 'request rejected',
      )
      .map((record) => ({ msg: record['msg'], level: record['level'] }));

    expect(levels).toEqual([
      { msg: 'request failed', level: 50 },
      { msg: 'request rejected', level: 40 },
    ]);
  });
});

/**
 * A7: a cross-org read must be byte-for-byte indistinguishable from a genuine
 * miss. `src/errors/` makes that true by construction — one error class, one
 * validated resource token, no id echo — and the assertions here are that the
 * transport adds nothing that could distinguish them.
 */
describe('A7 — not-found responses disclose nothing', () => {
  it('produces identical bytes for a genuine miss and a cross-org miss', async () => {
    const { app } = await build();
    app.get('/t/genuine', { schema: { hide: true } }, () => assertFound(null, 'invoice'));
    app.get('/t/cross-org', { schema: { hide: true } }, () => {
      assertOrgMatch(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'invoice',
      );
      return { ok: true };
    });

    const genuine = await app.inject({ method: 'GET', url: '/t/genuine' });
    const crossOrg = await app.inject({ method: 'GET', url: '/t/cross-org' });

    expect(genuine.statusCode).toBe(404);
    expect(crossOrg.statusCode).toBe(genuine.statusCode);
    expect(crossOrg.body).toBe(genuine.body);
    expect(crossOrg.headers['content-type']).toBe(genuine.headers['content-type']);
  });

  it('carries no object identifier', async () => {
    const { app } = await build();
    const id = 'fefefefe-fefe-4fef-8fef-fefefefefefe';
    app.get('/t/invoice/:id', { schema: { hide: true } }, () => assertFound(null, 'invoice'));

    const response = await app.inject({ method: 'GET', url: `/t/invoice/${id}` });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(id);
    // Only the resource *kind*, which is a validated identifier token and the same
    // for every miss of that kind.
    expect(errorBody(response.body)).toEqual({
      error: { code: 'not_found', message: 'No such invoice.', details: { resource: 'invoice' } },
    });
  });

  it('answers an unrouted path with the one envelope and does not echo the path', async () => {
    const { app } = await build();

    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(errorBody(response.body).error.code).toBe('not_found');
    expect(response.body).not.toContain('does-not-exist');
  });
});

describe('request validation', () => {
  it('maps Zod issues onto validation_failed with dotted paths', async () => {
    const { app } = await build();
    app.post(
      '/t/journals',
      {
        schema: {
          hide: true,
          body: z.object({
            lines: z.array(z.object({ amount: z.string() })).min(2),
          }),
        },
      },
      () => ({ ok: true }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/t/journals',
      payload: { lines: [{ amount: 1999 }] },
    });

    expect(response.statusCode).toBe(400);
    const body = errorBody(response.body);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.['issues']).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'lines.0.amount' })]),
    );
  });

  it('turns an unreadable body into validation_failed rather than a 500', async () => {
    const { app } = await build();
    app.post('/t/echo', { schema: { hide: true } }, () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"not json',
    });

    expect(response.statusCode).toBe(400);
    expect(errorBody(response.body).error.code).toBe('validation_failed');
  });
});

describe('idempotency seam', () => {
  function writeRoute(app: App): void {
    app.post(
      '/t/post-journal',
      { schema: { hide: true }, onRequest: requireIdempotencyKey },
      () => ({ idempotencyKey: getContext().idempotencyKey }),
    );
  }

  it('refuses a declared write without an Idempotency-Key', async () => {
    const { app } = await build();
    writeRoute(app);

    const response = await app.inject({ method: 'POST', url: '/t/post-journal', payload: {} });

    expect(response.statusCode).toBe(400);
    const body = errorBody(response.body);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.['issues']).toEqual([
      { path: IDEMPOTENCY_KEY_HEADER, message: 'must be set' },
    ]);
  });

  it('places the key on the context, not in the handler arguments', async () => {
    const { app } = await build();
    writeRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/t/post-journal',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ idempotencyKey: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });
  });

  /**
   * Refused at the edge and on any method, not only on a write route: the value
   * reaches the request context and therefore the log lines for the request before
   * a handler runs. Dropping it instead would leave a request the client believes is
   * idempotent unguarded.
   */
  it.each([
    { kind: 'blank', value: '   ' },
    { kind: 'longer than the column', value: 'k'.repeat(256) },
  ])('rejects a $kind key instead of silently dropping it', async ({ value }) => {
    const { app } = await build();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [IDEMPOTENCY_KEY_HEADER]: value },
    });

    expect(response.statusCode).toBe(400);
    expect(errorBody(response.body).error.code).toBe('validation_failed');
  });

  /**
   * The earliest rejection there is — it happens in the same hook that opens the
   * context scope. It must still be traceable, or it is the one outcome an operator
   * cannot correlate with a client's report of it.
   */
  it('keeps the earliest possible rejection correlatable', async () => {
    const { app, logs } = await build();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'edge-1', [IDEMPOTENCY_KEY_HEADER]: '  ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers[REQUEST_ID_RESPONSE_HEADER]).toBe('edge-1');

    const rejected = logs.records().find((record) => record['msg'] === 'request rejected');
    expect(rejected).toMatchObject({ requestId: 'edge-1', statusCode: 400 });
  });

  /**
   * The bound is the *only* opinion transport holds about the value.
   * `src/modules/idempotency/service.ts` is the authority on validity, and a
   * charset rule invented here would reject keys it accepts.
   */
  it('accepts any non-blank bounded key, including ones a UUID rule would reject', async () => {
    const { app } = await build();
    writeRoute(app);

    const response = await app.inject({
      method: 'POST',
      url: '/t/post-journal',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'order/1234 attempt#2' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ idempotencyKey: 'order/1234 attempt#2' });
  });
});

/**
 * A13 — provenance is a property of the logger, not of the call site. Nothing in
 * `src/transport/` passes `orgId` or `requestId` to a log call; both lines below
 * have them because pino's mixin reads the context.
 */
describe('request logging', () => {
  it('attaches provenance to request lines without the transport doing it', async () => {
    const resolveIdentity: IdentityResolver = () =>
      Promise.resolve({
        orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        roleId: '00000000-0000-4000-8000-000000000001',
        actorType: 'user',
        actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      });

    const { app, logs } = await build({ resolveIdentity });

    await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'log-1' } });

    const completed = logs.records().find((record) => record['msg'] === 'request completed');
    expect(completed).toMatchObject({
      requestId: 'log-1',
      orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleId: '00000000-0000-4000-8000-000000000001',
      actorType: 'user',
      role: 'api',
      statusCode: 200,
      url: '/health',
    });
  });

  it('redacts a secret-named header the request carried', async () => {
    const { app, logs } = await build();
    app.get('/t/context', { schema: { hide: true } }, () => {
      // Log an object the way a service would; the walk in src/logging/serialize.ts
      // is what has to catch this, not the call site.
      logs.logger.info({ authorization: 'Bearer super-secret-token' }, 'handled');
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/t/context' });

    expect(logs.text()).not.toContain('super-secret-token');
  });
});
