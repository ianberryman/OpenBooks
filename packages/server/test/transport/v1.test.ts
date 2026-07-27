import { describe, expect, it } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER } from '../../src/transport/index';
import { errorBody } from './harness';
import {
  authorizedWrite,
  createAccount,
  idempotent,
  registerUser,
  useV1App,
  VALID_PASSWORD,
} from './v1-support';

/**
 * `/v1` end to end, against real MySQL.
 *
 * The first test in this file is **acceptance A1 — post a manual balanced journal via
 * REST** — and it is the point of OB-023. It is written as one narrative rather than
 * split into six cases on purpose: A1 is a claim about the *sequence* working, and six
 * independent tests each building their own fixtures would pass while the sequence a
 * real client has to follow did not.
 */

const harness = useV1App();

/** A cash sale: 1,500.00, as cents. */
const AMOUNT = '150000';

describe('A1 — post a manual balanced journal via REST', () => {
  it('registers, sets up a chart and a year, posts, and reads a balanced trial balance', async () => {
    const app = harness.app();

    // 1. Register. Creates the user, their first org, an Owner membership, and a
    //    session, and sets the cookie every later request rides on.
    const session = await registerUser(app, {
      email: 'a1@example.invalid',
      orgName: 'A1 Books',
    });

    // 2. The identity route agrees about who we are and where.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: session.cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { id: session.userId, email: 'a1@example.invalid' },
      activeOrgId: session.orgId,
      memberships: [{ org: { id: session.orgId, name: 'A1 Books' }, roleCode: 'owner' }],
    });

    // 3. Two accounts. `normalBalance` is required and independent of `type`.
    const cash = await createAccount(app, session, {
      code: '1000',
      name: 'Operating bank account',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });

    const chart = await app.inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: { cookie: session.cookie },
    });
    expect(chart.statusCode).toBe(200);
    // `items`, and ordered by creation rather than by code: since OB-031 every list
    // returns the shared page envelope, keyed on immutable columns (ROADMAP D-21).
    const page = chart.json<{ items: { code: string }[]; nextCursor: string | null }>();
    expect(page.items.map((a) => a.code)).toEqual(['1000', '4000']);
    expect(page.nextCursor).toBeNull();

    // 4. A fiscal year. Explicit, never a side effect of posting (ROADMAP D-17) — the
    //    posting in step 5 would be refused without this.
    const year = await app.inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(session, 'a1-year-2026'),
      payload: { fiscalYear: 2026 },
    });
    expect(year.statusCode).toBe(201);
    const generated = year.json<{
      fiscalYear: number;
      startMonth: number;
      startDate: string;
      endDate: string;
      periods: { name: string; status: string }[];
    }>();
    expect(generated).toMatchObject({
      fiscalYear: 2026,
      startMonth: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(generated.periods).toHaveLength(12);
    expect(generated.periods.every((period) => period.status === 'open')).toBe(true);

    // 5. Post the journal. Money goes out as a cents-only string (D-13).
    const posted = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: authorizedWrite(session, 'a1-journal-1'),
      payload: {
        date: '2026-03-31',
        memo: 'Cash sale',
        lines: [
          { accountId: cash, side: 'debit', amount: AMOUNT },
          { accountId: revenue, side: 'credit', amount: AMOUNT, memo: 'Invoice 1' },
        ],
      },
    });

    expect(posted.statusCode).toBe(201);
    const journal = posted.json<{
      journalId: string;
      orgId: string;
      date: string;
      memo: string | null;
      actorType: string;
      actorId: string;
      invocationMode: string | null;
      reversesJournalId: string | null;
      lines: { accountId: string; side: string; amount: unknown; memo: string | null }[];
    }>();

    expect(journal).toMatchObject({
      orgId: session.orgId,
      date: '2026-03-31',
      memo: 'Cash sale',
      // Provenance comes from the session, and the request never offered it.
      actorType: 'user',
      actorId: session.userId,
      // Null and not `'interactive'`: `chk_journals_invocation_mode` forbids the column
      // for a non-agent actor, so a route that forwarded a mode would fail the CHECK.
      invocationMode: null,
      reversesJournalId: null,
    });
    // `contactId` and `dimensionValueIds` are read back from the tables rather than
    // echoed (OB-059), so their absence here would mean the posting path silently
    // dropped what a draft carried — the defect that shipped in wave 2. Asserted as an
    // exact shape, so a field added to a posted line has to be looked at rather than
    // absorbed.
    expect(journal.lines).toEqual([
      {
        lineId: expect.any(String),
        accountId: cash,
        side: 'debit',
        amount: AMOUNT,
        memo: null,
        contactId: null,
        dimensionValueIds: [],
      },
      {
        lineId: expect.any(String),
        accountId: revenue,
        side: 'credit',
        amount: AMOUNT,
        memo: 'Invoice 1',
        contactId: null,
        dimensionValueIds: [],
      },
    ]);
    // D-13 on the way *out*, which is the half a schema alone would not catch: a JSON
    // number here is the precision loss the whole money design exists to prevent.
    for (const line of journal.lines) {
      expect(typeof line.amount).toBe('string');
    }

    // 6. The trial balance balances (A2, through the route).
    const trial = await app.inject({
      method: 'GET',
      url: '/v1/reports/trial-balance',
      headers: { cookie: session.cookie },
    });

    expect(trial.statusCode).toBe(200);
    expect(trial.json()).toEqual({
      asOf: null,
      totalDebits: AMOUNT,
      totalCredits: AMOUNT,
      difference: '0',
      rows: [
        {
          accountId: cash,
          code: '1000',
          name: 'Operating bank account',
          type: 'asset',
          normalBalance: 'debit',
          debits: AMOUNT,
          credits: '0',
          balance: AMOUNT,
        },
        {
          accountId: revenue,
          code: '4000',
          name: 'Sales',
          type: 'revenue',
          normalBalance: 'credit',
          debits: '0',
          credits: AMOUNT,
          balance: `-${AMOUNT}`,
        },
      ],
    });
  });
});

