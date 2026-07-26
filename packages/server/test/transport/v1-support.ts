import { afterAll, beforeAll } from 'vitest';

import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db/index';
import { resolveSessionIdentity, SESSION_COOKIE_NAME } from '../../src/modules/auth/index';
import { IDEMPOTENCY_KEY_HEADER } from '../../src/transport/index';
import type { App } from '../../src/transport/index';
import type { TestDatabase } from '../db';
import { useTestDatabase } from '../db';
import { buildTestApp } from './harness';
import type { LogCapture } from './harness';

/**
 * Scaffolding for the `/v1` suites.
 *
 * Unlike `./harness.ts`, these tests hit the database, because the point of them is
 * the whole path: hook chain, validation, service, MySQL, serialization. So the
 * *process* database handle is initialized as well as the harness's own pools —
 * everything in `src/modules/` reaches data through the module-private client, and
 * pointing that at the harness container is what makes these tests statements about
 * production rather than about a second query written for the test.
 *
 * As the app user, never the migrator (spec §12). If a route ever needed a privilege
 * `openbooks_app` lacks, that is a finding and it should surface here.
 *
 * The app is built once per file rather than per test. It holds no state — every
 * request opens its own context scope — and `useTestDatabase`'s `beforeEach` truncates
 * between tests, so a shared instance cannot leak anything a fresh one would not.
 * Building per test would also pay for `@fastify/swagger-ui` registration each time.
 */

export interface V1Harness {
  readonly db: TestDatabase;
  /** Live from the first `beforeAll`. */
  app(): App;
  logs(): LogCapture;
}

export function useV1App(): V1Harness {
  const db = useTestDatabase();
  let app: App | undefined;
  let logs: LogCapture | undefined;

  // Registered after the harness's own `beforeAll`, so `appConnectionConfig` is live.
  beforeAll(async () => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
    /**
     * The real resolver, which is the only way these tests exercise authentication at
     * all: `buildApp` treats `resolveIdentity` as optional and an app built without one
     * leaves every request in the pre-auth scope. `src/entrypoints/api.ts` passes the
     * same function, and this assignment is the same structural check the entrypoint
     * makes — `resolveSessionIdentity` cannot name `IdentityResolver` (the boundary
     * rules forbid `src/modules/` → `src/transport/`).
     */
    const built = await buildTestApp({ resolveIdentity: resolveSessionIdentity });
    app = built.app;
    logs = built.logs;
  });

  afterAll(async () => {
    await app?.close();
    app = undefined;
    await destroyDatabase();
  });

  return {
    db,
    app: () => {
      if (app === undefined) throw new Error('useV1App() builds in beforeAll.');
      return app;
    },
    logs: () => {
      if (logs === undefined) throw new Error('useV1App() builds in beforeAll.');
      return logs;
    },
  };
}

/** A password that satisfies the registration policy. */
export const VALID_PASSWORD = 'correct horse battery staple';

export interface Session {
  /** The `Cookie` header value to send on subsequent requests. */
  readonly cookie: string;
  readonly userId: string;
  readonly orgId: string;
}

/**
 * Registers a user with their first org and returns the session the response set.
 *
 * The token is read out of `Set-Cookie` and never out of the body, because it is not
 * in the body — see the commentary in `src/transport/routes/auth.ts`. A test that
 * could read it from the payload would be asserting against a shape production does
 * not have.
 */
export async function registerUser(
  app: App,
  options: { readonly email: string; readonly orgName: string },
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: idempotent(`register-${options.email}`),
    payload: {
      email: options.email,
      password: VALID_PASSWORD,
      displayName: 'Test Person',
      org: { name: options.orgName },
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${String(response.statusCode)} ${response.body}`);
  }

  const token = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value;
  if (token === undefined || token === '') throw new Error('register set no session cookie');

  const body = response.json<{
    user: { id: string };
    activeOrgId: string | null;
  }>();
  if (body.activeOrgId === null) throw new Error('register left the session with no active org');

  return {
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    userId: body.user.id,
    orgId: body.activeOrgId,
  };
}

/** Headers for an authenticated write: the session and one idempotency key. */
export function authorizedWrite(session: Session, key: string): Record<string, string> {
  return { cookie: session.cookie, ...idempotent(key) };
}

export function idempotent(key: string): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: key };
}

/** Creates one account and returns its id. */
export async function createAccount(
  app: App,
  session: Session,
  account: {
    readonly code: string;
    readonly name: string;
    readonly type: string;
    readonly normalBalance: string;
  },
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/accounts',
    headers: authorizedWrite(session, `account-${session.orgId}-${account.code}`),
    payload: account,
  });

  if (response.statusCode !== 201) {
    throw new Error(`createAccount failed: ${String(response.statusCode)} ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}
