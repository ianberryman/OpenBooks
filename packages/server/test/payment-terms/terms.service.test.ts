import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { NotFoundError, PermissionDeniedError, toWireError } from '../../src/errors';
import { createBill } from '../../src/modules/bills';
import { createCreditNote, createInvoice } from '../../src/modules/invoices';
import {
  createPaymentTerm,
  deactivatePaymentTerm,
  getPaymentTerm,
  listPaymentTerms,
  resolveDocumentTerm,
  updatePaymentTerm,
} from '../../src/modules/payment-terms';
import { newUuid, uuidToBuffer } from '../db';
import type { ActorFixture } from './support';
import { actorIn, useServiceDatabase } from './support';

/**
 * `payment_terms` CRUD and `resolveDocumentTerm` (OB-136; ROADMAP D-79, D-106,
 * D-107, D-108).
 *
 * Four claims are worth testing here:
 *
 *  1. **A term is validated the way every other settings-list nomination is**:
 *     exists, is this org's, and a cross-org id is a 404 whose body is
 *     byte-identical to a nonexistent one (A7).
 *  2. **`orgs.read`/`orgs.write` gate every operation**, reusing the two keys
 *     rather than a new catalog entry (D-107).
 *  3. **The discount fields still pair on create and on update.**
 *  4. **`resolveDocumentTerm` resolves the document's own override over the
 *     contact's default, and the default over nothing** — D-108's rule — and
 *     the due-date hook in `createInvoice`/`createBill` reads it.
 */
const db = useServiceDatabase();

function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

