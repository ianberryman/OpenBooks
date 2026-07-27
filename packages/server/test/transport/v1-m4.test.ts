import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorBody } from './harness';
import { authorizedWrite, createAccount, registerUser, useV1App } from './v1-support';
import type { Session } from './v1-support';
import { silentLogger } from '../banking/support';
import { InProcessQueue, setQueueProvider } from '../../src/providers';
import type { App } from '../../src/transport/index';

/**
 * OB-084's banking routes, end to end against real MySQL.
 *
 * The banking services have deep suites of their own — the dedupe, the clearing
 * equation, the reconciliation balances, the concurrency. What is unproven until a
 * route exists is the *boundary*, so these are transport cases: the mapping reaching the
 * right service, a querystring's text becoming the value the service takes, the async
 * import answering `202` with a queued handle rather than blocking, and a cross-org read
 * being a `404` and not a `403`. The `Idempotency-Key`-on-every-write rule and the
 * unauthenticated `401` are proven for all 25 operations in `routes.test.ts`, enumerated
 * from the published document, so they are not repeated here.
 */

const harness = useV1App();

/**
 * A queue with no import handler in this process. `startBankStatementImport` enqueues
 * and returns; the job is dropped (and logged, harmlessly) because the worker that
 * consumes it is a different process (D-49). Installing it here also keeps
 * `queueProvider()` from reaching for a process config these route tests never load —
 * the same seam `import.service.test.ts` drives.
 */
beforeAll(() => {
  setQueueProvider(new InProcessQueue(silentLogger));
});

afterAll(() => {
  setQueueProvider(undefined);
});

const MAPPING_DEFINITION = {
  hasHeaderRow: true,
  delimiter: ',',
  dateOrder: 'dmy',
  amountConvention: 'signed',
  columns: {
    postedDate: 0,
    description: 1,
    amount: 2,
    debit: null,
    credit: null,
    valueDate: null,
    counterparty: null,
    bankReference: null,
  },
} as const;

const STATEMENT_CSV =
  'date,description,amount\n31/03/2026,COFFEE SHOP,-4.50\n02/04/2026,SALARY,2000.00\n';

interface BankAccountBody {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly feedSource: string;
  readonly isActive: boolean;
}

/**
 * An org with one ledger account registered as a bank account. Built entirely through
 * `/v1`, so the routes under test are what set the fixtures up.
 */
async function setUpBank(
  app: App,
  slug: string,
): Promise<{
  readonly session: Session;
  readonly ledgerAccountId: string;
  readonly bankAccountId: string;
}> {
  const session = await registerUser(app, {
    email: `${slug}@example.invalid`,
    orgName: `${slug} Books`,
  });

  const ledgerAccountId = await createAccount(app, session, {
    code: '1000',
    name: 'Bank',
    type: 'asset',
    normalBalance: 'debit',
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/bank-accounts',
    headers: authorizedWrite(session, `bank-${slug}`),
    payload: { accountId: ledgerAccountId, name: 'Barclays Current', institutionName: 'Barclays' },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `register bank account failed: ${String(response.statusCode)} ${response.body}`,
    );
  }

  return { session, ledgerAccountId, bankAccountId: response.json<BankAccountBody>().id };
}

describe('bank accounts', () => {
  it('registers a bank account, reads it back, and lists it', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'bank-crud@example.invalid',
      orgName: 'Bank CRUD',
    });
    const ledgerAccountId = await createAccount(app, session, {
      code: '1000',
      name: 'Bank',
      type: 'asset',
      normalBalance: 'debit',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/bank-accounts',
      headers: authorizedWrite(session, 'bank-1'),
      payload: { accountId: ledgerAccountId, name: 'Barclays Current' },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json<BankAccountBody>();
    expect(body).toMatchObject({
      accountId: ledgerAccountId,
      name: 'Barclays Current',
      feedSource: 'file',
      isActive: true,
    });
    // The `Location` a client follows to the resource it just created.
    expect(created.headers.location).toBe(`/v1/bank-accounts/${body.id}`);

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/bank-accounts/${body.id}`,
      headers: { cookie: session.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<BankAccountBody>().id).toBe(body.id);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/bank-accounts',
      headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json<{ items: BankAccountBody[]; nextCursor: string | null }>();
    expect(page.items.map((item) => item.id)).toContain(body.id);
  });

  it('404s a register that names no ledger account', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'bank-noacct@example.invalid',
      orgName: 'Bank NoAcct',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bank-accounts',
      headers: authorizedWrite(session, 'bank-noacct'),
      payload: { accountId: '00000000-0000-4000-8000-000000000009', name: 'Nowhere' },
    });

    expect(response.statusCode).toBe(404);
    expect(errorBody(response.body).error.code).toBe('not_found');
  });

  it('is a 404, not a 403, across orgs', async () => {
    const app = harness.app();
    const owner = await setUpBank(app, 'bank-owner');
    const stranger = await registerUser(app, {
      email: 'bank-stranger@example.invalid',
      orgName: 'Bank Stranger',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/bank-accounts/${owner.bankAccountId}`,
      headers: { cookie: stranger.cookie },
    });

    // A cross-org read is byte-identical to a read of something that never existed (A7).
    expect(response.statusCode).toBe(404);
    expect(errorBody(response.body).error.code).toBe('not_found');
  });
});

