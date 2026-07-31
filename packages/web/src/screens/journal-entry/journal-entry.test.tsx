import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalEntryScreen } from '../journal-entry';
import type {
  Account,
  Contact,
  Dimension,
  DimensionValue,
  JournalDraft,
  PostedJournal,
  UpdateDraftRequest,
} from './queries';

/**
 * The journal entry screen against a stubbed API (OB-051, harness from OB-058).
 *
 * jsdom is not a browser and nothing here is a claim about layout — B1's real browser
 * run is OB-055. What *is* answerable at this level is the part of this screen that is
 * a pure function of events and requests, and it happens to be the part that is
 * expensive to get wrong: the arithmetic behind the balancing indicator, the identity
 * of the key on the Post button, and the absence of any affordance on a posted entry
 * that the database would refuse.
 *
 * ## Why the globals are replaced before the imports
 *
 * `openapi-fetch` destructures `globalThis.fetch` and `globalThis.Request` when the
 * client is *created*, and `src/api/client.ts` creates its singleton at module
 * evaluation. Stubbing after the import would leave the real ones captured, so this
 * runs in `vi.hoisted`, which vitest evaluates ahead of the import graph.
 *
 * `Request` needs replacing at all because the app's base URL is empty — same-origin is
 * the supported deployment (`src/env.ts`) — and undici's `Request` refuses a relative
 * URL, which a browser resolves against the document. The subclass below is that
 * resolution and nothing else.
 */
const harness = vi.hoisted(() => {
  const ORIGIN = 'http://localhost:3000';
  const NativeRequest = globalThis.Request;

  class RelativeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
    }
  }
  globalThis.Request = RelativeRequest;

  let handler: ((request: Request) => Promise<Response>) | null = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (handler === null) throw new Error('No API double is installed for this test.');
    return handler(input instanceof Request ? input : new Request(input, init));
  };

  return {
    ORIGIN,
    install(next: (request: Request) => Promise<Response>): void {
      handler = next;
    },
  };
});

// --- Fixtures ---------------------------------------------------------------

const TIMESTAMP = '2026-07-01T00:00:00.000Z';

