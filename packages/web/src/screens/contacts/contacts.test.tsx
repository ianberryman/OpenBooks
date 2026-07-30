import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The generated client is a module singleton that captures `globalThis.fetch` and its base
 * URL when `src/api/client.ts` is evaluated, so both stubs have to be in place *before*
 * the imports below run — hence `vi.hoisted`. The base URL is stubbed because jsdom leaves
 * Node's `fetch` in place and `new Request('/v1/contacts')` there is an invalid URL; the
 * application's own default of same-origin is right in a browser and unusable here.
 *
 * Nothing else is mocked. The screen, the query hooks, the generated client, and the
 * component layer are all the real ones — what is replaced is the network, at the one
 * boundary spec §12 says this package owns.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { ContactsScreen } from '../contacts';
import type { Contact } from './queries';

type Route = (request: Request, url: URL) => Response | Promise<Response>;

const routes = new Map<string, Route>();

function stub(method: string, pathname: string, route: Route): void {
  routes.set(`${method} ${pathname}`, route);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The envelope every non-2xx on this API carries (`errorResponseSchema`). */
function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json(status, {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: null,
    displayName: 'Jordan Ellis',
    legalName: null,
    email: null,
    phone: null,
    isCustomer: false,
    isVendor: false,
    isEmployee: false,
    notes: null,
    isActive: true,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function stubList(items: readonly Contact[], nextCursor: string | null = null): void {
  stub('GET', '/v1/contacts', () => json(200, { items, nextCursor }));
}

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ContactsScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

beforeEach(() => {
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (request) => {
    const url = new URL(request.url);
    const route = routes.get(`${request.method} ${url.pathname}`);
    if (route === undefined) {
      throw new Error(`The test stubbed no route for ${request.method} ${url.pathname}.`);
    }
    return route(request, url);
  });
});

describe('ContactsScreen', () => {
  /**
   * The rule this screen exists to keep legible: neither flag is required, and a contact
   * that is neither a customer nor a vendor is the ordinary case rather than an incomplete
   * record. It has to survive the whole round trip — the form must not force a choice, the
   * request must not invent one, the list must render the state as a state, and reopening
   * the form must show it back unchanged.
   */
  it('round-trips a contact that is neither customer nor vendor through the form', async () => {
    const user = userEvent.setup();
    const created = contact({ displayName: 'Priya Raman', code: 'EMP-14' });
    let listed: readonly Contact[] = [];

    stub('GET', '/v1/contacts', () => json(200, { items: listed, nextCursor: null }));
    stub('POST', '/v1/contacts', () => {
      listed = [created];
      return json(201, created);
    });

    renderScreen();
    expect(await screen.findByText('No contacts match these filters.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New contact' }));
    const form = await screen.findByRole('dialog', { name: 'New contact' });

    // Neither checkbox is touched, and neither is required to save.
    expect(within(form).getByRole('checkbox', { name: 'Customer' })).not.toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'Vendor' })).not.toBeChecked();

    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Priya Raman');
    await user.type(within(form).getByRole('textbox', { name: 'Code' }), 'EMP-14');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    const [posted] = requestsTo('POST', '/v1/contacts');
    expect(posted).toBeDefined();
    expect(await posted?.clone().json()).toMatchObject({
      displayName: 'Priya Raman',
      code: 'EMP-14',
      isCustomer: false,
      isVendor: false,
    });
    // Every write carries a key, minted at the point the user committed.
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);

    // The list says what the contact is, rather than leaving the cell blank.
    const row = await screen.findByRole('row', { name: /Priya Raman/ });
    expect(within(row).getByText('Neither')).toBeInTheDocument();
    expect(within(row).queryByText('Customer')).toBeNull();
    expect(within(row).queryByText('Vendor')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edit Priya Raman' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit contact' });
    expect(within(editor).getByRole('textbox', { name: 'Name' })).toHaveValue('Priya Raman');
    expect(within(editor).getByRole('checkbox', { name: 'Customer' })).not.toBeChecked();
    expect(within(editor).getByRole('checkbox', { name: 'Vendor' })).not.toBeChecked();
  });

  it('sets both flags on one contact rather than making them alternatives', async () => {
    const user = userEvent.setup();
    stubList([]);
    stub('POST', '/v1/contacts', () => json(201, contact()));

    renderScreen();
    await user.click(screen.getByRole('button', { name: 'New contact' }));
    const form = await screen.findByRole('dialog', { name: 'New contact' });

    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Acme Supplies');
    await user.click(within(form).getByRole('checkbox', { name: 'Customer' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Vendor' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    const [posted] = requestsTo('POST', '/v1/contacts');
    expect(await posted?.clone().json()).toMatchObject({ isCustomer: true, isVendor: true });
  });

  /**
   * `code` is editable (D-28), and the patch carries only what changed —
   * `updateContactRequestSchema` refuses a body in which every field is absent.
   */
  it('edits a contact code and sends only the changed field', async () => {
    const user = userEvent.setup();
    const existing = contact({ displayName: 'Acme Supplies', code: 'C-100', isCustomer: true });
    stubList([existing]);
    stub('PATCH', `/v1/contacts/${existing.id}`, () => json(200, { ...existing, code: 'C-200' }));

    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Edit Acme Supplies' }));
    const form = await screen.findByRole('dialog', { name: 'Edit contact' });

    await user.clear(within(form).getByRole('textbox', { name: 'Code' }));
    await user.type(within(form).getByRole('textbox', { name: 'Code' }), 'C-200');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    const [patched] = requestsTo('PATCH', `/v1/contacts/${existing.id}`);
    expect(await patched?.clone().json()).toEqual({ code: 'C-200' });
  });

  describe('deletion', () => {
    const acme = contact({ displayName: 'Acme Supplies', isVendor: true });

    async function openDeleteAndConfirm(): Promise<void> {
      const user = userEvent.setup();
      renderScreen();
      await user.click(await screen.findByRole('button', { name: 'Delete Acme Supplies' }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
      );
    }

    it('deletes a contact nothing references', async () => {
      let listed: readonly Contact[] = [acme];
      stub('GET', '/v1/contacts', () => json(200, { items: listed, nextCursor: null }));
      stub('DELETE', `/v1/contacts/${acme.id}`, () => {
        listed = [];
        // 204, which `unwrap` refuses on purpose — the screen has to handle it itself.
        return new Response(null, { status: 204 });
      });

      await openDeleteAndConfirm();

      expect(await screen.findByText('No contacts match these filters.')).toBeInTheDocument();
    });

    /**
     * The two refusals, side by side. They are one HTTP status and one error code and
     * differ only in `details.precondition`, which is exactly why the server bothered to
     * make them two tokens: a posted reference is permanent and deactivation is the whole
     * remedy, while a draft reference is one edit away from gone. A screen that rendered
     * both as one red box would throw that distinction away at the only layer where it is
     * actionable.
     */
    it('offers deactivation when a posted line names the contact', async () => {
      const user = userEvent.setup();
      stubList([acme]);
      stub('DELETE', `/v1/contacts/${acme.id}`, () =>
        apiError(412, 'precondition_failed', 'This contact is named by at least one posted line.', {
          precondition: 'contact_has_postings',
        }),
      );
      stub('POST', `/v1/contacts/${acme.id}/deactivate`, () =>
        json(200, { ...acme, isActive: false }),
      );

      await openDeleteAndConfirm();

      const refusal = await screen.findByRole('dialog', {
        name: 'This contact is on posted entries',
      });
      expect(within(refusal).getByText(/cannot be deleted/)).toBeInTheDocument();
      expect(within(refusal).queryByRole('button', { name: 'Try delete again' })).toBeNull();

      await user.click(within(refusal).getByRole('button', { name: 'Deactivate instead' }));
      expect(requestsTo('POST', `/v1/contacts/${acme.id}/deactivate`)).toHaveLength(1);
    });

    it('points at the draft, and offers no deactivation, when a draft names the contact', async () => {
      stubList([acme]);
      stub('DELETE', `/v1/contacts/${acme.id}`, () =>
        apiError(412, 'precondition_failed', 'This contact is named by an unposted draft.', {
          precondition: 'contact_on_draft',
        }),
      );

      await openDeleteAndConfirm();

      const refusal = await screen.findByRole('dialog', {
        name: 'This contact is on an unposted draft',
      });
      expect(within(refusal).getByText(/discard the draft/)).toBeInTheDocument();
      expect(within(refusal).queryByRole('button', { name: 'Deactivate instead' })).toBeNull();
      expect(within(refusal).getByRole('button', { name: 'Try delete again' })).toBeInTheDocument();
    });

    it('retries a refused delete under the key the first attempt used', async () => {
      const user = userEvent.setup();
      stubList([acme]);
      stub('DELETE', `/v1/contacts/${acme.id}`, () =>
        apiError(412, 'precondition_failed', 'This contact is named by an unposted draft.', {
          precondition: 'contact_on_draft',
        }),
      );

      await openDeleteAndConfirm();
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Try delete again' }),
      );

      const [first, second] = requestsTo('DELETE', `/v1/contacts/${acme.id}`);
      expect(second).toBeDefined();
      // One intent, one key: the body never changed, and a failed claim rolls back rather
      // than poisoning the key (`modules/idempotency/service.ts`).
      expect(second?.headers.get('idempotency-key')).toBe(first?.headers.get('idempotency-key'));
    });

    it('falls back to the shared error surface for a refusal it does not know', async () => {
      stubList([acme]);
      stub('DELETE', `/v1/contacts/${acme.id}`, () =>
        apiError(403, 'permission_denied', 'Permission denied: contacts.write.', {
          permission: 'contacts.write',
        }),
      );

      await openDeleteAndConfirm();

      expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    });
  });

  describe('filters and ordering', () => {
    it('filters on customer without saying anything about vendor', async () => {
      const user = userEvent.setup();
      stubList([contact({ displayName: 'Acme Supplies', isCustomer: true, isVendor: true })]);

      renderScreen();
      await screen.findByRole('row', { name: /Acme Supplies/ });

      await user.click(screen.getByRole('combobox', { name: 'Customer' }));
      await user.click(screen.getByRole('option', { name: 'Yes' }));

      await vi.waitFor(() => {
        const queries = requestsTo('GET', '/v1/contacts').map(
          (request) => new URL(request.url).search,
        );
        expect(queries.at(-1)).toContain('isCustomer=true');
        expect(queries.at(-1)).not.toContain('isVendor');
      });
    });

    /**
     * D-21/D-28: the server pages `(created_at, id)`, so a name sort can only be a
     * page-local one. It is offered, and it says what it is.
     */
    it('sorts by name within the loaded rows and says that is what it did', async () => {
      const user = userEvent.setup();
      stubList([
        contact({ id: '11111111-1111-4111-8111-111111111111', displayName: 'Zenith Ltd' }),
        contact({ id: '22222222-2222-4222-8222-222222222222', displayName: 'Acme Supplies' }),
      ]);

      renderScreen();
      await screen.findByRole('row', { name: /Zenith Ltd/ });
      expect(screen.getAllByRole('row').slice(1).at(0)).toHaveTextContent('Zenith Ltd');

      await user.click(screen.getByRole('combobox', { name: 'Order' }));
      await user.click(screen.getByRole('option', { name: 'Name (within loaded rows)' }));

      expect(screen.getAllByRole('row').slice(1).at(0)).toHaveTextContent('Acme Supplies');
      expect(screen.getByText(/page-local sort/)).toBeInTheDocument();
    });

    /**
     * Presence of `nextCursor` is the only signal that another page exists — a full page
     * does not imply one — and the cursor goes back verbatim.
     */
    it('pages on the cursor it was given, and only when it was given one', async () => {
      const user = userEvent.setup();
      const first = contact({ id: '11111111-1111-4111-8111-111111111111', displayName: 'First' });
      const second = contact({ id: '22222222-2222-4222-8222-222222222222', displayName: 'Second' });

      stub('GET', '/v1/contacts', (_request, url) =>
        url.searchParams.get('cursor') === 'cursor-abc'
          ? json(200, { items: [second], nextCursor: null })
          : json(200, { items: [first], nextCursor: 'cursor-abc' }),
      );

      renderScreen();
      await user.click(await screen.findByRole('button', { name: 'Load more' }));

      await screen.findByRole('row', { name: /Second/ });
      expect(
        requestsTo('GET', '/v1/contacts').some(
          (request) => new URL(request.url).searchParams.get('cursor') === 'cursor-abc',
        ),
      ).toBe(true);
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });
  });

  it('deactivates from the list and reactivates the same row', async () => {
    const user = userEvent.setup();
    let listed = [contact({ displayName: 'Acme Supplies' })];
    const [first] = listed;

    stub('GET', '/v1/contacts', () => json(200, { items: listed, nextCursor: null }));
    stub('POST', `/v1/contacts/${first?.id ?? ''}/deactivate`, () => {
      listed = listed.map((row) => ({ ...row, isActive: false }));
      return json(200, listed[0]);
    });

    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Deactivate Acme Supplies' }));

    expect(
      await screen.findByRole('button', { name: 'Reactivate Acme Supplies' }),
    ).toBeInTheDocument();
  });
});
