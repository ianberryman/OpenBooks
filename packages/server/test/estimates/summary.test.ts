import { estimatesSummarySchema } from '@openbooks/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRequestContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { estimatesSummary } from '../../src/modules/estimates';
import { newUuidBuffer, SYSTEM_ROLE_UUIDS, useTestDatabase } from '../db';

/**
 * The estimates-list headline figures: open value, expired value, and converted
 * value in the last 30 days. The non-posting mirror of `test/invoices/summary.test.ts`;
 * see there for the shared arguments (a 30-day window on both boundaries, a live
 * `asOf` default).
 *
 * An estimate posts no journal (D-M3), so unlike the invoice/bill summaries this
 * one has no aging repository to prove against — the point under test is the three
 * stored-column predicates `estimatesSummary` applies (`sequence_number`,
 * `converted_invoice_id`, `expiry_date`, `converted_at`). The fixtures insert
 * `estimates`/`estimate_lines` rows directly rather than going through
 * `createEstimate`/`approveEstimate`/`convertEstimateToInvoice`, `test/invoices/
 * summary.test.ts`'s reason applied to columns instead of a journal: those calls
 * only ever stamp "now", which cannot place a row precisely on either side of the
 * 30-day window.
 */
const db = useTestDatabase();

beforeAll(() => {
  if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
});

afterAll(async () => {
  await destroyDatabase();
});

/** Every figure is measured against this date. `windowStart` is 2026-05-31. */
const AS_OF = '2026-06-30';

interface Scene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
  readonly userId: Buffer;
  readonly accountId: Buffer;
  readonly contactId: Buffer;
}

async function sceneIn(): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, role: 'owner' });
  const account = await db.factories.account({
    orgId: org.id,
    type: 'revenue',
    normalBalance: 'credit',
  });
  const contactId = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id: contactId, org_id: org.id, display_name: 'Acme Retail', is_customer: 1 })
    .execute();

  return {
    ctx: createRequestContext({
      orgId: org.uuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: user.uuid,
      actorType: 'user',
      actorId: user.uuid,
    }),
    orgId: org.id,
    userId: user.id,
    accountId: account.id,
    contactId,
  };
}

interface EstimateInput {
  readonly netAmount: bigint;
  readonly taxAmount?: bigint;
  readonly expiryDate?: string | null;
  readonly sequenceNumber?: bigint | null;
  readonly approvedAt?: Date | null;
  readonly convertedInvoiceId?: Buffer | null;
  readonly convertedAt?: Date | null;
}

/**
 * A minimal draft invoice row: `fk_estimates_invoice` requires `converted_invoice_id`
 * to reference a real `ar_documents` row, `journal_id` null exactly as
 * `convertEstimateToInvoice` leaves it (D-M4 — nothing is posted at convert).
 */
async function insertDraftInvoice(scene: Scene): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('ar_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: 'invoice',
      sequence_number: null,
      contact_id: scene.contactId,
      issue_date: '2026-01-15',
      due_date: null,
      tax_mode: 'exclusive',
      reference: null,
      memo: null,
      journal_id: null,
      created_by_user_id: scene.userId,
    })
    .execute();

  return id;
}

/**
 * An estimate plus one priced line, its fields set directly so a fixture can place
 * `approvedAt`/`convertedAt` precisely on either side of the summary's 30-day
 * window — the module's own doc comment explains why `approveEstimate`/
 * `convertEstimateToInvoice` cannot be used for that here.
 */
async function insertEstimate(scene: Scene, input: EstimateInput): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('estimates')
    .values({
      id,
      org_id: scene.orgId,
      contact_id: scene.contactId,
      issue_date: '2026-01-15',
      expiry_date: input.expiryDate ?? null,
      tax_mode: 'exclusive',
      reference: null,
      memo: null,
      sequence_number: input.sequenceNumber ?? null,
      approved_at: input.approvedAt ?? null,
      converted_invoice_id: input.convertedInvoiceId ?? null,
      converted_at: input.convertedAt ?? null,
      created_by_user_id: scene.userId,
    })
    .execute();

  await db.app
    .insertInto('estimate_lines')
    .values({
      org_id: scene.orgId,
      estimate_id: id,
      line_number: 1,
      description: 'Consulting',
      quantity_micros: 1_000_000n,
      unit_amount_minor: input.netAmount,
      account_id: scene.accountId,
      tax_rate_id: null,
      catalog_item_id: null,
      line_amount_minor: input.netAmount,
      tax_amount_minor: input.taxAmount ?? 0n,
    })
    .execute();

  return id;
}