function account(id: string, code: string, name: string, isActive = true): Account {
  return {
    id,
    code,
    name,
    description: null,
    cashBasisRole: null,
    isActive,
    normalBalance: 'debit',
    parentAccountId: null,
    type: 'asset',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function contact(id: string, displayName: string): Contact {
  return {
    id,
    code: null,
    displayName,
    email: null,
    isActive: true,
    isCustomer: true,
    isVendor: false,
    isEmployee: false,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    legalName: null,
    notes: null,
    phone: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const ACCOUNTS: readonly Account[] = [
  account('acc-cash', '1-1000', 'Cash at bank'),
  account('acc-sales', '4-4000', 'Sales revenue'),
  account('acc-old', '9-9999', 'Retired suspense', false),
];

const CONTACTS: readonly Contact[] = [contact('contact-acme', 'Acme Supplies')];

const DIMENSION: Dimension = {
  id: 'dim-dept',
  code: 'DEPT',
  name: 'Department',
  description: null,
  isActive: true,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const DIMENSION_VALUES: readonly DimensionValue[] = [
  {
    id: 'dv-sales',
    dimensionId: 'dim-dept',
    code: 'SALES',
    name: 'Sales team',
    isActive: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
];

const DRAFT_ID = 'draft-0001';

function emptyDraft(): JournalDraft {
  return {
    id: DRAFT_ID,
    createdByUserId: 'user-1',
    entryDate: '2026-07-01',
    memo: null,
    reference: null,
    entryType: 'standard',
    lines: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const POSTED: PostedJournal = {
  journalId: 'journal-0001',
  orgId: 'org-1',
  date: '2026-07-01',
  memo: 'Cash sale',
  actorId: 'user-1',
  actorType: 'user',
  invocationMode: null,
  postedAt: TIMESTAMP,
  reversesJournalId: null,
  lines: [
    {
      lineId: 'jl-1',
      accountId: 'acc-cash',
      side: 'debit',
      amount: '150000',
      contactId: 'contact-acme',
      memo: null,
      dimensionValueIds: ['dv-sales'],
    },
    {
      lineId: 'jl-2',
      accountId: 'acc-sales',
      side: 'credit',
      amount: '150000',
      contactId: null,
      memo: null,
      dimensionValueIds: [],
    },
  ],
};

const REVERSAL: PostedJournal = {
  ...POSTED,
  journalId: 'journal-0002',
  reversesJournalId: 'journal-0001',
  lines: POSTED.lines.map((line) => ({
    ...line,
    side: line.side === 'debit' ? 'credit' : 'debit',
  })),
};

// --- The API double ---------------------------------------------------------

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(code: string, message: string, issues?: readonly unknown[]): unknown {
  return {
    error: {
      code,
      message,
      ...(issues === undefined ? {} : { details: { issues } }),
    },
  };
}

function page(items: readonly unknown[]): Response {
  return json(200, { items, nextCursor: null });
}

function parseJson(text: string): unknown {
  return text === '' ? null : (JSON.parse(text) as unknown);
}

function asPatch(body: unknown): UpdateDraftRequest {
  return typeof body === 'object' && body !== null ? body : {};
}

interface ApiDouble {
  readonly calls: readonly RecordedCall[];
  readonly handle: (request: Request) => Promise<Response>;
  setPostResponse: (respond: () => Response | Promise<Response>) => void;
}

function createApiDouble(): ApiDouble {
  const calls: RecordedCall[] = [];
  let draft: JournalDraft | null = null;
  let postResponse: () => Response | Promise<Response> = () => json(201, POSTED);

  function applyPatch(current: JournalDraft, patch: UpdateDraftRequest): JournalDraft {
    return {
      ...current,
      entryDate: patch.entryDate === undefined ? current.entryDate : patch.entryDate,
      memo: patch.memo === undefined ? current.memo : patch.memo,
      reference: patch.reference === undefined ? current.reference : patch.reference,
      entryType: patch.entryType === undefined ? current.entryType : patch.entryType,
      lines:
        patch.lines === undefined
          ? current.lines
          : patch.lines.map((line, index) => ({
              lineId: `stored-${String(index)}`,
              lineNumber: index + 1,
              accountId: line.accountId ?? null,
              contactId: line.contactId ?? null,
              side: line.side ?? null,
              // The stored contract: a line with no side reads back with no amount.
              amount: line.side == null ? '0' : (line.amount ?? '0'),
              memo: line.memo ?? null,
              dimensionValueIds: line.dimensionValueIds ?? [],
            })),
    };
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    const body = parseJson(await request.text());
    calls.push({
      method,
      path: pathname,
      idempotencyKey: request.headers.get('idempotency-key'),
      body,
    });

    if (method === 'GET' && pathname === '/v1/accounts') return page(ACCOUNTS);
    if (method === 'GET' && pathname === '/v1/contacts') return page(CONTACTS);
    if (method === 'GET' && pathname === '/v1/dimensions') return page([DIMENSION]);
    if (method === 'GET' && /^\/v1\/dimensions\/[^/]+\/values$/.test(pathname)) {
      return page(DIMENSION_VALUES);
    }

    if (method === 'GET' && pathname === '/v1/journal-drafts') {
      return page(draft === null ? [] : [{ ...draft, lines: undefined }]);
    }
    if (method === 'POST' && pathname === '/v1/journal-drafts') {
      draft = emptyDraft();
      return json(201, draft);
    }
    if (pathname === `/v1/journal-drafts/${DRAFT_ID}`) {
      if (draft === null) return json(404, apiError('not_found', 'Not found.'));
      if (method === 'GET') return json(200, draft);
      if (method === 'PATCH') {
        draft = applyPatch(draft, asPatch(body));
        return json(200, draft);
      }
      if (method === 'DELETE') {
        draft = null;
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'POST' && pathname === `/v1/journal-drafts/${DRAFT_ID}/post`) {
      return postResponse();
    }
    if (method === 'POST' && /^\/v1\/journals\/[^/]+\/reverse$/.test(pathname)) {
      return json(201, REVERSAL);
    }

    return json(404, apiError('not_found', `No route for ${method} ${pathname}.`));
  }

  return {
    calls,
    handle,
    setPostResponse(respond) {
      postResponse = respond;
    },
  };
}

// --- Harness ----------------------------------------------------------------

let server: ApiDouble;

beforeEach(() => {
  server = createApiDouble();
  harness.install(server.handle);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderScreen(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <JournalEntryScreen />
    </QueryClientProvider>,
  );
}

async function startDraft(user: UserEvent): Promise<void> {
  renderScreen();
  await user.click(await screen.findByRole('button', { name: 'New entry' }));
  await screen.findByRole('region', { name: 'Journal entry draft' });
}

function postCalls(): readonly RecordedCall[] {
  return server.calls.filter((call) => call.path.endsWith(`/${DRAFT_ID}/post`));
}

function postButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Post entry' });
}

// --- Tests ------------------------------------------------------------------

describe('the balancing indicator', () => {
  /**
   * The one assertion this screen cannot afford to get wrong, and the reason the totals
   * are `bigint` (D-13): 9007199254740993 and 9007199254740992 are the same double, so a
   * `number` implementation renders "Difference 0.00" over an entry that is a cent out —
   * and renders it in the panel the user is relying on to decide the entry is finished.
   */
  it('is exact above 2^53, where a number would report a balanced entry', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.type(screen.getByRole('textbox', { name: 'Debit, line 1' }), '90071992547409.93');
    await user.type(screen.getByRole('textbox', { name: 'Credit, line 2' }), '90071992547409.92');

    const indicator = screen.getByRole('status');
    expect(within(indicator).getByText('Out of balance by')).toBeInTheDocument();
    expect(within(indicator).getByText('$0.01')).toBeInTheDocument();
    expect(within(indicator).getByText('$90,071,992,547,409.93')).toBeInTheDocument();
    expect(within(indicator).getByText('$90,071,992,547,409.92')).toBeInTheDocument();
  });

  it('reports a balanced entry once both sides agree', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.type(screen.getByRole('textbox', { name: 'Debit, line 1' }), '1500');
    await user.type(screen.getByRole('textbox', { name: 'Credit, line 2' }), '1500');

    const indicator = screen.getByRole('status');
    expect(within(indicator).getByText('Debits equal credits.')).toBeInTheDocument();
    expect(within(indicator).getByText('Difference')).toBeInTheDocument();
  });

  /**
   * A journal line moves one side only — the side carries the sign — so typing into
   * Credit on a line that held a debit moves the line rather than giving it two amounts.
   * Without this, the same money is counted on both sides and the entry appears balanced.
   */
  it('moves a line to the other side rather than letting it hold two amounts', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.type(screen.getByRole('textbox', { name: 'Debit, line 1' }), '100');
    await user.type(screen.getByRole('textbox', { name: 'Credit, line 1' }), '100');

    expect(screen.getByRole('textbox', { name: 'Debit, line 1' })).toHaveValue('');

    const indicator = screen.getByRole('status');
    expect(within(indicator).getByText('Credits exceed debits.')).toBeInTheDocument();
  });
});

describe('posting', () => {
  /**
   * The ticket's guarantee: one key minted per draft, not per click. A rejected post
   * releases its claim ("a failure is not poison"), so the second attempt is the *same*
   * request with the *same* key — which is how the server tells a retry from a second
   * entry. A key minted inside the click handler would pass every other test in this file
   * and post two journals the first time a user pressed the button twice.
   */
  it('sends one idempotency key across repeated clicks', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    server.setPostResponse(() =>
      json(500, apiError('internal_error', 'The request could not be completed.')),
    );
    await user.click(postButton());
    await screen.findByText('Something went wrong');

    server.setPostResponse(() => json(201, POSTED));
    await user.click(postButton());
    await screen.findByRole('region', { name: 'Posted journal entry' });

    const posts = postCalls();
    expect(posts).toHaveLength(2);
    expect(posts[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(posts[0]?.idempotencyKey).toBe(posts[1]?.idempotencyKey);
  });

  it('issues no second request while a post is in flight', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    // Annotated and initialized, so the call below is not narrowed to `never` by the fact
    // that the only assignment happens inside a callback the compiler cannot order.
    let release: () => void = () => {};
    server.setPostResponse(
      async () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(json(201, POSTED));
          };
        }),
    );

    await user.click(postButton());

    const inFlight = await screen.findByRole('button', { name: 'Posting…' });
    expect(inFlight).toBeDisabled();
    await user.click(inFlight);

    expect(postCalls()).toHaveLength(1);

    release();
    await screen.findByRole('region', { name: 'Posted journal entry' });
  });

  /**
   * Post writes what the *server* holds — `postDraft` carries no body — so unsaved edits
   * have to reach the draft first or the user posts an entry they cannot see.
   */
  it('flushes unsaved edits before posting', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.type(screen.getByRole('textbox', { name: 'Debit, line 1' }), '1500');
    await user.click(postButton());
    await screen.findByRole('region', { name: 'Posted journal entry' });

    const patches = server.calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(1);
    // The save is a different intent from the post and fingerprints the patch, so it
    // carries its own key rather than the draft's.
    expect(patches[0]?.idempotencyKey).not.toBe(postCalls()[0]?.idempotencyKey);
  });
});

describe('a refused post', () => {
  it("surfaces the kernel's verdict on the line set beside the balance", async () => {
    const user = userEvent.setup();
    await startDraft(user);

    server.setPostResponse(() =>
      json(
        400,
        apiError('validation_failed', 'This draft is not ready to post.', [
          { path: 'lines', message: 'Debits and credits must be equal.' },
        ]),
      ),
    );

    await user.click(postButton());

    const indicator = await screen.findByRole('status');
    expect(within(indicator).getByText('Debits and credits must be equal.')).toBeInTheDocument();
  });

  it('puts a per-line message on the line it names, and leaves the draft postable', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    server.setPostResponse(() =>
      json(
        400,
        apiError('validation_failed', 'This draft is not ready to post.', [
          { path: 'lines.0.accountId', message: 'This line has no account.' },
          { path: 'entryDate', message: 'A draft needs an entry date before it can be posted.' },
        ]),
      ),
    );

    await user.click(postButton());

    expect(await screen.findByText('This line has no account.')).toBeInTheDocument();
    expect(
      screen.getByText('A draft needs an entry date before it can be posted.'),
    ).toBeInTheDocument();

    // The draft survives a refused post — the transaction rolled back — so the editor is
    // still here and Post is still the next thing to press.
    expect(screen.getByRole('region', { name: 'Journal entry draft' })).toBeInTheDocument();
    expect(postButton()).toBeEnabled();
  });

  /**
   * A closed period is the M2 case where a generic failure is actively harmful: the state
   * of the books is the problem, not the entry, and the server's own message is the one
   * that says so — `presentApiError` prefers it over the fallback for exactly this code.
   */
  it('shows the precondition the server named, not a generic failure', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    server.setPostResponse(() =>
      json(412, apiError('precondition_failed', 'The period containing 2026-07-01 is closed.')),
    );

    await user.click(postButton());

    expect(await screen.findByText('The period containing 2026-07-01 is closed.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Journal entry draft' })).toBeInTheDocument();
  });
});

