import { describe, expect, it } from 'vitest';

import { uuidToBuffer } from '../../src/db';
import {
  IdempotencyKeyConflictError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/errors';
import type { IssuedSession } from '../../src/modules/auth';
import { login, logout, register, resolveSessionIdentity } from '../../src/modules/auth';
import { withGlobalIdempotency } from '../../src/modules/idempotency';
import { createOrg } from '../../src/modules/orgs';
import { switchActiveOrg } from '../../src/modules/auth';
import {
  cookieJar,
  runAsIdentityWithKey,
  runUnauthenticated,
  runUnauthenticatedWithKey,
  useServiceDatabase,
  VALID_PASSWORD,
} from './support';

/**
 * The five identity and org-lifecycle writes, actually honouring their
 * `Idempotency-Key` (OB-028; M1 known gap 1; M2 criterion B8).
 *
 * These run the real services through `withGlobalIdempotency` — the same composition
 * `src/transport/routes/auth.ts` and `routes/orgs.ts` perform — because the thing that
 * broke before this ticket was not the claim protocol but the *composition*: `register`
 * and `createOrg` each open a system transaction, and the claim's transaction is already
 * open around them. A test that called `runGlobalIdempotent` with a hand-written
 * operation would pass against a version where `register` throws
 * "calling the transaction method for a Transaction is not supported".
 *
 * The serialization itself — two connections, one parked mid-flight, the other proven
 * not to settle — is `test/idempotency/global-concurrency.test.ts`. It cannot be made
 * here: `withGlobalIdempotency` resolves its handle from `systemDb()`, which is the
 * process pool, and a race that both callers might serve from one physical connection
 * proves nothing about locking. What is asserted here is the composition and the row
 * counts, which is the half that suite cannot make.
 */
const db = useServiceDatabase();

let sequence = 0;

function registration(index: number) {
  return {
    email: `idem-${index}@openbooks.test`,
    password: VALID_PASSWORD,
    displayName: `Idempotent ${index}`,
    org: { name: `Idempotent Books ${index}` },
  };
}

/** A user with a session, created outside any claim so it is not itself under test. */
async function registerUser(): Promise<IssuedSession> {
  sequence += 1;
  return runUnauthenticated(() => register(registration(sequence)));
}

async function scopeFor(token: string) {
  const identity = await resolveSessionIdentity(cookieJar(token));
  expect(identity).not.toBeNull();
  return identity!;
}

async function userCount(email: string): Promise<number> {
  const rows = await db.app.selectFrom('users').select('id').where('email', '=', email).execute();
  return rows.length;
}

async function orgCount(name: string): Promise<number> {
  const rows = await db.app.selectFrom('orgs').select('id').where('name', '=', name).execute();
  return rows.length;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db.app
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', uuidToBuffer(userId))
    .execute();
  return rows.length;
}

describe('register honours its Idempotency-Key', () => {
  it('creates one user and one org however many times the request is retried', async () => {
    sequence += 1;
    const input = registration(sequence);
    const spec = { endpoint: 'register', request: input, successStatus: 201 };

    const first = await runUnauthenticatedWithKey('register-retry', () =>
      withGlobalIdempotency(spec, () => register(input)),
    );
    const second = await runUnauthenticatedWithKey('register-retry', () =>
      withGlobalIdempotency(spec, () => register(input)),
    );

    expect(first.outcome).toBe('executed');
    // Before OB-028 the second call reached the service and answered `conflict`,
    // because the email was already taken by the caller's own first attempt.
    expect(second.outcome).toBe('replayed');
    expect(second.body).toEqual(first.body);
    expect(second.status).toBe(201);

    expect(await userCount(input.email)).toBe(1);
    expect(await orgCount(input.org.name)).toBe(1);
  });

  it('creates one user when two identical registrations are in flight at once', async () => {
    sequence += 1;
    const input = registration(sequence);
    const spec = { endpoint: 'register', request: input, successStatus: 201 };
    const attempt = () =>
      runUnauthenticatedWithKey('register-concurrent', () =>
        withGlobalIdempotency(spec, () => register(input)),
      );

    const outcomes = (await Promise.all([attempt(), attempt()])).map((r) => r.outcome).sort();

    expect(outcomes).toEqual(['executed', 'replayed']);
    expect(await userCount(input.email)).toBe(1);
    expect(await orgCount(input.org.name)).toBe(1);
  });

  it('409s the same key sent with a different registration', async () => {
    sequence += 1;
    const input = registration(sequence);
    const other = registration(sequence + 100);

    await runUnauthenticatedWithKey('register-conflict', () =>
      withGlobalIdempotency({ endpoint: 'register', request: input, successStatus: 201 }, () =>
        register(input),
      ),
    );

    await expect(
      runUnauthenticatedWithKey('register-conflict', () =>
        withGlobalIdempotency({ endpoint: 'register', request: other, successStatus: 201 }, () =>
          register(other),
        ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    // The refused request wrote nothing — the claim is checked before the operation.
    expect(await userCount(other.email)).toBe(0);
  });

  it('refuses a registration that carries no key at all', async () => {
    sequence += 1;
    const input = registration(sequence);

    await expect(
      runUnauthenticated(() =>
        withGlobalIdempotency({ endpoint: 'register', request: input, successStatus: 201 }, () =>
          register(input),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await userCount(input.email)).toBe(0);
  });
});

describe('login honours its Idempotency-Key', () => {
  it('mints one session for a retried login', async () => {
    const issued = await registerUser();
    const credentials = { email: issued.identity.user.email, password: VALID_PASSWORD };
    const spec = { endpoint: 'login', request: credentials, successStatus: 200 };
    const before = await sessionCount(issued.identity.user.id);

    const first = await runUnauthenticatedWithKey('login-retry', () =>
      withGlobalIdempotency(spec, () => login(credentials)),
    );
    const second = await runUnauthenticatedWithKey('login-retry', () =>
      withGlobalIdempotency(spec, () => login(credentials)),
    );

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('replayed');
    expect(second.body).toEqual(first.body);
    // The whole point for this endpoint: a retried login does not accumulate sessions.
    expect(await sessionCount(issued.identity.user.id)).toBe(before + 1);
  });
});

describe('logout honours its Idempotency-Key', () => {
  it('replays as a body-less 204 without touching the session again', async () => {
    const issued = await registerUser();
    const identity = await scopeFor(issued.sessionToken);
    const spec = { endpoint: 'logout', request: {}, successStatus: 204 };
    const call = () =>
      runAsIdentityWithKey(identity, 'logout-retry', () =>
        withGlobalIdempotency(spec, async () => {
          await logout(issued.sessionToken);
          return null;
        }),
      );

    const first = await call();
    const second = await call();

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('replayed');
    expect(second.status).toBe(204);
    expect(second.body).toBeNull();
    // And the session is revoked, which is the only observable the operation has —
    // a revoked cookie is a presented-and-invalid credential, so the resolver throws
    // rather than answering "no identity".
    await expect(resolveSessionIdentity(cookieJar(issued.sessionToken))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe('createOrg honours its Idempotency-Key', () => {
  it('yields exactly one org for a double-submitted form (B8)', async () => {
    const issued = await registerUser();
    const identity = await scopeFor(issued.sessionToken);
    const input = { name: 'Second Books' };
    const spec = { endpoint: 'createOrg', request: input, successStatus: 201 };

    const first = await runAsIdentityWithKey(identity, 'create-org-retry', () =>
      withGlobalIdempotency(spec, () => createOrg(input)),
    );
    const second = await runAsIdentityWithKey(identity, 'create-org-retry', () =>
      withGlobalIdempotency(spec, () => createOrg(input)),
    );

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('replayed');
    expect(second.body).toEqual(first.body);
    // Not two orgs with disambiguated slugs, which is what the gap produced: the
    // slug collision is resolved silently, so nothing told the user either.
    expect(await orgCount('Second Books')).toBe(1);
  });

  it('claims in the org-less namespace, not against the caller’s current org', async () => {
    // The claim cannot belong to the org the caller happens to be scoped to — that org
    // is not what the request is about, and for a user with no memberships there would
    // be no org at all. `org_id IS NULL` is what says the claim landed correctly.
    const issued = await registerUser();
    const identity = await scopeFor(issued.sessionToken);
    const input = { name: 'Namespace Books' };

    await runAsIdentityWithKey(identity, 'create-org-namespace', () =>
      withGlobalIdempotency({ endpoint: 'createOrg', request: input, successStatus: 201 }, () =>
        createOrg(input),
      ),
    );

    const claims = await db.app
      .selectFrom('idempotency_keys')
      .select(['org_id', 'endpoint'])
      .where('idempotency_key', '=', 'create-org-namespace')
      .execute();

    expect(claims).toHaveLength(1);
    expect(claims[0]?.org_id).toBeNull();
    expect(claims[0]?.endpoint).toBe('createOrg');
  });
});

describe('switchActiveOrg honours its Idempotency-Key', () => {
  it('replays the membership it resolved the first time', async () => {
    const issued = await registerUser();
    const identity = await scopeFor(issued.sessionToken);
    const created = await runAsIdentityWithKey(identity, 'switch-setup', () =>
      withGlobalIdempotency(
        { endpoint: 'createOrg', request: { name: 'Switch Target' }, successStatus: 201 },
        () => createOrg({ name: 'Switch Target' }),
      ),
    );
    const targetOrgId = (created.body as { readonly org: { readonly id: string } }).org.id;
    const input = { orgId: targetOrgId };
    const spec = { endpoint: 'switchActiveOrg', request: input, successStatus: 200 };

    const first = await runAsIdentityWithKey(identity, 'switch-retry', () =>
      withGlobalIdempotency(spec, () => switchActiveOrg(issued.sessionToken, input.orgId)),
    );
    const second = await runAsIdentityWithKey(identity, 'switch-retry', () =>
      withGlobalIdempotency(spec, () => switchActiveOrg(issued.sessionToken, input.orgId)),
    );

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('replayed');
    expect(second.body).toEqual(first.body);

    // The switch itself committed, and the replay did not undo or repeat it.
    const scope = await scopeFor(issued.sessionToken);
    expect(scope.orgId).toBe(targetOrgId);
  });

  it('409s the same key aimed at a different org', async () => {
    // The failure this prevents is the interesting one: without the fingerprint, a
    // client reusing a key would be told it had switched to an org it never asked for.
    const issued = await registerUser();
    const identity = await scopeFor(issued.sessionToken);
    const home = issued.identity.memberships[0]?.org.id ?? '';
    const elsewhere = await db.factories.org({ name: 'Elsewhere Books' });
    await db.factories.orgMember({
      orgId: elsewhere.id,
      userId: uuidToBuffer(issued.identity.user.id),
      role: 'readOnly',
    });

    await runAsIdentityWithKey(identity, 'switch-conflict', () =>
      withGlobalIdempotency(
        { endpoint: 'switchActiveOrg', request: { orgId: elsewhere.uuid }, successStatus: 200 },
        () => switchActiveOrg(issued.sessionToken, elsewhere.uuid),
      ),
    );

    await expect(
      runAsIdentityWithKey(identity, 'switch-conflict', () =>
        withGlobalIdempotency(
          { endpoint: 'switchActiveOrg', request: { orgId: home }, successStatus: 200 },
          () => switchActiveOrg(issued.sessionToken, home),
        ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    const scope = await scopeFor(issued.sessionToken);
    expect(scope.orgId).toBe(elsewhere.uuid);
  });
});
