import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The network is the only thing stubbed. The generated client captures `globalThis.fetch`
 * and its base URL when `src/api/client.ts` is evaluated, so both are set in `vi.hoisted`
 * before the imports below run — the base URL because jsdom leaves Node's `fetch` in
 * place, where `new Request('/v1/…')` is an invalid URL. The screen, the query hooks, the
 * generated client and the component layer are all real; what is replaced is the boundary
 * spec §12 says this package owns.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { BankImportScreen } from './bank-import';
import type {
  BankAccount,
  BankImportMapping,
  BankStatementImport,
  BankStatementImportPreview,
  BankStatementLineDraft,
} from './queries';

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

const ACC = '11111111-1111-4111-8111-111111111111';
const LEDGER = '22222222-2222-4222-8222-222222222222';
const MAP = '33333333-3333-4333-8333-333333333333';
const IMPORT = '44444444-4444-4444-8444-444444444444';

// Listing mappings is a query filter (`?bankAccountId=`); saving one stays nested under
// the account, because the list returns an empty page for an unknown account and the save
// 404s it. The stub matches by pathname, so the two are keyed separately.
const MAPPINGS_LIST_PATH = '/v1/import-mappings';
const MAPPINGS_PATH = `/v1/bank-accounts/${ACC}/import-mappings`;
const IMPORT_PATH = `/v1/bank-statement-imports/${IMPORT}`;

function account(): BankAccount {
  return {
    id: ACC,
    accountId: LEDGER,
    name: 'Barclays Current',
    institutionName: 'Barclays',
    externalAccountId: '1234',
    feedSource: 'file',
    isActive: true,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
  };
}

function line(overrides: Partial<BankStatementLineDraft> = {}): BankStatementLineDraft {
  return {
    amount: '0',
    bankReference: null,
    counterparty: null,
    description: 'A row',
    fingerprint: 'fp',
    isDuplicate: false,
    occurrenceIndex: 0,
    postedDate: '2026-01-15',
    valueDate: null,
    ...overrides,
  };
}

function preview(overrides: Partial<BankStatementImportPreview> = {}): BankStatementImportPreview {
  return {
    format: 'csv',
    headers: ['Date', 'Description', 'Amount'],
    result: { linesRead: 3, linesImported: 2, linesDuplicate: 1 },
    sample: [
      line({ postedDate: '2026-02-01', description: 'ACME LTD', amount: '150000' }),
      line({ postedDate: '2026-01-15', description: 'RENT', amount: '-90000', isDuplicate: true }),
    ],
    statementStart: '2026-01-01',
    statementEnd: '2026-02-01',
    statementClosingBalance: '250000',
    externalAccountId: '1234',
    externalAccountMatches: true,
    ...overrides,
  };
}

function importRow(overrides: Partial<BankStatementImport>): BankStatementImport {
  return {
    id: IMPORT,
    bankAccountId: ACC,
    format: 'csv',
    filename: 'statement.csv',
    mappingId: null,
    status: 'queued',
    result: null,
    failureReason: null,
    statementClosingBalance: null,
    externalAccountId: null,
    importedByUserId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-02-02T09:00:00.000Z',
    ...overrides,
  };
}

const CSV = [
  'Date,Description,Amount',
  '2026-02-01,ACME LTD,1500.00',
  '2026-01-15,RENT,-900.00',
].join('\n');

const DEBIT_CREDIT_CSV = [
  'Date,Narrative,Money out,Money in',
  '2026-02-01,ACME LTD,,1500.00',
  '2026-01-15,RENT,900.00,',
].join('\n');

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <BankImportScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return (await request.clone().json()) as Record<string, unknown>;
}

/** Open a Radix `Select` by the label its trigger carries, and commit an option. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: string,
  optionName: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: triggerName }));
  await user.click(await screen.findByRole('option', { name: optionName }));
}

async function chooseAccount(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Bank account' }));
  await user.click(await screen.findByRole('option', { name: /Barclays Current/ }));
}

async function uploadCsv(
  user: ReturnType<typeof userEvent.setup>,
  content: string = CSV,
): Promise<void> {
  const file = new File([content], 'statement.csv', { type: 'text/csv' });
  await user.upload(screen.getByLabelText('File'), file);
  // The mapping controls appear only once the file has been read as text.
  await screen.findByRole('combobox', { name: 'Column mapping' });
}

/** Assign the three required signed-mapping fields from the default CSV's headers. */
async function buildSignedMapping(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await pick(user, 'Posted date', 'Date');
  await pick(user, 'Description', 'Description');
  await pick(user, 'Amount', 'Amount');
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

  // The two reads every path needs: the account picker, and the (initially empty) list of
  // saved mappings for the chosen account.
  stub('GET', '/v1/bank-accounts', () => json(200, { items: [account()], nextCursor: null }));
  stub('GET', MAPPINGS_LIST_PATH, () => json(200, { items: [], nextCursor: null }));
});

