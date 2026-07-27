import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IDENTITY_QUERY_KEY } from '../auth/identity';
import type { CallerIdentity } from '../auth/identity';
import { createQueryClient } from '../query/client';
import { AuthScreen } from './auth';

/**
 * Registration, and specifically what a double-submitted form does.
 *
 * `POST /v1/auth/register` is guarded by an org-less idempotency claim (OB-028), and the key
 * is minted once per intent — so the second submission *replays* rather than creating a
 * second account. A replay returns the identity with **no `Set-Cookie`**: the session token
 * exists only while the guarded operation runs and is deliberately never stored (D-03, and
 * the note at the head of `packages/server/src/transport/routes/auth.ts`).
 *
 * Usually the browser still holds the cookie the first attempt set and nothing is wrong. The
 * case worth a test is the other one — the original response was lost outright, so the
 * account exists and this browser has no session. Answering the 201 by assuming a session
 * would leave the user staring at an application that 401s on its first call; the screen
 * instead asks who it is, and falls back to the login the route names as the way forward,
 * under a *different* key because it is a different logical request.
 */
vi.mock('../env', () => ({ API_BASE_URL: 'http://localhost' }));

const fetchMock = vi.hoisted(() => {
  // `openapi-fetch` binds `globalThis.fetch` when the client singleton is built at import
  // time, so the stub has to be in place before the imports run.
  const mock = vi.fn<typeof fetch>();
  globalThis.fetch = mock;
  return mock;
});

const IDENTITY: CallerIdentity = {
  user: { id: 'u-1', email: 'ian@example.test', displayName: 'Ian' },
  activeOrgId: '00000000-0000-4000-8000-0000000000a1',
  permissions: ['accounts.read'],
  memberships: [],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
}

function record(): Call[] {
  const calls: Call[] = [];
  fetchMock.mockImplementation((input) => {
    if (!(input instanceof Request)) throw new Error('the generated client sends a Request');
    const path = new URL(input.url).pathname;
    calls.push({
      method: input.method,
      path,
      idempotencyKey: input.headers.get('idempotency-key'),
    });

    if (path === '/v1/auth/register') return Promise.resolve(json(201, IDENTITY));
    if (path === '/v1/auth/login') return Promise.resolve(json(200, IDENTITY));
    if (path === '/v1/auth/me') {
      // No cookie was set, because this registration was a replay.
      const signedIn = calls.some((call) => call.path === '/v1/auth/login');
      return Promise.resolve(
        signedIn
          ? json(200, IDENTITY)
          : json(401, { error: { code: 'unauthenticated', message: 'Sign in to continue.' } }),
      );
    }
    throw new Error(`unexpected ${input.method} ${path}`);
  });
  return calls;
}

async function submitRegistration(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Create an account instead' }));
  await user.type(screen.getByLabelText('Your name'), 'Ian');
  await user.type(screen.getByLabelText('Email'), 'ian@example.test');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
  await user.type(screen.getByLabelText('Organization name'), 'Northwind Books');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('the auth screen', () => {
  it('recovers the session when a replayed registration issued no cookie', async () => {
    const calls = record();
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <AuthScreen />
      </QueryClientProvider>,
    );
    await submitRegistration();

    // The identity is published, so the guard sees a session rather than a signed-out user
    // holding an account they cannot reach.
    await waitFor(() => {
      expect(queryClient.getQueryData(IDENTITY_QUERY_KEY)).toEqual(IDENTITY);
    });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/auth/register',
      'GET /v1/auth/me',
      'POST /v1/auth/login',
      'GET /v1/auth/me',
    ]);

    // Two writes, two keys: the fallback login is a different logical request and must not
    // claim the registration's key.
    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.idempotencyKey);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('does not sign in a second time when the cookie survived', async () => {
    fetchMock.mockImplementation((input) => {
      if (!(input instanceof Request)) throw new Error('the generated client sends a Request');
      const path = new URL(input.url).pathname;
      if (path === '/v1/auth/register') return Promise.resolve(json(201, IDENTITY));
      if (path === '/v1/auth/me') return Promise.resolve(json(200, IDENTITY));
      throw new Error(`unexpected ${input.method} ${path}`);
    });
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <AuthScreen />
      </QueryClientProvider>,
    );
    await submitRegistration();

    await waitFor(() => {
      expect(queryClient.getQueryData(IDENTITY_QUERY_KEY)).toEqual(IDENTITY);
    });
  });
});
