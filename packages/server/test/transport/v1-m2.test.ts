import { describe, expect, it } from 'vitest';

import { captureEmail, tokenFrom } from '../members/support';
import { errorBody } from './harness';
import { authorizedWrite, createAccount, registerUser, useV1App } from './v1-support';
import type { Session } from './v1-support';
import type { App } from '../../src/transport/index';

/**
 * OB-045's routes, end to end against real MySQL.
 *
 * The services underneath already have deep suites — balances, tagging, the
 * last-Owner rule, the draft row lock. What is unproven until a route exists is the
 * *boundary*: whether the mapping reaches the right service with the right
 * arguments, whether a querystring's text becomes the value the service takes,
 * whether a status and a `Location` are what the ticket says, and whether an
 * idempotency claim is scoped where the table above `registerV1Routes` claims it is.
 * So the cases below are transport cases. A test here that could be written against
 * the service alone belongs there instead.
 *
 * Two of them are not: the report filter is a format this ticket invented (JSON in a
 * query parameter) and exists nowhere else, and the general ledger's page shape is a
 * decision this ticket made against D-21's envelope. Both are asserted here because
 * here is where they are true.
 */

const harness = useV1App();

/**
 * The real `log` email adapter over a capture stream, installed for this file.
 *
 * Not a mock (spec §11): the invite test below reads its token out of the message
 * the system actually produced, which is also the only place the token exists — the
 * service never returns it and the row holds a hash. `test/members/support.ts` owns
 * this helper and explains why it builds the adapter through the real provider
 * selection rather than constructing one.
 */
const email = captureEmail();