describe('a posted entry', () => {
  async function post(user: UserEvent): Promise<void> {
    await startDraft(user);
    await user.click(postButton());
    await screen.findByRole('region', { name: 'Posted journal entry' });
  }

  /**
   * A6: the application connects as a user holding no `UPDATE` and no `DELETE` on
   * `journals`. An edit affordance here would be a promise the database refuses to keep,
   * discovered by the user after retyping the entry — so the only correction offered is
   * a reversal, which is a new journal (D-02, D-16).
   */
  it('offers reversal and no way to edit or delete', async () => {
    const user = userEvent.setup();
    await post(user);

    const entry = screen.getByRole('region', { name: 'Posted journal entry' });
    expect(within(entry).getByRole('button', { name: 'Reverse entry' })).toBeInTheDocument();

    for (const forbidden of [/edit/i, /delete/i, /discard/i, /save/i, /remove/i, /post entry/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }

    // Nothing on a posted entry is a control at all: no amount box, no account picker.
    expect(within(entry).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(entry).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(entry).queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('shows what the ledger stored, including the line’s contact and tags', async () => {
    const user = userEvent.setup();
    await post(user);

    const entry = screen.getByRole('region', { name: 'Posted journal entry' });
    expect(within(entry).getByText('Cash at bank')).toBeInTheDocument();
    expect(within(entry).getByText('Acme Supplies')).toBeInTheDocument();
    expect(within(entry).getByText('Sales team')).toBeInTheDocument();
    expect(within(entry).getAllByText('$1,500.00')).toHaveLength(4);
  });

  it('reverses through a deliberate confirmation and shows the reversal', async () => {
    const user = userEvent.setup();
    await post(user);

    await user.click(screen.getByRole('button', { name: 'Reverse entry' }));
    await user.click(await screen.findByRole('button', { name: 'Post reversal' }));

    expect(await screen.findByText(/This entry reverses another/)).toBeInTheDocument();

    const reversals = server.calls.filter((call) => call.path.endsWith('/reverse'));
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.idempotencyKey).toEqual(expect.any(String));
  });
});

describe('per-line tagging', () => {
  /**
   * A draft carries the contact and the dimension values, and now posts them (OB-059) —
   * so a tag entered here is a tag on the journal line, not a note that is dropped at the
   * boundary. Tagging is on the line and not the header because one entry legitimately
   * splits rent across three departments (D-18).
   */
  it('saves a contact and a dimension value on the line that carries them', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.click(screen.getByRole('combobox', { name: 'Contact, line 1' }));
    await user.click(await screen.findByText('Acme Supplies'));

    await user.click(screen.getByRole('button', { name: 'Details, line 1' }));
    await user.click(screen.getByRole('combobox', { name: 'Department, line 1' }));
    await user.click(await screen.findByText('Sales team'));

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(server.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });

    const patch = asPatch(server.calls.filter((call) => call.method === 'PATCH')[0]?.body);
    expect(patch.lines?.[0]?.contactId).toBe('contact-acme');
    expect(patch.lines?.[0]?.dimensionValueIds).toEqual(['dv-sales']);
    expect(patch.lines?.[1]?.contactId).toBeNull();
  });

  it('flags an adjusting entry and carries it on the draft patch (P, OB-194)', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.click(screen.getByRole('combobox', { name: 'Entry type' }));
    await user.click(await screen.findByRole('option', { name: 'Adjusting' }));

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(server.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });

    const patch = asPatch(server.calls.filter((call) => call.method === 'PATCH')[0]?.body);
    // The classification rides the patch — postDraft maps it to the journal's source,
    // which is what the audit trail reads back.
    expect(patch.entryType).toBe('adjusting');
  });

  it('offers an inactive account as a disabled option rather than hiding it', async () => {
    const user = userEvent.setup();
    await startDraft(user);

    await user.click(screen.getByRole('combobox', { name: 'Account, line 1' }));

    const retired = screen.getByRole('option', { name: /Retired suspense/ });
    expect(retired).toHaveAttribute('aria-disabled', 'true');
  });
});