describe('idempotency at the boundary', () => {
  it('replays the original response without executing again', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'replay@example.invalid',
      orgName: 'Replay Books',
    });
    const cash = await createAccount(app, session, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(session, 'replay-year'),
      payload: { fiscalYear: 2026 },
    });

    const payload = {
      date: '2026-03-31',
      lines: [
        { accountId: cash, side: 'debit', amount: AMOUNT },
        { accountId: revenue, side: 'credit', amount: AMOUNT },
      ],
    };
    const headers = authorizedWrite(session, 'replay-the-same-key');

    const first = await app.inject({ method: 'POST', url: '/v1/journals', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/journals', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    /**
     * Deep equality, not byte equality. MySQL's `JSON` type normalizes on storage, so a
     * replayed object's keys may come back in a different order — no JSON consumer is
     * entitled to key order, and `src/modules/idempotency/response.ts` says so at the
     * line that decides it.
     */
    expect(second.json()).toEqual(first.json());

    // A8: exactly one journal. The replay returned a response without re-executing.
    const journals = await harness.db.app.selectFrom('journals').selectAll().execute();
    expect(journals).toHaveLength(1);
  });

  it('refuses the same key with a different request', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'conflict@example.invalid',
      orgName: 'Conflict Books',
    });
    const headers = authorizedWrite(session, 'one-key-two-requests');

    const first = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers,
      payload: { code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers,
      payload: { code: '4000', name: 'Sales', type: 'revenue', normalBalance: 'credit' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(errorBody(second.body).error.code).toBe('idempotency_key_conflict');
  });

  /**
   * The path id is part of the fingerprinted request, not only the body. Without that,
   * reusing a key against a *different* account would replay the first account's
   * response — the client would believe its second write happened.
   */
  it('treats the same key against a different resource as a conflict', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'paths@example.invalid',
      orgName: 'Paths Books',
    });
    const cash = await createAccount(app, session, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });
    const headers = authorizedWrite(session, 'one-key-two-accounts');

    expect(
      (await app.inject({ method: 'POST', url: `/v1/accounts/${cash}/deactivate`, headers }))
        .statusCode,
    ).toBe(200);

    const other = await app.inject({
      method: 'POST',
      url: `/v1/accounts/${revenue}/deactivate`,
      headers,
    });
    expect(other.statusCode).toBe(409);
    expect(errorBody(other.body).error.code).toBe('idempotency_key_conflict');
  });

  it('refuses an authenticated write with no key', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'nokey@example.invalid',
      orgName: 'No Key Books',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { cookie: session.cookie },
      payload: { code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorBody(response.body).error.details?.['issues']).toEqual([
      { path: IDEMPOTENCY_KEY_HEADER, message: 'must be set' },
    ]);
  });
});