describe('BankImportScreen — mapping and preview', () => {
  /**
   * The mapping is built by hand and previewed; the preview shows the parsed rows with a
   * marker on each already-present line (D-42/E1: the one fact the file cannot tell you).
   * The request carries the built mapping inline, not a mapping id.
   */
  it('builds a CSV mapping, previews it, and marks the duplicate rows', async () => {
    const user = userEvent.setup();
    stub('POST', '/v1/bank-statement-imports/preview', () => json(200, preview()));

    renderScreen();
    await chooseAccount(user);
    await uploadCsv(user);
    await buildSignedMapping(user);

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    const table = await screen.findByRole('table');
    expect(within(table).getByText('ACME LTD')).toBeInTheDocument();
    expect(within(table).getByText('RENT')).toBeInTheDocument();
    // The duplicate row is flagged; the count is stated as the ordinary case, not an error.
    expect(within(table).getByText('Already present')).toBeInTheDocument();
    expect(screen.getByText(/1 already exists/)).toBeInTheDocument();
    // The file's own closing balance, formatted — never Number()'d (D-13).
    expect(screen.getByText('2500.00')).toBeInTheDocument();

    const [posted] = requestsTo('POST', '/v1/bank-statement-imports/preview');
    expect(posted).toBeDefined();
    const body = await bodyOf(posted as Request);
    expect(body).toMatchObject({ bankAccountId: ACC, format: 'csv', filename: 'statement.csv' });
    expect(body['mappingId']).toBeUndefined();
    expect(body['mapping']).toMatchObject({
      dateOrder: 'ymd',
      amountConvention: 'signed',
      columns: { postedDate: 0, description: 1, amount: 2, debit: null, credit: null },
    });
    // Every write on this API carries a key (spec §12), preview included.
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * The debit/credit trap, encoded: under separate columns the *credit* column is money
   * in, because the labels are the bank's accounting and your account is their liability.
   * The editor must send `credit` mapped to the money-in column with `amount` null, and the
   * server's positive amount for a credit row must render as money in.
   */
  it('maps the credit column to money in under the debit/credit convention', async () => {
    const user = userEvent.setup();
    stub('POST', '/v1/bank-statement-imports/preview', () =>
      json(
        200,
        preview({
          headers: ['Date', 'Narrative', 'Money out', 'Money in'],
          result: { linesRead: 2, linesImported: 2, linesDuplicate: 0 },
          sample: [
            line({ postedDate: '2026-02-01', description: 'ACME LTD', amount: '150000' }),
            line({ postedDate: '2026-01-15', description: 'RENT', amount: '-90000' }),
          ],
        }),
      ),
    );

    renderScreen();
    await chooseAccount(user);
    await uploadCsv(user, DEBIT_CREDIT_CSV);

    await pick(user, 'Amount columns', 'Separate debit and credit columns');
    await pick(user, 'Posted date', 'Date');
    await pick(user, 'Description', 'Narrative');
    await pick(user, 'Debit (money out)', 'Money out');
    await pick(user, 'Credit (money in)', 'Money in');

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    const [posted] = requestsTo('POST', '/v1/bank-statement-imports/preview');
    const body = await bodyOf(posted as Request);
    expect(body['mapping']).toMatchObject({
      amountConvention: 'debit_credit_columns',
      columns: { postedDate: 0, description: 1, amount: null, debit: 2, credit: 3 },
    });

    // The credit row (Money in) came back positive and reads as money in, not out.
    const table = await screen.findByRole('table');
    const acmeRow = within(table).getByText('ACME LTD').closest('tr');
    expect(acmeRow?.textContent).toContain('1500.00');
    expect(acmeRow?.textContent).not.toContain('-1500.00');
  });

  /**
   * Re-previewing an overlapping file — the straggler-catching re-upload E1 is built to
   * make safe — surfaces every row as already present rather than as new.
   */
  it('shows duplicates when an overlapping file is previewed again', async () => {
    const user = userEvent.setup();
    let previews = 0;
    stub('POST', '/v1/bank-statement-imports/preview', () => {
      previews += 1;
      // First look: all three new. Second look, same file: all three already present.
      return json(
        200,
        previews === 1
          ? preview({
              result: { linesRead: 2, linesImported: 2, linesDuplicate: 0 },
              sample: [
                line({ description: 'ACME LTD', amount: '150000' }),
                line({ description: 'RENT', amount: '-90000' }),
              ],
            })
          : preview({
              result: { linesRead: 2, linesImported: 0, linesDuplicate: 2 },
              sample: [
                line({ description: 'ACME LTD', amount: '150000', isDuplicate: true }),
                line({ description: 'RENT', amount: '-90000', isDuplicate: true }),
              ],
            }),
      );
    });

    renderScreen();
    await chooseAccount(user);
    await uploadCsv(user);
    await buildSignedMapping(user);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/2 would be new|2 already/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    await vi.waitFor(() => {
      expect(screen.getByText(/2 already exist/)).toBeInTheDocument();
    });
    expect(screen.getAllByText('Already present')).toHaveLength(2);
    expect(requestsTo('POST', '/v1/bank-statement-imports/preview')).toHaveLength(2);
  });
});

describe('BankImportScreen — saved mappings', () => {
  /**
   * The reuse round-trip (OB-076): a built mapping is saved under a name, appears in the
   * account's list, and a later preview reads the file by its id rather than by an inline
   * mapping — which is what turns "a question asked once per bank" into a saved artefact.
   */
  it('saves a built mapping and reuses it by id', async () => {
    const user = userEvent.setup();
    const saved: BankImportMapping[] = [];

    stub('GET', MAPPINGS_LIST_PATH, () => json(200, { items: saved, nextCursor: null }));
    stub('POST', MAPPINGS_PATH, async (request) => {
      const body = await bodyOf(request);
      const mapping: BankImportMapping = {
        id: MAP,
        name: String(body['name']),
        definition: body['definition'] as BankImportMapping['definition'],
        createdAt: '2026-02-02T09:00:00.000Z',
        updatedAt: '2026-02-02T09:00:00.000Z',
      };
      saved.push(mapping);
      return json(201, mapping);
    });
    stub('POST', '/v1/bank-statement-imports/preview', () => json(200, preview()));

    renderScreen();
    await chooseAccount(user);
    await uploadCsv(user);
    await buildSignedMapping(user);

    await user.type(screen.getByRole('textbox', { name: 'Save this mapping as' }), 'Barclays');
    await user.click(screen.getByRole('button', { name: 'Save mapping for reuse' }));

    const [savePost] = requestsTo('POST', MAPPINGS_PATH);
    const saveBody = await bodyOf(savePost as Request);
    expect(saveBody).toMatchObject({
      name: 'Barclays',
      definition: { columns: { postedDate: 0, description: 1, amount: 2 } },
    });

    // Saving switches to the mapping and the list now offers it for reuse.
    expect(await screen.findByText(/Reading this file with the saved mapping/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    const [posted] = requestsTo('POST', '/v1/bank-statement-imports/preview');
    const body = await bodyOf(posted as Request);
    expect(body['mappingId']).toBe(MAP);
    expect(body['mapping']).toBeUndefined();
  });
});

describe('BankImportScreen — import and poll', () => {
  /**
   * The async import (D-49): start returns 202 with a queued handle, and the screen polls
   * `getBankStatementImport` until it settles, then shows the E1 counts. "Already present"
   * being non-zero is the ordinary outcome of an overlapping upload, not a fault.
   */
  it('starts the import, polls to completion, and shows the new/duplicate counts', async () => {
    const user = userEvent.setup();
    let gets = 0;

    stub('POST', '/v1/bank-statement-imports/preview', () => json(200, preview()));
    stub('POST', '/v1/bank-statement-imports', () =>
      json(202, { id: IMPORT, bankAccountId: ACC, status: 'queued' }),
    );
    stub('GET', IMPORT_PATH, () => {
      gets += 1;
      // Still parsing on the first read; complete thereafter.
      return json(
        200,
        gets < 2
          ? importRow({ status: 'processing' })
          : importRow({
              status: 'complete',
              result: { linesRead: 42, linesImported: 40, linesDuplicate: 2 },
            }),
      );
    });

    renderScreen();
    await chooseAccount(user);
    await uploadCsv(user);
    await buildSignedMapping(user);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Import' }));

    // The progress panel appears while queued/processing…
    expect(await screen.findByRole('status')).toHaveTextContent(/Importing the statement/);

    // …and the poll re-reads the handle until it settles.
    await vi.waitFor(
      () => {
        expect(screen.getByText(/40 imported, 2 already present/)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(requestsTo('GET', IMPORT_PATH).length).toBeGreaterThanOrEqual(2);

    const [started] = requestsTo('POST', '/v1/bank-statement-imports');
    expect(started?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  /** A failed import shows its reason and says nothing was written (E1's all-or-nothing). */
  it('shows the reason when the import fails', async () => {
    const user = userEvent.setup();

    stub('POST', '/v1/bank-statement-imports/preview', () => json(200, preview()));
    stub('POST', '/v1/bank-statement-imports', () =>
      json(202, { id: IMPORT, bankAccountId: ACC, status: 'queued' }),
    );
    stub('GET', IMPORT_PATH, () =>
      json(
        200,
        importRow({
          status: 'failed',
          failureReason: 'Unexpected column count on line 12.',
        }),
      ),
    );

    renderScreen();
    await chooseAccount(user);
    await uploadCsv(user);
    await buildSignedMapping(user);

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Import' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The import could not be completed');
    expect(alert).toHaveTextContent('Unexpected column count on line 12.');
    expect(requestsTo('GET', IMPORT_PATH).length).toBeGreaterThanOrEqual(1);
  });
});
