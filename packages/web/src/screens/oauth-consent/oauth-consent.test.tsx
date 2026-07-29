import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The OAuth consent screen (OB-105; OB-053, OB-098, OB-104 — ROADMAP D-53, D-54, D-61).
 *
 * Three things are worth a test: the RFC `snake_case` query is mapped onto
 * `getOAuthAuthorizationDetails`'s `camelCase` one exactly (`oauth-consent.tsx`'s
 * `toDetailsQuery`), the details render as "‹clientName› is requesting access to:
 * ‹scopes›", and Approve/Deny each build a native `<form method="POST"
 * action="/oauth/consent">` carrying the authorize request's own parameters plus the right
 * `approve` value — not a call through this package's typed API client, which the module
 * header explains cannot follow the cross-origin redirect `POST /oauth/consent` answers
 * with.
 */
const { OAuthConsentScreen } = await import('../oauth-consent');

const AUTHORIZE_QUERY =
  '?response_type=code&client_id=client_ab12&redirect_uri=https%3A%2F%2Facme.example.com%2Fcb' +
  '&scope=invoices.read+contacts.read&state=xyz789&code_challenge=abc123' +
  '&code_challenge_method=S256';

function detailsRoute(body: unknown, status = 200): StubRoute {
  return {
    method: 'GET',
    path: '/v1/oauth/authorization-details',
    reply: () => ({ status, body }),
  };
}

function formOf(button: HTMLElement): HTMLFormElement {
  const form = button.closest('form');
  if (form === null) throw new Error('Expected the button to be inside a <form>.');
  return form;
}

function hiddenFieldsOf(form: HTMLFormElement): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const input of form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')) {
    fields[input.name] = input.value;
  }
  return fields;
}

function renderAt(search: string): void {
  renderWithQueryClient(
    <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
      <Routes>
        <Route path="/oauth/consent" element={<OAuthConsentScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OAuthConsentScreen', () => {
  it('maps the RFC snake_case query onto the typed camelCase one', async () => {
    const stub = installApiStub([
      detailsRoute({ clientName: 'Acme Sync', scope: ['invoices.read'], alreadyConsented: false }),
    ]);
    renderAt(AUTHORIZE_QUERY);

    await screen.findByText('Acme Sync is requesting access to:');
    const call = stub.calls.find((entry) => entry.path === '/v1/oauth/authorization-details');
    expect(call).toBeDefined();
    const query = new URLSearchParams(call?.query ?? '');
    expect(query.get('responseType')).toBe('code');
    expect(query.get('clientId')).toBe('client_ab12');
    expect(query.get('redirectUri')).toBe('https://acme.example.com/cb');
    expect(query.get('scope')).toBe('invoices.read contacts.read');
    expect(query.get('state')).toBe('xyz789');
    expect(query.get('codeChallenge')).toBe('abc123');
    expect(query.get('codeChallengeMethod')).toBe('S256');
  });

  it('renders the client name and every requested scope', async () => {
    installApiStub([
      detailsRoute({
        clientName: 'Acme Sync',
        scope: ['invoices.read', 'contacts.read'],
        alreadyConsented: false,
      }),
    ]);
    renderAt(AUTHORIZE_QUERY);

    expect(await screen.findByText('Acme Sync is requesting access to:')).toBeInTheDocument();
    expect(screen.getByText('invoices.read')).toBeInTheDocument();
    expect(screen.getByText('contacts.read')).toBeInTheDocument();
  });

  it('builds Approve as a native form post carrying the request and approve=true', async () => {
    installApiStub([
      detailsRoute({ clientName: 'Acme Sync', scope: ['invoices.read'], alreadyConsented: false }),
    ]);
    renderAt(AUTHORIZE_QUERY);

    const approveButton = await screen.findByRole('button', { name: 'Approve' });
    const form = formOf(approveButton);

    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.getAttribute('action')).toBe('/oauth/consent');

    const fields = hiddenFieldsOf(form);
    expect(fields).toEqual({
      responseType: 'code',
      clientId: 'client_ab12',
      redirectUri: 'https://acme.example.com/cb',
      scope: 'invoices.read contacts.read',
      state: 'xyz789',
      codeChallenge: 'abc123',
      codeChallengeMethod: 'S256',
      approve: 'true',
    });
  });

  it('builds Deny with the same request and approve=false', async () => {
    installApiStub([
      detailsRoute({ clientName: 'Acme Sync', scope: ['invoices.read'], alreadyConsented: false }),
    ]);
    renderAt(AUTHORIZE_QUERY);

    const denyButton = await screen.findByRole('button', { name: 'Deny' });
    const fields = hiddenFieldsOf(formOf(denyButton));
    expect(fields['approve']).toBe('false');
    expect(fields['clientId']).toBe('client_ab12');
  });

  it('reads a missing parameter as an incomplete link rather than fetching', async () => {
    const stub = installApiStub([]);
    renderAt('?response_type=code');

    expect(
      await screen.findByText(/missing parameters and cannot be completed/i),
    ).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });

  it('reads a refused details fetch as an invalid request, not a raw error', async () => {
    installApiStub([detailsRoute({ error: { code: 'not_found', message: 'Not found.' } }, 400)]);
    renderAt(AUTHORIZE_QUERY);

    await waitFor(() => {
      expect(screen.getByText(/no longer valid/i)).toBeInTheDocument();
    });
  });
});
