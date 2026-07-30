import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { toWireError } from '../../src/errors';
import { approveEstimate, createEstimate } from '../../src/modules/estimates';
import { sendEstimate, sendPurchaseOrder } from '../../src/modules/predocument-delivery';
import { approvePurchaseOrder, createPurchaseOrder } from '../../src/modules/purchase-orders';
import type { SystemRoleName, TestDatabase } from '../db';
import {
  SYSTEM_ROLE_UUIDS,
  bufferToUuid,
  newUuidBuffer,
  systemRoleId,
  useTestDatabase,
  uuidToBuffer,
} from '../db';
import { captureEmail } from '../members/support';

/**
 * `sendPurchaseOrder` / `sendEstimate` (initiative M, OB-177; ROADMAP D-M5).
 *
 * A deliberate duplicate of `test/purchase-orders/support.ts`'s own harness
 * scaffolding (`actorIn`, `contactIn`) rather than an import from it — that
 * file's own header states the convention this follows: reaching sideways into
 * another suite's fixtures means this suite breaks when that one is edited.
 * `createPurchaseOrder`/`approvePurchaseOrder`/`createEstimate`/`approveEstimate`
 * are production code, not test scaffolding, and are used directly — the same
 * "prove it against the real thing" argument `test/delivery/support.ts` makes
 * for building its approved invoice through `createInvoice`/`approveInvoice`
 * rather than a raw `INSERT`.
 *
 * `captureEmail`, by contrast, is the one deliberately shared seam
 * (`test/members/support.ts`'s own header) — a real `log` adapter over a
 * capture stream, not a mock (spec §11).
 */

function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

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

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

interface Actor {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

async function actorIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<Actor> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}

/** A vendor-and-customer contact (both flags, so it can stand in for either side). */
async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  overrides: { readonly email?: string | null } = {},
): Promise<{ readonly id: Buffer; readonly uuid: string }> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: 'Acme Supplies',
      is_vendor: 1,
      is_customer: 1,
      is_active: 1,
      email: overrides.email ?? null,
    })
    .execute();
  return { id, uuid: bufferToUuid(id) };
}

describe('sendPurchaseOrder / sendEstimate (D-M5)', () => {
  const db = useServiceDatabase();
  const capture = captureEmail();

  it('emails an approved purchase order to its vendor and records a sent delivery', async () => {
    const actor = await actorIn(db);
    const account = await db.factories.account({
      orgId: actor.orgId,
      type: 'expense',
      normalBalance: 'debit',
    });
    const vendor = await contactIn(db, actor.orgId, { email: 'vendor@example.test' });

    const delivery = await withContext(actor.ctx, async () => {
      const draft = await createPurchaseOrder({
        contactId: vendor.uuid,
        issueDate: '2026-01-15',
        taxMode: 'exclusive',
        reference: 'PO-REF-1',
        lines: [
          {
            description: 'Widgets',
            quantity: '2',
            unitAmount: '10000',
            accountId: account.uuid,
          },
        ],
      });
      const approved = await approvePurchaseOrder(draft.id);
      return sendPurchaseOrder(approved.id, {});
    });

    expect(delivery).toMatchObject({
      documentKind: 'purchase_order',
      recipientEmail: 'vendor@example.test',
      status: 'sent',
      providerMessageId: null,
    });
    expect(delivery.sentAt).toEqual(expect.any(String));

    const sent = capture.to('vendor@example.test');
    expect(sent.subject).toContain('Purchase order');

    // Written as an append-only fact, not just returned — the same row a second
    // read would see.
    const row = await db.app
      .selectFrom('predocument_deliveries')
      .select(['document_kind', 'document_id', 'recipient_email', 'status'])
      .where('id', '=', uuidToBuffer(delivery.id))
      .executeTakeFirst();
    expect(row).toMatchObject({
      document_kind: 'purchase_order',
      recipient_email: 'vendor@example.test',
      status: 'sent',
    });
  });

  it('refuses to send a draft purchase order', async () => {
    const actor = await actorIn(db);
    const account = await db.factories.account({
      orgId: actor.orgId,
      type: 'expense',
      normalBalance: 'debit',
    });
    const vendor = await contactIn(db, actor.orgId, { email: 'vendor@example.test' });

    const draft = await withContext(actor.ctx, () =>
      createPurchaseOrder({
        contactId: vendor.uuid,
        issueDate: '2026-01-15',
        taxMode: 'exclusive',
        lines: [
          { description: 'Widgets', quantity: '1', unitAmount: '5000', accountId: account.uuid },
        ],
      }),
    );

    expect(
      await wireErrorOf(withContext(actor.ctx, () => sendPurchaseOrder(draft.id, {}))),
    ).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'purchase_order_not_approved' },
    });
  });

  it('refuses to send with no recipient on file and none supplied', async () => {
    const actor = await actorIn(db);
    const account = await db.factories.account({
      orgId: actor.orgId,
      type: 'expense',
      normalBalance: 'debit',
    });
    const vendor = await contactIn(db, actor.orgId, { email: null });

    const approved = await withContext(actor.ctx, async () => {
      const draft = await createPurchaseOrder({
        contactId: vendor.uuid,
        issueDate: '2026-01-15',
        taxMode: 'exclusive',
        lines: [
          { description: 'Widgets', quantity: '1', unitAmount: '5000', accountId: account.uuid },
        ],
      });
      return approvePurchaseOrder(draft.id);
    });

    expect(
      await wireErrorOf(withContext(actor.ctx, () => sendPurchaseOrder(approved.id, {}))),
    ).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'no_recipient' },
    });
  });

  it('emails an approved estimate to its customer (the AR mirror)', async () => {
    const actor = await actorIn(db);
    const income = await db.factories.account({
      orgId: actor.orgId,
      type: 'revenue',
      normalBalance: 'credit',
    });
    const customer = await contactIn(db, actor.orgId, { email: 'customer@example.test' });

    const delivery = await withContext(actor.ctx, async () => {
      const draft = await createEstimate({
        contactId: customer.uuid,
        issueDate: '2026-01-15',
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitAmount: '20000',
            accountId: income.uuid,
          },
        ],
      });
      const approved = await approveEstimate(draft.id);
      return sendEstimate(approved.id, {});
    });

    expect(delivery).toMatchObject({
      documentKind: 'estimate',
      recipientEmail: 'customer@example.test',
      status: 'sent',
      providerMessageId: null,
    });
  });
});