describe('statement imports', () => {
  it('previews an import synchronously', async () => {
    const app = harness.app();
    const bank = await setUpBank(app, 'preview');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bank-statement-imports/preview',
      headers: authorizedWrite(bank.session, 'preview-1'),
      payload: {
        bankAccountId: bank.bankAccountId,
        format: 'csv',
        filename: 'march.csv',
        content: STATEMENT_CSV,
        mapping: MAPPING_DEFINITION,
      },
    });

    expect(response.statusCode).toBe(200);
    const preview = response.json<{
      result: { linesRead: number; linesImported: number; linesDuplicate: number };
      sample: unknown[];
    }>();
    expect(preview.result.linesRead).toBe(2);
    expect(preview.result.linesImported).toBe(2);
    expect(preview.sample).toHaveLength(2);
  });

  it('starts an import and answers 202 with a queued handle', async () => {
    const app = harness.app();
    const bank = await setUpBank(app, 'start');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bank-statement-imports',
      headers: authorizedWrite(bank.session, 'start-1'),
      payload: {
        bankAccountId: bank.bankAccountId,
        format: 'csv',
        filename: 'march.csv',
        content: STATEMENT_CSV,
        mapping: MAPPING_DEFINITION,
        saveMappingAs: 'Barclays',
      },
    });

    // A 202-style create: the parse is enqueued, not run in the request (D-47, E10).
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      id: expect.any(String),
      bankAccountId: bank.bankAccountId,
      status: 'queued',
    });
  });

  it('polls a started import, lists it, and 404s it across orgs', async () => {
    const app = harness.app();
    const bank = await setUpBank(app, 'poll');

    const started = await app.inject({
      method: 'POST',
      url: '/v1/bank-statement-imports',
      headers: authorizedWrite(bank.session, 'poll-start'),
      payload: {
        bankAccountId: bank.bankAccountId,
        format: 'csv',
        filename: 'march.csv',
        content: STATEMENT_CSV,
        mapping: MAPPING_DEFINITION,
      },
    });
    expect(started.statusCode).toBe(202);
    const importId = started.json<{ id: string }>().id;

    // The test queue has no handler, so the import stays `queued` — which is exactly the
    // lifecycle stage a poll must be able to represent: no `result`, no `failureReason`.
    const polled = await app.inject({
      method: 'GET',
      url: `/v1/bank-statement-imports/${importId}`,
      headers: { cookie: bank.session.cookie },
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json<Record<string, unknown>>()).toMatchObject({
      id: importId,
      bankAccountId: bank.bankAccountId,
      status: 'queued',
      result: null,
      failureReason: null,
    });

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/bank-statement-imports?bankAccountId=${bank.bankAccountId}`,
      headers: { cookie: bank.session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(
      importId,
    );

    const stranger = await registerUser(app, {
      email: 'poll-stranger@example.invalid',
      orgName: 'Poll Stranger',
    });
    const crossOrg = await app.inject({
      method: 'GET',
      url: `/v1/bank-statement-imports/${importId}`,
      headers: { cookie: stranger.cookie },
    });
    expect(crossOrg.statusCode).toBe(404);
    expect(errorBody(crossOrg.body).error.code).toBe('not_found');
  });
});

describe('statement lines', () => {
  it('lists an account with no lines as an empty page', async () => {
    const app = harness.app();
    const bank = await setUpBank(app, 'lines-empty');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/statement-lines?bankAccountId=${bank.bankAccountId}&cleared=false`,
      headers: { cookie: bank.session.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });
});

describe('bank rules', () => {
  it('creates a rule, reads it back, and 404s it across orgs', async () => {
    const app = harness.app();
    const bank = await setUpBank(app, 'rule');
    const codingAccount = await createAccount(app, bank.session, {
      code: '6000',
      name: 'Entertainment',
      type: 'expense',
      normalBalance: 'debit',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/bank-rules',
      headers: authorizedWrite(bank.session, 'rule-1'),
      payload: {
        name: 'Coffee is entertaining',
        condition: { description: { mode: 'contains', value: 'COFFEE SHOP' } },
        outcome: { accountId: codingAccount },
      },
    });

    expect(created.statusCode).toBe(201);
    const rule = created.json<{ id: string; priority: number; isActive: boolean }>();
    expect(rule.isActive).toBe(true);
    expect(created.headers.location).toBe(`/v1/bank-rules/${rule.id}`);

    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/bank-rules/${rule.id}`,
      headers: { cookie: bank.session.cookie },
    });
    expect(fetched.statusCode).toBe(200);

    const stranger = await registerUser(app, {
      email: 'rule-stranger@example.invalid',
      orgName: 'Rule Stranger',
    });
    const crossOrg = await app.inject({
      method: 'GET',
      url: `/v1/bank-rules/${rule.id}`,
      headers: { cookie: stranger.cookie },
    });
    expect(crossOrg.statusCode).toBe(404);
    expect(errorBody(crossOrg.body).error.code).toBe('not_found');
  });
});

describe('reconciliation sessions', () => {
  it('opens a session against a bank account', async () => {
    const app = harness.app();
    const bank = await setUpBank(app, 'recon');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation-sessions',
      headers: authorizedWrite(bank.session, 'recon-1'),
      payload: {
        bankAccountId: bank.bankAccountId,
        endDate: '2026-03-31',
        statementClosingBalance: '0',
      },
    });

    expect(response.statusCode).toBe(201);
    const session = response.json<{
      id: string;
      state: string;
      balances: { statementClosingBalance: string; difference: string };
      events: { type: string }[];
    }>();
    expect(session.state).toBe('open');
    expect(session.balances.statementClosingBalance).toBe('0');
    expect(session.events.map((event) => event.type)).toContain('opened');
    expect(response.headers.location).toBe(`/v1/reconciliation-sessions/${session.id}`);
  });
});
