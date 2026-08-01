import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll } from 'vitest';

import { loadConfig } from '../../src/config';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db/index';
import { createLogger } from '../../src/logging';
import { resolveSessionIdentity, SESSION_COOKIE_NAME } from '../../src/modules/auth/index';
import { setFieldEncryptionKey } from '../../src/crypto/field-encryption';
import { selectEmailProvider, setOutboundEmail, setStorageProvider } from '../../src/providers';
import { createLocalStorageProvider } from '../../src/providers/storage/local';
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
  let storageDir: string | undefined;

  // Registered after the harness's own `beforeAll`, so `appConnectionConfig` is live.
  beforeAll(async () => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
    // Invoice delivery (branding logo, `sendInvoice`) reaches `storageProvider()`, which
    // resolves from `getConfig()` — unset for storage in these suites. Install a local
    // adapter over a temp directory so a logo upload or a rendered PDF is written and read
    // back through the real provider, spec §11's "no mocks" applied to blob storage — the
    // same seam `test/branding` and `test/delivery` install for their own suites.
    storageDir = await mkdtemp(join(tmpdir(), 'openbooks-v1-storage-'));
    setStorageProvider(createLocalStorageProvider({ provider: 'local', basePath: storageDir }));

    // Field-level column encryption (OB-228, D-228-2): the vendor-TIN column derives its key
    // from `getConfig()` in production, but this harness builds config explicitly rather than
    // from `process.env`, so install the key through the settable seam — the same shape as the
    // storage/email seams above. Matches the email config's `SECRETS_ENCRYPTION_KEY`.
    setFieldEncryptionKey('k'.repeat(32));

    // `sendInvoice` (INV) is the first operation on this surface to email anything, and
    // `outboundEmail()` otherwise resolves through `getConfig()` — unset here — and throws.
    // Install a real `log` provider over a discarded stream, the same seam `test/members`
    // uses for the invite mail: a genuine send (spec §11, no mocks), just not captured,
    // because these suites assert the delivery record rather than the message.
    const emailConfig = loadConfig({
      OPENBOOKS_ROLE: 'api',
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_HOST: 'unused',
      DATABASE_USER: 'unused',
      DATABASE_PASSWORD: 'unused',
      DATABASE_NAME: 'unused',
      SESSION_SECRET: 's'.repeat(40),
      STORAGE_LOCAL_PATH: storageDir,
      EMAIL_FROM_ADDRESS: 'billing@openbooks.test',
      APP_BASE_URL: 'https://app.openbooks.test',
      // The self-host default SECRETS_PROVIDER is `local` (initiative J, D-101).
      SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
    });
    const emailLogger = createLogger(emailConfig, { write() {} });
    setOutboundEmail({
      provider: selectEmailProvider(emailConfig, emailLogger),
      logger: emailLogger,
      ...(emailConfig.appBaseUrl === undefined ? {} : { appBaseUrl: emailConfig.appBaseUrl }),
    });
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
    setStorageProvider(undefined);
    setOutboundEmail(undefined);
    setFieldEncryptionKey(undefined);
    if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
    storageDir = undefined;
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
