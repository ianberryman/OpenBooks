import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, presentApiError, unwrap } from '../api';
import type { components } from '../api';
import { FISCAL_YEAR_OPTIONS } from '../auth/create-org';
import { adoptSession } from '../auth/identity';
import type { CallerIdentity } from '../auth/identity';
import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';

/**
 * Register and sign in (spec §5).
 *
 * The session is an `HttpOnly` cookie (D-03). Nothing here reads, stores, or attaches a
 * token — it could not: the register and login responses deliberately omit it, and the
 * cookie is invisible to script. What the screen does on success is re-read
 * `GET /v1/auth/me`; the guard in `src/App.tsx` decides everything else from that answer.
 */
type LoginRequest = components['schemas']['LoginRequest'];
type RegisterRequest = components['schemas']['RegisterRequest'];

type Mode = 'sign-in' | 'register';

interface SignInVariables {
  readonly idempotencyKey: string;
  readonly credentials: LoginRequest;
}

/**
 * Two keys, both minted when the user commits.
 *
 * The second is for the replay case the route documents. A register that is submitted twice
 * claims the same key, so the second attempt returns the identity **with no `Set-Cookie`** —
 * the token exists only while the operation runs and is deliberately never stored (D-03, and
 * the note at the head of `packages/server/src/transport/routes/auth.ts`). Usually the
 * browser still holds the cookie the first attempt set. When it does not — the original
 * response was lost outright — the user has an account and no session, and the route's stated
 * way forward is to log in, which is a different logical request and therefore a different
 * key. Minting it here rather than inside the mutation keeps the rule the header exists for:
 * one key per intent, not one per attempt.
 */
interface RegisterVariables {
  readonly registerKey: string;
  readonly signInKey: string;
  readonly body: RegisterRequest;
}

async function signInWith(
  queryClient: QueryClient,
  credentials: LoginRequest,
  idempotencyKey: string,
): Promise<CallerIdentity | null> {
  unwrap(
    await api.POST('/v1/auth/login', {
      body: credentials,
      params: { header: idempotencyHeader(idempotencyKey) },
    }),
  );
  return adoptSession(queryClient);
}

export function AuthScreen(): ReactElement {
  const [mode, setMode] = useState<Mode>('sign-in');

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {mode === 'sign-in' ? 'Sign in' : 'Create an account'}
        </h1>
        <p className="text-text-muted">
          {mode === 'sign-in'
            ? 'Enter the address and password for your books.'
            : 'This creates your login and your first organization together.'}
        </p>
      </div>

      {mode === 'sign-in' ? <SignInForm /> : <RegisterForm />}

      <Button
        variant="ghost"
        onClick={() => {
          setMode(mode === 'sign-in' ? 'register' : 'sign-in');
        }}
      >
        {mode === 'sign-in' ? 'Create an account instead' : 'I already have an account'}
      </Button>
    </div>
  );
}

function SignInForm(): ReactElement {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: ({ idempotencyKey, credentials }: SignInVariables) =>
      signInWith(queryClient, credentials, idempotencyKey),
  });

  const presented = signIn.isError ? presentApiError(signIn.error) : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    signIn.mutate({ credentials: { email, password }, idempotencyKey: newIdempotencyKey() });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Field error={presented?.fieldErrors['email']}>
        <FieldLabel>Email</FieldLabel>
        <TextInput
          type="email"
          value={email}
          autoComplete="username"
          required
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </Field>

      <Field error={presented?.fieldErrors['password']}>
        <FieldLabel>Password</FieldLabel>
        <TextInput
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </Field>

      {presented !== null && <ErrorBanner error={signIn.error} />}

      <Button type="submit" variant="primary" disabled={signIn.isPending}>
        Sign in
      </Button>
    </form>
  );
}

function RegisterForm(): ReactElement {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState('1');

  const register = useMutation({
    mutationFn: async ({ registerKey, signInKey, body }: RegisterVariables) => {
      unwrap(
        await api.POST('/v1/auth/register', {
          body,
          params: { header: idempotencyHeader(registerKey) },
        }),
      );

      // A replay answers without a cookie, so what decides whether this browser holds a
      // session is asking, not the 201. See `RegisterVariables`.
      const identity = await adoptSession(queryClient);
      if (identity !== null) return identity;

      return signInWith(queryClient, { email: body.email, password: body.password }, signInKey);
    },
  });

  const presented = register.isError ? presentApiError(register.error) : null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    register.mutate({
      body: {
        displayName,
        email,
        password,
        // No `chartTemplateId`: the starter charts cannot be listed without an org scope,
        // and D-23's default is no chart. The accounts screen applies one afterwards.
        org: { name: orgName, fiscalYearStartMonth: Number(fiscalYearStartMonth) },
      },
      registerKey: newIdempotencyKey(),
      signInKey: newIdempotencyKey(),
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Field error={presented?.fieldErrors['displayName']}>
        <FieldLabel>Your name</FieldLabel>
        <TextInput
          value={displayName}
          autoComplete="name"
          required
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />
      </Field>

      <Field error={presented?.fieldErrors['email']}>
        <FieldLabel>Email</FieldLabel>
        <TextInput
          type="email"
          value={email}
          autoComplete="username"
          required
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </Field>

      <Field error={presented?.fieldErrors['password']}>
        <FieldLabel>Password</FieldLabel>
        <TextInput
          type="password"
          value={password}
          autoComplete="new-password"
          required
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </Field>

      <Field error={presented?.fieldErrors['org.name']}>
        <FieldLabel>Organization name</FieldLabel>
        <TextInput
          value={orgName}
          autoComplete="organization"
          required
          onChange={(event) => {
            setOrgName(event.target.value);
          }}
        />
      </Field>

      <Field error={presented?.fieldErrors['org.fiscalYearStartMonth']}>
        <FieldLabel>Fiscal year starts in</FieldLabel>
        <Select
          value={fiscalYearStartMonth}
          onValueChange={setFiscalYearStartMonth}
          options={FISCAL_YEAR_OPTIONS}
        />
      </Field>

      {presented !== null && <ErrorBanner error={register.error} />}

      <Button type="submit" variant="primary" disabled={register.isPending}>
        Create account
      </Button>
    </form>
  );
}