describe('contacts', () => {
  it('creates with 201 and a Location, then reads, patches, deactivates and deletes', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'contacts@example.invalid',
      orgName: 'Contacts Books',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: authorizedWrite(session, 'contact-1'),
      payload: { code: 'ACME', displayName: 'Acme Supplies', isVendor: true },
    });
    expect(created.statusCode).toBe(201);
    const contact = created.json<{ id: string }>();
    expect(created.headers['location']).toBe(`/v1/contacts/${contact.id}`);
    expect(created.json()).toMatchObject({
      code: 'ACME',
      displayName: 'Acme Supplies',
      isCustomer: false,
      isVendor: true,
      isActive: true,
    });

    const read = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${contact.id}`,
      headers: { cookie: session.cookie },
    });
    expect(read.statusCode).toBe(200);

    // `code` is mutable here and immutable on an account (against D-27, deliberately).
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/contacts/${contact.id}`,
      headers: authorizedWrite(session, 'contact-1-patch'),
      payload: { code: 'ACME-2', legalName: 'Acme Supplies Limited' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ code: 'ACME-2', legalName: 'Acme Supplies Limited' });

    const deactivated = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${contact.id}/deactivate`,
      headers: authorizedWrite(session, 'contact-1-off'),
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ isActive: false });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${contact.id}`,
      headers: authorizedWrite(session, 'contact-1-delete'),
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
  });

  /**
   * The reason `listContactsQuerySchema` takes real booleans and the route coerces:
   * `'false'` is truthy in every language an integrator might use, so a shared schema
   * that accepted it would accept it from a JSON body too. If the coercion were
   * missing this would return the vendor as well.
   */
  it('coerces a false query-string flag rather than treating it as truthy', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'filters@example.invalid',
      orgName: 'Filter Books',
    });

    for (const [key, flags] of [
      ['cust', { isCustomer: true }],
      ['vend', { isVendor: true }],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/contacts',
        headers: authorizedWrite(session, `contact-${key}`),
        payload: { displayName: key, ...flags },
      });
      expect(response.statusCode).toBe(201);
    }

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/contacts?isCustomer=false&limit=10',
      headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json<{ items: { displayName: string }[]; nextCursor: string | null }>();
    expect(page.items.map((item) => item.displayName)).toEqual(['vend']);
    expect(page.nextCursor).toBeNull();
  });

  /** A7 on a resource this ticket added: cross-org and nonexistent are byte-identical. */
  it('answers a cross-org read exactly as it answers a nonexistent id', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'c-owner@example.invalid',
      orgName: 'C Owner',
    });
    const stranger = await registerUser(app, {
      email: 'c-stranger@example.invalid',
      orgName: 'C Stranger',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/contacts',
      headers: authorizedWrite(owner, 'a7-contact'),
      payload: { displayName: 'Private' },
    });
    const { id } = created.json<{ id: string }>();

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${id}`,
      headers: { cookie: stranger.cookie },
    });
    const nonexistent = await app.inject({
      method: 'GET',
      url: '/v1/contacts/f47ac10b-58cc-4372-a567-0e02b2c3d479',
      headers: { cookie: stranger.cookie },
    });

    expect(crossOrg.statusCode).toBe(404);
    expect(crossOrg.body).toBe(nonexistent.body);
    expect(crossOrg.body).not.toContain(id);
  });
});

describe('dimensions', () => {
  it('creates an axis and a value, lists both, and archives rather than deletes in use', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'dims@example.invalid',
      orgName: 'Dimension Books',
    });

    const axis = await createDimension(app, session, 'DEPT', 'Department');
    const value = await createDimensionValue(app, session, axis, 'SALES', 'Sales team');

    const axes = await app.inject({
      method: 'GET',
      url: '/v1/dimensions',
      headers: { cookie: session.cookie },
    });
    expect(axes.json<{ items: { code: string }[] }>().items.map((a) => a.code)).toEqual(['DEPT']);

    const values = await app.inject({
      method: 'GET',
      url: `/v1/dimensions/${axis}/values`,
      headers: { cookie: session.cookie },
    });
    expect(values.json<{ items: { id: string }[] }>().items.map((v) => v.id)).toEqual([value]);

    // The value is reachable flat, without naming its axis — the asymmetry the route
    // file argues for, because the service takes the value id alone.
    const one = await app.inject({
      method: 'GET',
      url: `/v1/dimension-values/${value}`,
      headers: { cookie: session.cookie },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ dimensionId: axis, code: 'SALES' });

    // An axis with values cannot be deleted; archiving is what it has instead.
    const refused = await app.inject({
      method: 'DELETE',
      url: `/v1/dimensions/${axis}`,
      headers: authorizedWrite(session, 'delete-axis-in-use'),
    });
    expect(refused.statusCode).toBe(412);
    expect(errorBody(refused.body).error.code).toBe('precondition_failed');

    const archived = await app.inject({
      method: 'POST',
      url: `/v1/dimensions/${axis}/archive`,
      headers: authorizedWrite(session, 'archive-axis'),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ isActive: false });
  });

  /**
   * The retag route, which is the only write in this API that touches anything
   * hanging off a posted journal. It proves the `PUT` reaches the service with the
   * line id from the path, and that the amounts did not move — retagging is an
   * analysis change and the trial balance is the oracle that says so.
   */
  it('retags a posted line through PUT without moving an amount', async () => {
    const app = harness.app();
    const scene = await ledgerScene(app, 'retag@example.invalid', 'Retag Books');
    const axis = await createDimension(app, scene.session, 'DEPT', 'Department');
    const sales = await createDimensionValue(app, scene.session, axis, 'SALES', 'Sales');

    const before = await trialBalance(app, scene.session);

    const lineId = scene.lines[0]?.lineId;
    expect(lineId).toBeDefined();

    const tagged = await app.inject({
      method: 'PUT',
      url: `/v1/journal-lines/${String(lineId)}/dimensions`,
      headers: authorizedWrite(scene.session, 'retag-1'),
      payload: { valueIds: [sales] },
    });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json()).toEqual({
      dimensions: [{ lineId: String(lineId), dimensionId: axis, dimensionValueId: sales }],
    });

    const read = await app.inject({
      method: 'GET',
      url: `/v1/journal-lines/${String(lineId)}/dimensions`,
      headers: { cookie: scene.session.cookie },
    });
    expect(read.json()).toEqual(tagged.json());

    // An empty list clears every tag, which is the spelling this shape gives to
    // untagging — there is no second operation for it.
    const cleared = await app.inject({
      method: 'PUT',
      url: `/v1/journal-lines/${String(lineId)}/dimensions`,
      headers: authorizedWrite(scene.session, 'retag-2'),
      payload: { valueIds: [] },
    });
    expect(cleared.json()).toEqual({ dimensions: [] });

    expect(await trialBalance(app, scene.session)).toEqual(before);
  });

  /**
   * A7 again, and the case the route file's comment is about: the line id is not a
   * uuid, so a malformed one could easily have become a `400`. The service routes it
   * to the same 404 a nonexistent line gets, and the route must not undo that.
   */
  it('answers a malformed line id exactly as it answers a missing one', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'lineid@example.invalid',
      orgName: 'Line Id Books',
    });

    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/journal-lines/not-a-number/dimensions',
      headers: { cookie: session.cookie },
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/journal-lines/999999999/dimensions',
      headers: { cookie: session.cookie },
    });

    expect(malformed.statusCode).toBe(404);
    expect(malformed.body).toBe(missing.body);
  });
});

describe('journal drafts', () => {
  /**
   * B5 through the routes: a draft is freely editable, posting it is the only path
   * to the ledger, and it happens exactly once.
   */
  it('creates an empty draft, fills it in, posts it, and replays the post', async () => {
    const app = harness.app();
    const scene = await ledgerScene(app, 'drafts@example.invalid', 'Draft Books', {
      post: false,
    });

    // Nothing is required. This is what a "New entry" button produces.
    const created = await app.inject({
      method: 'POST',
      url: '/v1/journal-drafts',
      headers: authorizedWrite(scene.session, 'draft-1'),
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ id: string; entryDate: string | null; lines: unknown[] }>();
    expect(created.headers['location']).toBe(`/v1/journal-drafts/${draft.id}`);
    expect(draft).toMatchObject({ entryDate: null, lines: [] });

    const filled = await app.inject({
      method: 'PATCH',
      url: `/v1/journal-drafts/${draft.id}`,
      headers: authorizedWrite(scene.session, 'draft-1-fill'),
      payload: {
        entryDate: '2026-03-31',
        memo: 'Cash sale',
        lines: [
          { accountId: scene.cash, side: 'debit', amount: '150000' },
          { accountId: scene.revenue, side: 'credit', amount: '150000' },
        ],
      },
    });
    expect(filled.statusCode).toBe(200);
    expect(filled.json<{ lines: unknown[] }>().lines).toHaveLength(2);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/journal-drafts',
      headers: { cookie: scene.session.cookie },
    });
    // Headers only: the list carries no lines, so a page's size does not depend on
    // how many lines an org's drafts happen to hold.
    expect(listed.json<{ items: Record<string, unknown>[] }>().items).toEqual([
      expect.not.objectContaining({ lines: expect.anything() }),
    ]);

    const posted = await app.inject({
      method: 'POST',
      url: `/v1/journal-drafts/${draft.id}/post`,
      headers: authorizedWrite(scene.session, 'draft-1-post'),
    });
    expect(posted.statusCode).toBe(201);
    const journal = posted.json<{ journalId: string; sequenceNumber: unknown }>();
    expect(journal.journalId).toBeDefined();
    // The actor is the caller, not the draft's author — who posted is the fact an
    // auditor asks about.
    expect(posted.json()).toMatchObject({ actorType: 'user', actorId: scene.session.userId });

    // The draft is gone: posting and discarding are one transaction (D-19).
    const afterPost = await app.inject({
      method: 'GET',
      url: `/v1/journal-drafts/${draft.id}`,
      headers: { cookie: scene.session.cookie },
    });
    expect(afterPost.statusCode).toBe(404);

    // The same key replays the original response rather than posting again — and a
    // second journal would be visible in the list, which it is not.
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/journal-drafts/${draft.id}/post`,
      headers: authorizedWrite(scene.session, 'draft-1-post'),
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(posted.json());

    const journals = await app.inject({
      method: 'GET',
      url: '/v1/journals',
      headers: { cookie: scene.session.cookie },
    });
    expect(journals.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  /**
   * The claim is keyed on the draft, so the same key against a *different* draft is a
   * conflict rather than the first draft's journal. Without the path id in the
   * fingerprint this would answer 201 with the wrong journal — the failure the
   * routes' header block calls out.
   */
  it('treats one key reused against another draft as a conflict', async () => {
    const app = harness.app();
    const scene = await ledgerScene(app, 'draft-keys@example.invalid', 'Draft Key Books', {
      post: false,
    });

    const ids: string[] = [];
    for (const label of ['a', 'b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/journal-drafts',
        headers: authorizedWrite(scene.session, `draft-${label}`),
        payload: {
          entryDate: '2026-03-31',
          lines: [
            { accountId: scene.cash, side: 'debit', amount: '100' },
            { accountId: scene.revenue, side: 'credit', amount: '100' },
          ],
        },
      });
      ids.push(response.json<{ id: string }>().id);
    }

    const first = await app.inject({
      method: 'POST',
      url: `/v1/journal-drafts/${String(ids[0])}/post`,
      headers: authorizedWrite(scene.session, 'shared-post-key'),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/journal-drafts/${String(ids[1])}/post`,
      headers: authorizedWrite(scene.session, 'shared-post-key'),
    });
    expect(second.statusCode).toBe(409);
    expect(errorBody(second.body).error.code).toBe('idempotency_key_conflict');
  });

  it('discards a draft with 204, leaving the ledger untouched', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'discard@example.invalid',
      orgName: 'Discard Books',
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/journal-drafts',
      headers: authorizedWrite(session, 'discard-draft'),
      payload: { memo: 'Never mind' },
    });
    const { id } = created.json<{ id: string }>();

    const discarded = await app.inject({
      method: 'DELETE',
      url: `/v1/journal-drafts/${id}`,
      headers: authorizedWrite(session, 'discard-draft-do'),
    });
    expect(discarded.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/journal-drafts/${id}`,
      headers: { cookie: session.cookie },
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('members, roles and invitations', () => {
  it('lists the founder as Owner and the six seeded roles', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'members@example.invalid',
      orgName: 'Member Books',
    });

    const members = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: { cookie: session.cookie },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json<{ members: unknown[] }>().members).toEqual([
      expect.objectContaining({ userId: session.userId, roleCode: 'owner', isActive: true }),
    ]);

    const roles = await app.inject({
      method: 'GET',
      url: '/v1/roles',
      headers: { cookie: session.cookie },
    });
    expect(roles.statusCode).toBe(200);
    const codes = roles.json<{ roles: { code: string }[] }>().roles.map((role) => role.code);
    expect(codes).toContain('owner');
    expect(codes).toContain('bookkeeper');
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * The invite lifecycle over HTTP, and the two things about it that are transport
   * decisions: the token is never in a response, and accepting is a *global* claim
   * because the accepting caller is not scoped to the org they are joining.
   */
  it('invites, lists, and accepts — and never returns the token', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'inviter@example.invalid',
      orgName: 'Invite Books',
    });
    const guest = await registerUser(app, {
      email: 'guest@example.invalid',
      orgName: 'Guest Books',
    });

    const roles = await app.inject({
      method: 'GET',
      url: '/v1/roles',
      headers: { cookie: owner.cookie },
    });
    const bookkeeper = roles
      .json<{ roles: { id: string; code: string }[] }>()
      .roles.find((role) => role.code === 'bookkeeper');
    expect(bookkeeper).toBeDefined();

    const invited = await app.inject({
      method: 'POST',
      url: '/v1/invites',
      headers: authorizedWrite(owner, 'invite-guest'),
      payload: { email: 'guest@example.invalid', roleId: bookkeeper?.id },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({
      invitation: { email: 'guest@example.invalid', status: 'pending', orgId: owner.orgId },
    });
    expect(invited.body).not.toContain('token');

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/invites',
      headers: { cookie: owner.cookie },
    });
    expect(listed.json<{ invites: unknown[] }>().invites).toHaveLength(1);

    // The token only ever existed in the message, so the accept path is exercised
    // through the send that really happened.
    const token = tokenFrom(email.to('guest@example.invalid'));

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      headers: authorizedWrite(guest, 'accept-invite'),
      payload: { orgId: owner.orgId, token },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      orgId: owner.orgId,
      userId: guest.userId,
      roleCode: 'bookkeeper',
      joined: true,
    });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: { cookie: owner.cookie },
    });
    expect(after.json<{ members: { userId: string }[] }>().members).toHaveLength(2);
  });

  it('refuses to demote the org’s last Owner, and the refusal comes from the service', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'lastowner@example.invalid',
      orgName: 'Last Owner Books',
    });

    const roles = await app.inject({
      method: 'GET',
      url: '/v1/roles',
      headers: { cookie: session.cookie },
    });
    const readOnly = roles
      .json<{ roles: { id: string; code: string }[] }>()
      .roles.find((role) => role.code === 'read_only');

    const refused = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${session.userId}`,
      headers: authorizedWrite(session, 'demote-last-owner'),
      payload: { roleId: readOnly?.id },
    });
    expect(refused.statusCode).toBe(412);
    expect(errorBody(refused.body).error.code).toBe('precondition_failed');
  });
});

describe('chart templates', () => {
  it('lists the starter charts and applies one', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'charts@example.invalid',
      orgName: 'Chart Books',
    });

    const templates = await app.inject({
      method: 'GET',
      url: '/v1/chart-templates',
      headers: { cookie: session.cookie },
    });
    expect(templates.statusCode).toBe(200);
    const list = templates.json<{ templates: { id: string; accountCount: number }[] }>().templates;
    expect(list.length).toBeGreaterThan(0);
    const template = list[0];
    expect(template?.accountCount).toBeGreaterThan(0);

    const applied = await app.inject({
      method: 'POST',
      url: '/v1/chart-templates/apply',
      headers: authorizedWrite(session, 'apply-chart'),
      payload: { templateId: template?.id },
    });
    expect(applied.statusCode).toBe(201);
    const result = applied.json<{ templateId: string; accounts: unknown[] }>();
    expect(result.templateId).toBe(template?.id);
    expect(result.accounts).toHaveLength(template?.accountCount ?? -1);

    // Applying twice collides on every code and refuses the whole application.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/chart-templates/apply',
      headers: authorizedWrite(session, 'apply-chart-again'),
      payload: { templateId: template?.id },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('the M2 reports', () => {
  it('serves a profit and loss, a balance sheet, and a general ledger that ties', async () => {
    const app = harness.app();
    const scene = await ledgerScene(app, 'reports@example.invalid', 'Report Books');

    const pnl = await app.inject({
      method: 'GET',
      url: '/v1/reports/profit-and-loss?from=2026-01-01&to=2026-12-31',
      headers: { cookie: scene.session.cookie },
    });
    expect(pnl.statusCode).toBe(200);
    expect(pnl.json()).toMatchObject({
      basis: 'accrual',
      groupBy: null,
      range: { from: '2026-01-01', to: '2026-12-31' },
      totals: { revenue: '150000', expenses: '0', netIncome: '150000' },
    });

    const sheet = await app.inject({
      method: 'GET',
      url: '/v1/reports/balance-sheet?asOf=2026-12-31',
      headers: { cookie: scene.session.cookie },
    });
    expect(sheet.statusCode).toBe(200);
    // B3: it balances without a closing journal, because current-year earnings is
    // derived (D-20).
    expect(sheet.json()).toMatchObject({
      asOf: '2026-12-31',
      basis: 'accrual',
      totals: {
        assets: '150000',
        currentYearEarnings: '150000',
        liabilitiesAndEquity: '150000',
        difference: '0',
      },
    });

    const ledger = await app.inject({
      method: 'GET',
      url: `/v1/reports/general-ledger?accountId=${scene.cash}&from=2026-01-01&to=2026-12-31`,
      headers: { cookie: scene.session.cookie },
    });
    expect(ledger.statusCode).toBe(200);
    // The shape D-21's envelope is deliberately not: a header, then `entries`, then
    // the same `nextCursor` every other list returns.
    const page = ledger.json<{
      accountId: string;
      opening: { balance: string };
      movement: { balance: string };
      closing: { balance: string };
      entries: { runningBalance: string; counterparty: { accountCount: number } }[];
      nextCursor: string | null;
    }>();
    expect(Object.keys(page)).not.toContain('items');
    expect(page).toMatchObject({
      accountId: scene.cash,
      opening: { balance: '0' },
      movement: { balance: '150000' },
      closing: { balance: '150000' },
      nextCursor: null,
    });
    // B4 as a reader checks it: the bottom of the column is the figure at the bottom
    // of the page.
    expect(page.entries.at(-1)?.runningBalance).toBe(page.closing.balance);
    expect(page.entries[0]?.counterparty.accountCount).toBe(1);
  });

  /**
   * The dimension filter, which is the one argument in this API that has to cross a
   * querystring as JSON. Three things have to hold at once: the text is parsed, the
   * parsed value reaches the service, and B6 survives the trip — the filtered
   * movement plus the unassigned movement equals the unfiltered movement.
   */
  it('decodes the JSON dimension filter and slices the report with it', async () => {
    const app = harness.app();
    const scene = await ledgerScene(app, 'slices@example.invalid', 'Slice Books');
    const axis = await createDimension(app, scene.session, 'DEPT', 'Department');
    const sales = await createDimensionValue(app, scene.session, axis, 'SALES', 'Sales');

    const revenueLine = scene.lines.find((line) => line.accountId === scene.revenue);
    expect(revenueLine).toBeDefined();
    await app.inject({
      method: 'PUT',
      url: `/v1/journal-lines/${String(revenueLine?.lineId)}/dimensions`,
      headers: authorizedWrite(scene.session, 'slice-tag'),
      payload: { valueIds: [sales] },
    });

    const filtered = await profitAndLoss(app, scene.session, [
      { dimensionId: axis, valueIds: [sales] },
    ]);
    expect(filtered.totals.revenue).toBe('150000');

    const unassigned = await profitAndLoss(app, scene.session, [
      { dimensionId: axis, includeUnassigned: true },
    ]);
    expect(unassigned.totals.revenue).toBe('0');

    // Grouped, the unassigned bucket is present whether or not anything is in it
    // (D-18), and the groups sum to the report unsliced (B6).
    const grouped = await app.inject({
      method: 'GET',
      url: `/v1/reports/profit-and-loss?from=2026-01-01&to=2026-12-31&groupBy=${axis}`,
      headers: { cookie: scene.session.cookie },
    });
    const report = grouped.json<{
      groupBy: string;
      groups: { key: { dimensionValueId: string } | null }[];
      totals: { revenue: string };
    }>();
    expect(report.groupBy).toBe(axis);
    expect(report.groups.map((group) => group.key?.dimensionValueId ?? null)).toEqual([
      sales,
      null,
    ]);
    expect(report.totals.revenue).toBe('150000');
  });

  /**
   * A malformed filter is the caller's mistake, so it has to be a `400` naming the
   * parameter. The transform reports through `ctx.addIssue` rather than throwing,
   * which is what keeps a `JSON.parse` failure out of the 500 handler.
   */
  it('answers a malformed dimension filter as validation_failed, not as a 500', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'badfilter@example.invalid',
      orgName: 'Bad Filter Books',
    });

    for (const raw of [
      'not-json',
      '{"dimensionId":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}',
      // Valid JSON, and refused by the schema itself: a filter naming neither values
      // nor the unassigned bucket matches nothing, which is a mistake and not a report.
      '[{"dimensionId":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}]',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/reports/profit-and-loss?dimensions=${encodeURIComponent(raw)}`,
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode, raw).toBe(400);
      expect(errorBody(response.body).error.code, raw).toBe('validation_failed');
    }
  });

  it('requires asOf on the balance sheet, because the fiscal year is resolved from it', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'asof@example.invalid',
      orgName: 'As Of Books',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/reports/balance-sheet',
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(errorBody(response.body).error.code).toBe('validation_failed');
  });

  it('pages the general ledger with a cursor and carries the header on every page', async () => {
    const app = harness.app();
    const scene = await ledgerScene(app, 'glpage@example.invalid', 'GL Page Books');

    // Two more entries, so a limit of 1 has somewhere to page to.
    for (const [index, day] of ['2026-04-30', '2026-05-31'].entries()) {
      const posted = await app.inject({
        method: 'POST',
        url: '/v1/journals',
        headers: authorizedWrite(scene.session, `gl-page-${String(index)}`),
        payload: {
          date: day,
          lines: [
            { accountId: scene.cash, side: 'debit', amount: '100' },
            { accountId: scene.revenue, side: 'credit', amount: '100' },
          ],
        },
      });
      expect(posted.statusCode).toBe(201);
    }

    interface LedgerPage {
      readonly closing: { readonly balance: string };
      readonly entries: readonly { readonly lineId: string; readonly runningBalance: string }[];
      readonly nextCursor: string | null;
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({
        method: 'GET',
        url: `/v1/reports/general-ledger?accountId=${scene.cash}&limit=1${query}`,
        headers: { cookie: scene.session.cookie },
      });
      expect(response.statusCode).toBe(200);

      const page = response.json<LedgerPage>();

      // Recomputed and returned on every page, not only the first — the whole reason
      // this response is not the bare `{ items, nextCursor }` envelope.
      expect(page.closing.balance).toBe('150200');
      seen.push(...page.entries.map((entry) => entry.lineId));
      cursor = page.nextCursor;
      pages += 1;
      // The running balance of the last row read so far accumulates across pages.
      if (cursor === null) expect(page.entries.at(-1)?.runningBalance).toBe('150200');
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Scene builders
// ---------------------------------------------------------------------------

interface LedgerScene {
  readonly session: Session;
  readonly cash: string;
  readonly revenue: string;
  readonly lines: readonly { lineId: string; accountId: string }[];
}

/**
 * A registered user with two accounts, a fiscal year, and (by default) one posted
 * journal of 1,500.00.
 *
 * Built through the routes rather than through the factories, because every test
 * above is about the routes and a fixture written past them would prove less than it
 * appears to.
 */
async function ledgerScene(
  app: App,
  email: string,
  orgName: string,
  options: { readonly post?: boolean } = {},
): Promise<LedgerScene> {
  const session = await registerUser(app, { email, orgName });

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

  const year = await app.inject({
    method: 'POST',
    url: '/v1/fiscal-years',
    headers: authorizedWrite(session, `year-${orgName}`),
    payload: { fiscalYear: 2026 },
  });
  if (year.statusCode !== 201) throw new Error(`fiscal year failed: ${year.body}`);

  if (options.post === false) return { session, cash, revenue, lines: [] };

  const posted = await app.inject({
    method: 'POST',
    url: '/v1/journals',
    headers: authorizedWrite(session, `journal-${orgName}`),
    payload: {
      date: '2026-03-31',
      memo: 'Cash sale',
      lines: [
        { accountId: cash, side: 'debit', amount: '150000' },
        { accountId: revenue, side: 'credit', amount: '150000' },
      ],
    },
  });
  if (posted.statusCode !== 201) throw new Error(`posting failed: ${posted.body}`);

  const lines = posted.json<{ lines: { lineId: string; accountId: string }[] }>().lines;
  return { session, cash, revenue, lines };
}

async function createDimension(
  app: App,
  session: Session,
  code: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/dimensions',
    headers: authorizedWrite(session, `dimension-${session.orgId}-${code}`),
    payload: { code, name },
  });
  if (response.statusCode !== 201) throw new Error(`createDimension failed: ${response.body}`);
  return response.json<{ id: string }>().id;
}

async function createDimensionValue(
  app: App,
  session: Session,
  dimensionId: string,
  code: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/dimensions/${dimensionId}/values`,
    headers: authorizedWrite(session, `value-${dimensionId}-${code}`),
    payload: { code, name },
  });
  if (response.statusCode !== 201) throw new Error(`createDimensionValue failed: ${response.body}`);
  return response.json<{ id: string }>().id;
}

async function trialBalance(app: App, session: Session): Promise<unknown> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/reports/trial-balance',
    headers: { cookie: session.cookie },
  });
  return response.json();
}

async function profitAndLoss(
  app: App,
  session: Session,
  dimensions: readonly Record<string, unknown>[],
): Promise<{ totals: { revenue: string } }> {
  const query = new URLSearchParams({
    from: '2026-01-01',
    to: '2026-12-31',
    dimensions: JSON.stringify(dimensions),
  });
  const response = await app.inject({
    method: 'GET',
    url: `/v1/reports/profit-and-loss?${query.toString()}`,
    headers: { cookie: session.cookie },
  });
  if (response.statusCode !== 200) throw new Error(`profit and loss failed: ${response.body}`);
  return response.json<{ totals: { revenue: string } }>();
}

/**
 * The starter chart, asserted **through HTTP** rather than at the service.
 *
 * This is the shape of bug that reached `develop`: `createOrg` applied the template
 * correctly and its service tests passed, `createOrgRequestSchema` published
 * `chartTemplateId`, and the route in between rebuilt the input field by field
 * without it. Every layer was individually right and the feature did nothing — a
 * field the API documents and silently discards, which is precisely what the
 * idempotency-key rule exists to prevent one layer up.
 *
 * Nothing below the transport can catch that, which is why these two cases live here
 * and assert the accounts actually exist afterwards rather than that the request was
 * accepted. A 201 was never in doubt.
 */
describe('the starter chart travels through transport', () => {
  it('applies a template named on POST /v1/orgs', async () => {
    const session = await registerUser(harness.app(), {
      email: 'chart-post@example.invalid',
      orgName: 'Chart By Post',
    });

    const created = await harness.app().inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: authorizedWrite(session, 'org-with-chart'),
      payload: { name: 'Second Books', chartTemplateId: 'general_small_business' },
    });
    expect(created.statusCode).toBe(201);

    const switched = await harness.app().inject({
      method: 'POST',
      url: '/v1/orgs/active',
      headers: authorizedWrite(session, 'switch-to-chart-org'),
      payload: { orgId: created.json().org.id },
    });
    expect(switched.statusCode).toBe(200);

    const listed = await harness.app().inject({
      method: 'GET',
      url: '/v1/accounts?limit=200',
      headers: { cookie: session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.length).toBeGreaterThan(20);
  });

  it('leaves an org with no accounts when no template is named', async () => {
    const session = await registerUser(harness.app(), {
      email: 'chart-absent@example.invalid',
      orgName: 'No Chart Please',
    });

    const listed = await harness.app().inject({
      method: 'GET',
      url: '/v1/accounts',
      headers: { cookie: session.cookie },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
  });
});