describe('estimatesSummary', () => {
  let scene: Scene;

  beforeEach(async () => {
    scene = await sceneIn();
  });

  it('sums open value across draft and approved estimates, and splits out the expired ones', async () => {
    // Draft: open, never expired (only an approved/numbered estimate can lapse).
    await insertEstimate(scene, { netAmount: 500n });
    // Approved, not yet due.
    await insertEstimate(scene, {
      netAmount: 1000n,
      sequenceNumber: 1n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      expiryDate: '2026-07-15',
    });
    // Approved, expiring exactly on `asOf` — open, but not expired (the `current`
    // line: due today is not yet expired).
    await insertEstimate(scene, {
      netAmount: 400n,
      sequenceNumber: 2n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      expiryDate: AS_OF,
    });
    // Approved and expired.
    await insertEstimate(scene, {
      netAmount: 300n,
      sequenceNumber: 3n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      expiryDate: '2026-06-01',
    });
    // Converted, so no longer open at all, whatever its (absent) expiry.
    await insertEstimate(scene, {
      netAmount: 999n,
      sequenceNumber: 4n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      convertedInvoiceId: await insertDraftInvoice(scene),
      convertedAt: new Date('2026-06-01T00:00:00Z'),
    });

    const summary = estimatesSummarySchema.parse(
      await estimatesSummary({ asOf: AS_OF }, scene.ctx),
    );

    // Draft (500) + not-yet-due (1000) + due-today (400) + expired (300) = 2200,
    // across all four non-converted estimates; the converted one (999) is in
    // neither figure.
    expect(summary.openValue).toBe('2200');
    expect(summary.openCount).toBe(4);
    expect(summary.expiredValue).toBe('300');
    expect(summary.expiredCount).toBe(1);
  });

  it('sums converted value within the 30 days ending on asOf, on both boundaries', async () => {
    await insertEstimate(scene, {
      netAmount: 700n,
      sequenceNumber: 1n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      convertedInvoiceId: await insertDraftInvoice(scene),
      convertedAt: new Date('2026-06-15T00:00:00Z'),
    });
    await insertEstimate(scene, {
      netAmount: 200n,
      sequenceNumber: 2n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      convertedInvoiceId: await insertDraftInvoice(scene),
      convertedAt: new Date(`${AS_OF}T00:00:00Z`),
    });
    // 2026-05-31 is exactly `asOf` minus 30 days — the inclusive start of the window.
    await insertEstimate(scene, {
      netAmount: 100n,
      sequenceNumber: 3n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      convertedInvoiceId: await insertDraftInvoice(scene),
      convertedAt: new Date('2026-05-31T00:00:00Z'),
    });
    // One day earlier is outside it.
    await insertEstimate(scene, {
      netAmount: 999n,
      sequenceNumber: 4n,
      approvedAt: new Date('2026-01-16T00:00:00Z'),
      convertedInvoiceId: await insertDraftInvoice(scene),
      convertedAt: new Date('2026-05-30T00:00:00Z'),
    });

    const summary = await estimatesSummary({ asOf: AS_OF }, scene.ctx);

    expect(summary.convertedValue).toBe('1000');
    expect(summary.convertedCount).toBe(3);
  });

  it('is empty for an org with no estimates', async () => {
    const summary = await estimatesSummary({ asOf: AS_OF }, scene.ctx);

    expect(summary).toEqual({
      asOf: AS_OF,
      openValue: '0',
      openCount: 0,
      expiredValue: '0',
      expiredCount: 0,
      convertedValue: '0',
      convertedCount: 0,
    });
  });

  it('defaults asOf to today when the caller gives no date', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const summary = await estimatesSummary({}, scene.ctx);

    expect(summary.asOf).toBe(today);
  });
});
