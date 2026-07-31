import type { CreateInvoiceRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { bufferToUuid } from '../../src/db';
import { NotFoundError, PreconditionFailedError, toWireError } from '../../src/errors';
import { createCatalogItem, deactivateCatalogItem } from '../../src/modules/catalog';
import { createInvoice, getInvoice, updateInvoice } from '../../src/modules/invoices';
import { actorIn, contactIn, useServiceDatabase, type ActorFixture } from './support';

/**
 * `catalogItemId` threaded through a document line (initiative CAT, D-CAT-1/D-CAT-2).
 *
 * Exercised on the AR invoice path — a `'sales'` document — because the guard the
 * four document services share (`assertCatalogItemsUsable`) is reached identically
 * from all of them; the invoice is the cheapest to stand up (a draft needs no
 * control account or period). The properties asserted are the guard's:
 *
 *  - a same-direction item persists and round-trips as provenance;
 *  - a cross-org item is A7's 404 (B11), not a 500 from the line FK;
 *  - a wrong-direction item is refused with the stable `catalog_item_wrong_direction`
 *    token;
 *  - and, D-CAT-2, a deactivated item does not fail a later edit — provenance is
 *    never destructively re-validated.
 */
const db = useServiceDatabase();

interface Scene {
  readonly actor: ActorFixture;
  readonly income: string;
  readonly contact: string;
}

async function scene(): Promise<Scene> {
  const actor = await actorIn(db);
  const income = await db.factories.account({
    orgId: actor.orgId,
    type: 'revenue',
    normalBalance: 'credit',
  });
  const contact = await contactIn(db, actor.orgId);

  return { actor, income: income.uuid, contact: bufferToUuid(contact) };
}

function invoiceWith(scn: Scene, catalogItemId: string | null): CreateInvoiceRequest {
  return {
    contactId: scn.contact,
    issueDate: '2026-02-01',
    taxMode: 'exclusive',
    lines: [
      {
        description: 'One line',
        quantity: '1',
        unitAmount: '10000',
        accountId: scn.income,
        ...(catalogItemId === null ? {} : { catalogItemId }),
      },
    ],
  };
}

describe('catalog_item_id on a document line', () => {
  it('persists a same-direction item and round-trips it on read', async () => {
    const scn = await scene();
    const item = await createCatalogItem(
      { direction: 'sales', name: 'Consulting hour', defaultAccountId: scn.income },
      scn.actor.ctx,
    );

    const invoice = await createInvoice(invoiceWith(scn, item.id), scn.actor.ctx);
    expect(invoice.lines[0]?.catalogItemId).toBe(item.id);

    const fetched = await getInvoice(invoice.id, scn.actor.ctx);
    expect(fetched.lines[0]?.catalogItemId).toBe(item.id);
  });

  it('records null for a free-form line', async () => {
    const scn = await scene();

    const invoice = await createInvoice(invoiceWith(scn, null), scn.actor.ctx);
    expect(invoice.lines[0]?.catalogItemId).toBeNull();
  });

  it('answers a cross-org catalog item with a 404 (B11), not a 500', async () => {
    const scn = await scene();
    const theirs = await actorIn(db);
    const theirItem = await createCatalogItem({ direction: 'sales', name: 'Theirs' }, theirs.ctx);

    const error = await createInvoice(invoiceWith(scn, theirItem.id), scn.actor.ctx).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect(toWireError(error)).toMatchObject({
      code: 'not_found',
      status: 404,
      details: { resource: 'catalog_item' },
    });
  });

  it('refuses a purchase item on a sales document', async () => {
    const scn = await scene();
    const purchaseItem = await createCatalogItem(
      { direction: 'purchase', name: 'Raw material' },
      scn.actor.ctx,
    );

    const error = await createInvoice(invoiceWith(scn, purchaseItem.id), scn.actor.ctx).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      status: 412,
      details: { precondition: 'catalog_item_wrong_direction' },
    });
  });

  /**
   * D-CAT-2: provenance is never destructively re-validated. An item cited on a line
   * and then deactivated must not make a later edit of the document fail — the item
   * still exists and its direction is unchanged, and `assertCatalogItemsUsable` does
   * not look at `is_active`.
   */
  it('still edits a document whose catalog item was deactivated after it was cited', async () => {
    const scn = await scene();
    const item = await createCatalogItem(
      { direction: 'sales', name: 'Consulting hour' },
      scn.actor.ctx,
    );

    const invoice = await createInvoice(invoiceWith(scn, item.id), scn.actor.ctx);
    await deactivateCatalogItem(item.id, scn.actor.ctx);

    const updated = await updateInvoice(
      invoice.id,
      { lines: invoiceWith(scn, item.id).lines },
      scn.actor.ctx,
    );

    expect(updated.lines[0]?.catalogItemId).toBe(item.id);
  });
});
