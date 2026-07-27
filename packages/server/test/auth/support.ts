import { afterAll, beforeAll } from 'vitest';

import type { RequestContext } from '../../src/context';
import { createRequestContext, runInContext, UNAUTHENTICATED_ID } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { CookieCarrier, ResolvedIdentity, SessionCookieConfig } from '../../src/modules/auth';
import { SESSION_COOKIE_NAME } from '../../src/modules/auth';
import { useTestDatabase, type TestDatabase } from '../db';

/**
 * Scaffolding for the OB-015 suites.
 *
 * These exercise the real services, so the *process* database handle has to be
 * initialized as well as the harness's own pools: everything in `src/modules/auth/`
 * reaches data through `systemDb()`, which reads the module-private client. Pointing that
 * client at the harness container is what makes these tests statements about the
 * production path rather than about a second query written for the test.
 *
 * As the app user, never the migrator (spec §12). If a session or membership read ever
 * needed a privilege `openbooks_app` lacks, that is a finding and it should surface here.
 */
export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  // Registered after the harness's own `beforeAll`, so `appConnectionConfig` is live.
  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

/** The cookie config a self-host deployment gets by default: `Secure`, no `Domain`. */
export const TEST_SESSION_CONFIG: SessionCookieConfig = { cookieSecure: true };

/** A request carrying one session cookie. */
export function cookieJar(token: string): CookieCarrier {
  return { cookies: { [SESSION_COOKIE_NAME]: token } };
}

export const NO_COOKIES: CookieCarrier = { cookies: {} };

/**
 * The context the transport layer would have built from `identity`.
 *
 * Takes the resolver's own output rather than loose ids, so a test that calls a service
 * has gone through the same resolve-then-scope path a request does. A hand-built context
 * would let a test assert against a scope the production path cannot produce.
 */
export function contextFor(identity: ResolvedIdentity): RequestContext {
  return createRequestContext({
    orgId: identity.orgId,
    roleId: identity.roleId,
    userId: identity.userId,
    actorType: identity.actorType,
    actorId: identity.actorId,
  });
}

/** Runs `fn` in that context. */
export function runAsIdentity<T>(identity: ResolvedIdentity, fn: () => Promise<T>): Promise<T> {
  return runInContext(contextFor(identity), fn);
}

/**
 * The same, carrying an `Idempotency-Key`.
 *
 * Separate rather than an optional argument on `runAsIdentity`, so a suite that is not
 * about idempotency cannot accidentally establish a claim — `withGlobalIdempotency`
 * reads the key from context and a stray one would guard a write silently.
 */
export function runAsIdentityWithKey<T>(
  identity: ResolvedIdentity,
  idempotencyKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runInContext(
    createRequestContext({
      orgId: identity.orgId,
      roleId: identity.roleId,
      userId: identity.userId,
      actorType: identity.actorType,
      actorId: identity.actorId,
      idempotencyKey,
    }),
    fn,
  );
}

/** The pre-auth scope: what a request with no credentials runs in. */
export function runUnauthenticated<T>(fn: () => Promise<T>): Promise<T> {
  return runInContext(preAuthContext(null), fn);
}

/** The pre-auth scope a register or login request arrives in, with its key. */
export function runUnauthenticatedWithKey<T>(
  idempotencyKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runInContext(preAuthContext(idempotencyKey), fn);
}

function preAuthContext(idempotencyKey: string | null): RequestContext {
  return createRequestContext({
    orgId: UNAUTHENTICATED_ID,
    roleId: UNAUTHENTICATED_ID,
    userId: null,
    actorType: 'user',
    actorId: UNAUTHENTICATED_ID,
    idempotencyKey,
  });
}

/** A password that satisfies the registration policy. */
export const VALID_PASSWORD = 'correct horse battery staple';
