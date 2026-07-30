import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRequestContext, runInContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { toWireError } from '../../src/errors';
import {
  approveEstimate,
  convertEstimateToInvoice,
  createEstimate,
  discardEstimate,
  getEstimate,
} from '../../src/modules/estimates';
import type { SystemRoleName } from '../db';
import {
  bufferToUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  systemRoleId,
  useTestDatabase,
} from '../db';

/**
 * The estimate lifecycle against real MySQL (spec §11 — never SQLite, never
 * mocks; initiative M, OB-175…176; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * The harness helpers below are a deliberate duplicate of `test/invoices/
 * support.ts`'s (`contextFor`/`withContext`/`actorIn`/`contactIn`/`taxRateIn`),
 * following the convention that file states: reaching sideways into another
 * suite's fixtures means this suite breaks when that one is edited.
 *
 * No fiscal period and no control-account nomination are set up here — unlike
 * the AR document suites, nothing in this file ever posts a journal (D-M3): a
 * draft estimate has none, approving one only allocates a number, and
 * `convertEstimateToInvoice` produces a **draft** invoice, which
 * `createInvoice` builds with no period check at all (that check belongs to
 * `approveInvoice`, never reached here).
 */
const db = useTestDatabase();

beforeAll(() => {
  if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
});

afterAll(async () => {
  await destroyDatabase();
});

/** A request context for an `(org, role, user)` triple. */
function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

interface Scene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
  readonly income: string;
  readonly contact: string;
  readonly vat: string;
  readonly date: string;
}

async function contactIn(orgId: Buffer, name = 'Acme Ltd'): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_customer: 1 })
    .execute();
  return id;
}

async function taxRateIn(
  orgId: Buffer,
  name: string,
  ratePpm: number,
  taxAccountId: Buffer,
  appliesTo: 'both' | 'purchases' | 'sales' = 'both',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('tax_rates')
    .values({
      id,
      org_id: orgId,
      name,
      rate_ppm: ratePpm,
      tax_account_id: taxAccountId,
      applies_to: appliesTo,
      is_active: 1,
    })
    .execute();
  return id;
}

async function sceneIn(role: SystemRoleName = 'owner'): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  const [income, taxLiability] = await Promise.all([
    db.factories.account({ orgId: org.id, type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.id, type: 'liability', normalBalance: 'credit' }),
  ]);

  const contactId = await contactIn(org.id);
  const vatId = await taxRateIn(org.id, 'VAT 20%', 200_000, taxLiability.id);

  return {
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    orgId: org.id,
    income: income.uuid,
    contact: bufferToUuid(contactId),
    vat: bufferToUuid(vatId),
    date: '2026-01-15',
  };
}

function estimateLine(s: Scene, overrides: Record<string, unknown> = {}) {
  return {
    description: 'Consulting',
    quantity: '2',
    unitAmount: '10000',
    accountId: s.income,
    taxRateId: s.vat,
    ...overrides,
  };
}

async function wireErrorOf(body: () => Promise<unknown>): Promise<unknown> {
  return body().then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

async function countJournals(orgId: Buffer): Promise<number> {
  const rows = await db.app
    .selectFrom('journals')
    .select('id')
    .where('org_id', '=', orgId)
    .execute();
  return rows.length;
}

let s: Scene;

beforeEach(async () => {
  s = await sceneIn();
});

describe('creating a draft estimate', () => {
  it('creates a draft with no number, no journal, and priced lines', async () => {
    const estimate = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [estimateLine(s)],
      }),
    );

    expect(estimate).toMatchObject({
      contactId: s.contact,
      documentNumber: null,
      status: 'draft',
      convertedInvoiceId: null,
      approvedAt: null,
    });
    expect(estimate.totals).toEqual({ net: '20000', tax: '4000', gross: '24000' });
    expect(estimate.lines).toHaveLength(1);

    // D-M3: an estimate never posts, whatever it carries.
    expect(await countJournals(s.orgId)).toBe(0);
    expect(await getEstimate(estimate.id, s.ctx)).toEqual(estimate);
  });

  it('does not enforce a customer flag on the contact (no requireCustomer guard)', async () => {
    const nonCustomerId = newUuidBuffer();
    await db.app
      .insertInto('contacts')
      .values({ id: nonCustomerId, org_id: s.orgId, display_name: 'Not flagged', is_customer: 0 })
      .execute();

    const estimate = await withContext(s.ctx, () =>
      createEstimate({
        contactId: bufferToUuid(nonCustomerId),
        issueDate: s.date,
        taxMode: 'exclusive',
      }),
    );

    expect(estimate.contactId).toBe(bufferToUuid(nonCustomerId));
  });
});