/**
 * A7 — a cross-org read must be byte-for-byte indistinguishable from a genuine miss.
 *
 * `src/errors/` makes that true by construction (one class, one validated resource
 * token, no id echo) and `src/db/` makes the row unreachable. What this asserts is that
 * the whole route path preserves it: two orgs, one real id, one imaginary id, identical
 * bytes.
 */
describe('A7 through the routes', () => {
  it('answers a cross-org read exactly as it answers a nonexistent id', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'owner@example.invalid',
      orgName: 'Owner Books',
    });
    const stranger = await registerUser(app, {
      email: 'stranger@example.invalid',
      orgName: 'Stranger Books',
    });

    const account = await createAccount(app, owner, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/v1/accounts/${account}`,
      headers: { cookie: stranger.cookie },
    });
    const nonexistent = await app.inject({
      method: 'GET',
      url: '/v1/accounts/f47ac10b-58cc-4372-a567-0e02b2c3d479',
      headers: { cookie: stranger.cookie },
    });

    expect(crossOrg.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(crossOrg.body).toBe(nonexistent.body);
    expect(crossOrg.headers['content-type']).toBe(nonexistent.headers['content-type']);
    // And it does not echo the id it was asked about.
    expect(crossOrg.body).not.toContain(account);
  });

  it('switches to another org rather than reading it, and refuses one that is not ours', async () => {
    const app = harness.app();
    const owner = await registerUser(app, { email: 'sw1@example.invalid', orgName: 'Mine' });
    const stranger = await registerUser(app, { email: 'sw2@example.invalid', orgName: 'Theirs' });

    const refused = await app.inject({
      method: 'POST',
      url: '/v1/orgs/active',
      headers: authorizedWrite(stranger, 'switch-to-someone-elses'),
      payload: { orgId: owner.orgId },
    });
    expect(refused.statusCode).toBe(404);
    expect(errorBody(refused.body).error.code).toBe('not_found');

    // Their own org still switches, so the 404 above is about membership and not about
    // the route being broken.
    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/orgs/active',
      headers: authorizedWrite(stranger, 'switch-to-mine'),
      payload: { orgId: stranger.orgId },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ org: { id: stranger.orgId }, roleCode: 'owner' });
  });
});

/**
 * D-13 — money on the wire is a cents-only string, and a decimal amount is a
 * `validation_failed`.
 *
 * Asserted with a session because `requireOrgScope` refuses an unauthenticated caller
 * before the body is parsed. Each case is one the money module refuses by name; the
 * important part is the *status*: reaching the handler and throwing `MoneyParseError` —
 * which is not an `OpenBooksError` — would surface as an opaque 500 blaming the server
 * for a request it should have refused.
 */
describe('money on the wire', () => {
  it.each([
    { kind: 'a decimal amount', amount: '1500.00' },
    { kind: 'a fractional amount', amount: '1.5' },
    { kind: 'exponent notation', amount: '1e5' },
    { kind: 'an explicit plus sign', amount: '+150000' },
    { kind: 'a leading zero', amount: '01500' },
    { kind: 'a JSON number', amount: 150000 },
    { kind: 'thousands separators', amount: '150,000' },
    { kind: 'an empty string', amount: '' },
    { kind: 'a value past the storable BIGINT range', amount: '99999999999999999999' },
  ])('rejects $kind with validation_failed naming the line', async ({ amount }) => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'money@example.invalid',
      orgName: 'Money Books',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: authorizedWrite(session, `money-${String(amount)}`),
      payload: {
        date: '2026-03-31',
        lines: [
          { accountId: session.userId, side: 'debit', amount },
          { accountId: session.userId, side: 'credit', amount },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = errorBody(response.body);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.['issues']).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'lines.0.amount' })]),
    );
  });

  it('reports the storable range rather than an opaque refusal', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'range@example.invalid',
      orgName: 'Range Books',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: authorizedWrite(session, 'money-range'),
      payload: {
        date: '2026-03-31',
        lines: [
          { accountId: session.userId, side: 'debit', amount: '99999999999999999999' },
          { accountId: session.userId, side: 'credit', amount: '99999999999999999999' },
        ],
      },
    });

    // The message is `fromMinorString`'s own, so the schema and the money module cannot
    // disagree about why a value was refused.
    expect(response.body).toContain('storable range');
  });
});

/**
 * A4 through the route surface. The kernel and the periods service own the rule; this
 * asserts that the HTTP path reports it as a `precondition_failed` rather than as a 500
 * or a silent success.
 */
describe('A4 — posting to a locked period is rejected', () => {
  it('answers precondition_failed once the period is closed', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'locked@example.invalid',
      orgName: 'Locked Books',
    });
    const cash = await createAccount(app, session, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });

    await app.inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(session, 'locked-year'),
      payload: { fiscalYear: 2026 },
    });

    const periods = await app.inject({
      method: 'GET',
      url: '/v1/fiscal-periods?status=open',
      headers: { cookie: session.cookie },
    });
    expect(periods.statusCode).toBe(200);
    const march = periods
      .json<{ periods: { id: string; startDate: string }[] }>()
      .periods.find((period) => period.startDate === '2026-03-01');
    expect(march).toBeDefined();

    const closed = await app.inject({
      method: 'POST',
      url: `/v1/fiscal-periods/${march?.id ?? ''}/close`,
      headers: authorizedWrite(session, 'locked-close'),
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'closed', closedByUserId: session.userId });

    const refused = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: authorizedWrite(session, 'locked-post'),
      payload: {
        date: '2026-03-31',
        lines: [
          { accountId: cash, side: 'debit', amount: AMOUNT },
          { accountId: revenue, side: 'credit', amount: AMOUNT },
        ],
      },
    });

    expect(refused.statusCode).toBe(412);
    expect(errorBody(refused.body).error.code).toBe('precondition_failed');

    // And nothing was written: A9's "no half-written journal", from the outside.
    expect(await harness.db.app.selectFrom('journals').selectAll().execute()).toEqual([]);

    // Reopening it makes the same posting land, so the refusal was about the period.
    const reopened = await app.inject({
      method: 'POST',
      url: `/v1/fiscal-periods/${march?.id ?? ''}/reopen`,
      headers: authorizedWrite(session, 'locked-reopen'),
      payload: {},
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ status: 'open', closedAt: null });
  });
});

/** The reversal path, and the statuses and `Location` the ticket asks for. */
describe('status codes and headers', () => {
  it('creates with 201 and points Location at the created account', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'created@example.invalid',
      orgName: 'Created Books',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: authorizedWrite(session, 'created-account'),
      payload: { code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    });

    expect(response.statusCode).toBe(201);
    const account = response.json<{ id: string }>();
    expect(response.headers['location']).toBe(`/v1/accounts/${account.id}`);

    // And the Location actually resolves.
    const followed = await app.inject({
      method: 'GET',
      url: String(response.headers['location']),
      headers: { cookie: session.cookie },
    });
    expect(followed.statusCode).toBe(200);
    expect(followed.json()).toEqual(account);
  });

  it('answers 204 with no body on logout, and clears the cookie', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'bye@example.invalid',
      orgName: 'Bye Books',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: authorizedWrite(session, 'bye-logout'),
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.cookies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ob_session', value: '' })]),
    );

    // The revocation, not just the cookie: the token no longer authenticates.
    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: session.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('logs out cleanly with no session at all', async () => {
    // A stale cookie is the ordinary case for this call, and no cookie is the same case
    // one step further on. Neither is a 404.
    const response = await harness.app().inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: idempotent('bye-nobody'),
    });

    expect(response.statusCode).toBe(204);
  });

  it('reverses a journal with 201 and inverted lines', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'reverse@example.invalid',
      orgName: 'Reverse Books',
    });
    const cash = await createAccount(app, session, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(session, 'reverse-year'),
      payload: { fiscalYear: 2026 },
    });

    const posted = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: authorizedWrite(session, 'reverse-original'),
      payload: {
        date: '2026-03-31',
        lines: [
          { accountId: cash, side: 'debit', amount: AMOUNT },
          { accountId: revenue, side: 'credit', amount: AMOUNT },
        ],
      },
    });
    expect(posted.statusCode).toBe(201);
    const original = posted.json<{ journalId: string }>();

    const reversal = await app.inject({
      method: 'POST',
      url: `/v1/journals/${original.journalId}/reverse`,
      headers: authorizedWrite(session, 'reverse-it'),
      payload: { date: '2026-04-30' },
    });

    expect(reversal.statusCode).toBe(201);
    const reversed = reversal.json<{
      journalId: string;
      reversesJournalId: string | null;
      date: string;
      lines: { accountId: string; side: string; amount: string }[];
    }>();
    expect(reversed.reversesJournalId).toBe(original.journalId);
    expect(reversed.journalId).not.toBe(original.journalId);
    expect(reversed.date).toBe('2026-04-30');
    expect(reversed.lines).toEqual([
      expect.objectContaining({ accountId: cash, side: 'credit', amount: AMOUNT }),
      expect.objectContaining({ accountId: revenue, side: 'debit', amount: AMOUNT }),
    ]);

    /**
     * The books are flat again, which is the whole reason a reversal is an insert
     * rather than a deletion: every account now carries the original amount on both
     * sides, so the totals *double* and each balance is zero. A delete would have made
     * the totals go back down and left no trace that anything had happened.
     */
    const trial = await app.inject({
      method: 'GET',
      url: '/v1/reports/trial-balance',
      headers: { cookie: session.cookie },
    });
    expect(trial.json()).toMatchObject({ totalDebits: '300000', totalCredits: '300000' });
    expect(
      trial.json<{ rows: { balance: string }[] }>().rows.every((row) => row.balance === '0'),
    ).toBe(true);
  });

  it('rejects an unbalanced journal (A3) as validation_failed', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'unbalanced@example.invalid',
      orgName: 'Unbalanced Books',
    });
    const cash = await createAccount(app, session, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenue = await createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/fiscal-years',
      headers: authorizedWrite(session, 'unbalanced-year'),
      payload: { fiscalYear: 2026 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: authorizedWrite(session, 'unbalanced-post'),
      payload: {
        date: '2026-03-31',
        lines: [
          { accountId: cash, side: 'debit', amount: AMOUNT },
          { accountId: revenue, side: 'credit', amount: '1' },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(errorBody(response.body).error.code).toBe('validation_failed');
    expect(await harness.db.app.selectFrom('journals').selectAll().execute()).toEqual([]);
  });
});

describe('login and the org menu', () => {
  it('logs a registered user back in and reports the same identity', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'again@example.invalid',
      orgName: 'Again Books',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: idempotent('login-again'),
      payload: { email: 'again@example.invalid', password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: session.userId },
      activeOrgId: session.orgId,
    });
    expect(response.cookies.some((cookie) => cookie.name === 'ob_session')).toBe(true);
  });

  it('answers unauthenticated for a wrong password, with no detail', async () => {
    const app = harness.app();
    await registerUser(app, { email: 'wrong@example.invalid', orgName: 'Wrong Books' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: idempotent('login-wrong'),
      payload: { email: 'wrong@example.invalid', password: 'not the password at all' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'unauthenticated', message: 'Authentication required.' },
    });
  });

  it('lists both orgs after a second one is created', async () => {
    const app = harness.app();
    const session = await registerUser(app, { email: 'two@example.invalid', orgName: 'First' });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: authorizedWrite(session, 'second-org'),
      payload: { name: 'Second', fiscalYearStartMonth: 4 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      org: { name: 'Second', slug: 'second', fiscalYearStartMonth: 4 },
      roleCode: 'owner',
    });

    const list = await app.inject({
      method: 'GET',
      url: '/v1/orgs',
      headers: { cookie: session.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json<{ memberships: { org: { name: string } }[] }>()
        .memberships.map((membership) => membership.org.name)
        .sort(),
    ).toEqual(['First', 'Second']);
  });
});