describe('creating a term', () => {
  it('records a simple term (net days only)', async () => {
    const actor = await actorIn(db);

    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);

    expect(term).toMatchObject({
      name: 'Net 30',
      netDays: 30,
      discountRatePpm: null,
      discountWindowDays: null,
      isActive: true,
    });
    expect(await getPaymentTerm(term.id, actor.ctx)).toEqual(term);
  });

  it('records a rich term (discount paired)', async () => {
    const actor = await actorIn(db);

    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      actor.ctx,
    );

    expect(term).toMatchObject({ discountRatePpm: 20_000, discountWindowDays: 10 });
  });

  it('refuses a discount rate with no window, and vice versa', async () => {
    const actor = await actorIn(db);

    await expect(
      createPaymentTerm({ name: 'Broken', netDays: 30, discountRatePpm: 20_000 }, actor.ctx),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a duplicate name in the same org as a conflict', async () => {
    const actor = await actorIn(db);
    await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);

    await expect(
      createPaymentTerm({ name: 'Net 30', netDays: 15 }, actor.ctx),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('takes orgs.write, and refuses a bookkeeper who lacks it', async () => {
    const clerk = await actorIn(db, 'bookkeeper');

    await expect(
      createPaymentTerm({ name: 'Net 30', netDays: 30 }, clerk.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('reading and listing', () => {
  it('answers a cross-org term exactly as it answers a nonexistent one (A7)', async () => {
    const [mine, theirs] = await Promise.all([actorIn(db), actorIn(db)]);
    const foreign = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, theirs.ctx);

    const crossOrg = await withContext(mine.ctx, () => getPaymentTerm(foreign.id, mine.ctx)).catch(
      (thrown: unknown) => thrown,
    );
    const nonexistent = await withContext(mine.ctx, () =>
      getPaymentTerm(newUuid(), mine.ctx),
    ).catch((thrown: unknown) => thrown);

    expect(crossOrg).toBeInstanceOf(NotFoundError);
    expect(toWireError(crossOrg)).toEqual(toWireError(nonexistent));
  });

  it('lists active terms only by default, and both when asked', async () => {
    const actor = await actorIn(db);
    const active = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);
    const archived = await createPaymentTerm({ name: 'Net 60', netDays: 60 }, actor.ctx);
    await deactivatePaymentTerm(archived.id, actor.ctx);

    const activeOnly = await listPaymentTerms(false, actor.ctx);
    expect(activeOnly.map((term) => term.id)).toEqual([active.id]);

    const both = await listPaymentTerms(true, actor.ctx);
    expect(both.map((term) => term.id).sort()).toEqual([active.id, archived.id].sort());
  });

  it('takes orgs.read, which every seeded role holds', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(listPaymentTerms(false, actor.ctx)).resolves.toEqual([]);
  });
});

describe('updating a term', () => {
  it('renames a term without disturbing its discount', async () => {
    const actor = await actorIn(db);
    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      actor.ctx,
    );

    const updated = await updatePaymentTerm(term.id, { name: '2/10 Net 30 (renamed)' }, actor.ctx);

    expect(updated).toMatchObject({
      name: '2/10 Net 30 (renamed)',
      discountRatePpm: 20_000,
      discountWindowDays: 10,
    });
  });

  it('refuses a discount rate supplied without its window', async () => {
    const actor = await actorIn(db);
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);

    await expect(
      updatePaymentTerm(term.id, { discountRatePpm: 20_000 }, actor.ctx),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses an empty patch', async () => {
    const actor = await actorIn(db);
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);

    await expect(updatePaymentTerm(term.id, {}, actor.ctx)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('404s on a cross-org term id', async () => {
    const [mine, theirs] = await Promise.all([actorIn(db), actorIn(db)]);
    const foreign = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, theirs.ctx);

    await expect(updatePaymentTerm(foreign.id, { netDays: 15 }, mine.ctx)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('deactivating a term', () => {
  it('flips is_active and leaves the term readable', async () => {
    const actor = await actorIn(db);
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);

    const archived = await deactivatePaymentTerm(term.id, actor.ctx);

    expect(archived.isActive).toBe(false);
    expect(await getPaymentTerm(term.id, actor.ctx)).toMatchObject({ isActive: false });
  });
});

describe('resolveDocumentTerm (D-108)', () => {
  it('answers null when neither the document nor the contact names a term', async () => {
    const actor = await actorIn(db);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: actor.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
      })
      .execute();

    await expect(
      withContext(actor.ctx, () => resolveDocumentTerm(actor.ctx, { contactId })),
    ).resolves.toBeNull();
  });

  it("falls back to the contact's default when the document names no override", async () => {
    const actor = await actorIn(db);
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: actor.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
        default_payment_term_id: uuidToBuffer(term.id),
      })
      .execute();

    const resolved = await withContext(actor.ctx, () =>
      resolveDocumentTerm(actor.ctx, { contactId }),
    );
    expect(resolved?.id).toBe(term.id);
  });

  it("the document's own override wins over the contact's default", async () => {
    const actor = await actorIn(db);
    const contactDefault = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);
    const override = await createPaymentTerm({ name: 'Net 60', netDays: 60 }, actor.ctx);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: actor.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
        default_payment_term_id: uuidToBuffer(contactDefault.id),
      })
      .execute();

    const resolved = await withContext(actor.ctx, () =>
      resolveDocumentTerm(actor.ctx, { contactId, documentTermId: override.id }),
    );
    expect(resolved?.id).toBe(override.id);
  });

  it('404s on an override that does not resolve to a term in this org (A7)', async () => {
    const [mine, theirs] = await Promise.all([actorIn(db), actorIn(db)]);
    const foreign = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, theirs.ctx);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: mine.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
      })
      .execute();

    await expect(
      withContext(mine.ctx, () =>
        resolveDocumentTerm(mine.ctx, { contactId, documentTermId: foreign.id }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * The due-date hook `createInvoice`/`createBill` call, proved end to end rather
 * than by re-reading `resolveDocumentTerm`'s own tests: what matters is that a
 * *document* comes back with the term's arithmetic applied, and that an
 * explicit `dueDate` still overrides it.
 */
describe('the due-date hook on document creation', () => {
  let actor: ActorFixture;

  beforeEach(async () => {
    actor = await actorIn(db);
  });

  it("computes an invoice's due date from the contact's default term", async () => {
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: actor.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
        default_payment_term_id: uuidToBuffer(term.id),
      })
      .execute();

    const invoice = await withContext(actor.ctx, () =>
      createInvoice({ contactId, issueDate: '2026-01-01', taxMode: 'exclusive' }, actor.ctx),
    );

    expect(invoice.dueDate).toBe('2026-01-31');

    const stored = await db.app
      .selectFrom('ar_documents')
      .select('payment_term_id')
      .where('id', '=', uuidToBuffer(invoice.id))
      .executeTakeFirstOrThrow();
    expect(stored.payment_term_id).toEqual(uuidToBuffer(term.id));
  });

  it('keeps an explicit dueDate, still recording which term governs the invoice', async () => {
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: actor.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
        default_payment_term_id: uuidToBuffer(term.id),
      })
      .execute();

    const invoice = await withContext(actor.ctx, () =>
      createInvoice(
        { contactId, issueDate: '2026-01-01', dueDate: '2026-02-15', taxMode: 'exclusive' },
        actor.ctx,
      ),
    );

    expect(invoice.dueDate).toBe('2026-02-15');

    const stored = await db.app
      .selectFrom('ar_documents')
      .select('payment_term_id')
      .where('id', '=', uuidToBuffer(invoice.id))
      .executeTakeFirstOrThrow();
    expect(stored.payment_term_id).toEqual(uuidToBuffer(term.id));
  });

  it("computes a bill's due date from the vendor's default term (the AP twin)", async () => {
    const term = await createPaymentTerm({ name: 'Net 15', netDays: 15 }, actor.ctx);
    const vendorId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(vendorId),
        org_id: actor.orgId,
        display_name: 'Supplier Co',
        is_customer: 0,
        is_vendor: 1,
        default_payment_term_id: uuidToBuffer(term.id),
      })
      .execute();

    const bill = await withContext(actor.ctx, () =>
      createBill({ contactId: vendorId, issueDate: '2026-01-01', taxMode: 'exclusive' }, actor.ctx),
    );

    expect(bill.dueDate).toBe('2026-01-16');
  });

  it('leaves a credit note without a term or a due date', async () => {
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, actor.ctx);
    const contactId = newUuid();
    await db.app
      .insertInto('contacts')
      .values({
        id: uuidToBuffer(contactId),
        org_id: actor.orgId,
        display_name: 'Acme Ltd',
        is_customer: 1,
        default_payment_term_id: uuidToBuffer(term.id),
      })
      .execute();

    const creditNote = await withContext(actor.ctx, () =>
      createCreditNote({ contactId, issueDate: '2026-01-01', taxMode: 'exclusive' }, actor.ctx),
    );

    const stored = await db.app
      .selectFrom('ar_documents')
      .select(['due_date', 'payment_term_id'])
      .where('id', '=', uuidToBuffer(creditNote.id))
      .executeTakeFirstOrThrow();
    expect(stored.due_date).toBeNull();
    expect(stored.payment_term_id).toBeNull();
  });
});