describe('approving an estimate', () => {
  it('allocates a gapless number and stamps approvedAt, and posts no journal', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [estimateLine(s)],
      }),
    );

    const approved = await withContext(s.ctx, () => approveEstimate(created.id, s.ctx));

    expect(approved.status).toBe('approved');
    expect(approved.documentNumber).not.toBeNull();
    expect(approved.approvedAt).not.toBeNull();
    expect(await countJournals(s.orgId)).toBe(0);
  });

  it('refuses an estimate with no lines', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({ contactId: s.contact, issueDate: s.date, taxMode: 'exclusive' }),
    );

    const error = await wireErrorOf(() =>
      withContext(s.ctx, () => approveEstimate(created.id, s.ctx)),
    );
    expect(error).toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a second approval', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [estimateLine(s)],
      }),
    );
    await withContext(s.ctx, () => approveEstimate(created.id, s.ctx));

    const error = await wireErrorOf(() =>
      withContext(s.ctx, () => approveEstimate(created.id, s.ctx)),
    );
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'estimate_already_approved' },
    });
  });
});

describe('converting an estimate to an invoice', () => {
  it('refuses to convert a draft that has not been approved', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [estimateLine(s)],
      }),
    );

    const error = await wireErrorOf(() =>
      withContext(s.ctx, () => convertEstimateToInvoice(created.id, s.ctx)),
    );
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'estimate_not_approved' },
    });
  });

  it('builds a draft invoice carrying the same lines, and posts no journal', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        reference: 'Q-0042',
        memo: 'Spring project',
        lines: [estimateLine(s)],
      }),
    );
    const approved = await withContext(s.ctx, () => approveEstimate(created.id, s.ctx));

    const invoice = await withContext(s.ctx, () => convertEstimateToInvoice(approved.id, s.ctx));

    expect(invoice.status).toBe('draft');
    expect(invoice.documentNumber).toBeNull();
    expect(invoice.journalId).toBeNull();
    expect(invoice.contactId).toBe(s.contact);
    expect(invoice.reference).toBe('Q-0042');
    expect(invoice.memo).toBe('Spring project');
    expect(invoice.totals).toEqual(approved.totals);
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]).toMatchObject({
      description: 'Consulting',
      quantity: '2',
      unitAmount: '10000',
      accountId: s.income,
      taxRateId: s.vat,
      netAmount: '20000',
      taxAmount: '4000',
      grossAmount: '24000',
    });

    const reread = await withContext(s.ctx, () => getEstimate(approved.id, s.ctx));
    expect(reread.status).toBe('converted');
    expect(reread.convertedInvoiceId).toBe(invoice.id);

    // Building a draft invoice posts nothing — the only journal-adjacent thing
    // this whole path ever does (D-M3, D-M4).
    expect(await countJournals(s.orgId)).toBe(0);
  });

  it('refuses to convert an estimate a second time', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [estimateLine(s)],
      }),
    );
    const approved = await withContext(s.ctx, () => approveEstimate(created.id, s.ctx));
    await withContext(s.ctx, () => convertEstimateToInvoice(approved.id, s.ctx));

    const error = await wireErrorOf(() =>
      withContext(s.ctx, () => convertEstimateToInvoice(approved.id, s.ctx)),
    );
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'estimate_already_converted' },
    });
  });
});

describe('discarding a draft', () => {
  it('deletes a draft outright', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({ contactId: s.contact, issueDate: s.date, taxMode: 'exclusive' }),
    );

    await withContext(s.ctx, () => discardEstimate(created.id, s.ctx));

    const error = await wireErrorOf(() => withContext(s.ctx, () => getEstimate(created.id, s.ctx)));
    expect(error).toMatchObject({ code: 'not_found' });
  });

  it('refuses to discard an approved estimate', async () => {
    const created = await withContext(s.ctx, () =>
      createEstimate({
        contactId: s.contact,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [estimateLine(s)],
      }),
    );
    await withContext(s.ctx, () => approveEstimate(created.id, s.ctx));

    const error = await wireErrorOf(() =>
      withContext(s.ctx, () => discardEstimate(created.id, s.ctx)),
    );
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'estimate_approved' },
    });
  });
});
