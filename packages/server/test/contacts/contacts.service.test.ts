import type { CreateContactRequest } from '@openbooks/shared-types';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { bufferToUuid, newUuidBuffer, uuidToBuffer } from '../../src/db';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import {
  createContact,
  deactivateContact,
  deleteContact,
  getContact,
  listContacts,
  reactivateContact,
  updateContact,
} from '../../src/modules/contacts';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import { actorIn, contextFor, useServiceDatabase, type ActorFixture } from './support';

/**
 * The contacts service against real MySQL (spec §11 — never SQLite, never mocks).
 *
 * Everything here goes through the exported service functions rather than through
 * the repository, because the properties being asserted are properties of the
 * service boundary: the permission check, the conflict translation, and the A7
 * miss all live there, and a test that reached the repository would pass while the
 * boundary was missing.
 */
const ACME: CreateContactRequest = {
  displayName: 'Acme Supplies',
  isVendor: true,
};

const db = useServiceDatabase();

/**
 * Tags every line of a real posted journal with `contact`, and returns nothing.
 *
 * Raw SQL on the migrator connection, deliberately, and it is the only way this
 * assertion can be made today: the app user holds no `UPDATE` on `journal_lines`
 * by design (`0999_app_grants`), `openbooks/no-journal-writes` keeps inserts
 * inside the posting repository and the factories, and no posting path accepts a
 * `contactId` yet — the ledger's wire contract has no such field until the ticket
 * that tags a posted line. `test/contacts/schema.test.ts` establishes the same
 * idiom for the same reason.
 *
 * What matters is that the row is a genuine `journal_lines` row under
 * `fk_journal_lines_contact`, so the refusal the delete path meets is the
 * database's and not a fixture's.
 */
async function tagJournalLines(journalId: Buffer, contact: Buffer): Promise<void> {
  await sql`
    UPDATE journal_lines SET contact_id = ${contact} WHERE journal_id = ${journalId}
  `.execute(db.migrator);
}

/** A draft journal carrying one line that names `contact`. */
async function draftNaming(actor: ActorFixture, contact: Buffer): Promise<void> {
  const draftId = newUuidBuffer();

  await db.app
    .insertInto('journal_drafts')
    .values({ id: draftId, org_id: actor.orgId, created_by_user_id: actor.userId })
    .execute();

  await db.app
    .insertInto('journal_draft_lines')
    .values({
      org_id: actor.orgId,
      draft_id: draftId,
      line_number: 1,
      contact_id: contact,
      // A half-entered line is the ordinary state of a draft (`0002_ledger`), and
      // this one is as half-entered as it gets: the contact is the only thing on it.
      debit_minor: 0n,
      credit_minor: 0n,
    })
    .execute();
}

describe('contacts service', () => {
  describe('create, read, list, update', () => {
    it('round-trips a created contact through read and list', async () => {
      const actor = await actorIn(db);

      const created = await createContact(ACME, actor.ctx);

      expect(created).toMatchObject({
        code: null,
        displayName: 'Acme Supplies',
        legalName: null,
        email: null,
        phone: null,
        isCustomer: false,
        isVendor: true,
        notes: null,
        isActive: true,
      });

      const fetched = await getContact(created.id, actor.ctx);
      expect(fetched).toEqual(created);

      const listed = await listContacts({}, actor.ctx);
      expect(listed.items).toEqual([created]);
    });

    /**
     * The modelling decision `0002_ledger` argues for, asserted at the service.
     * A supplier who also buys from you is one row with both flags, not two rows
     * with two names to keep in step.
     */
    it('represents an entity that is both a customer and a vendor as one contact', async () => {
      const actor = await actorIn(db);

      const both = await createContact(
        { displayName: 'Bidirectional Ltd', isCustomer: true, isVendor: true },
        actor.ctx,
      );

      expect(both).toMatchObject({ isCustomer: true, isVendor: true });
      expect((await listContacts({ isCustomer: true }, actor.ctx)).items).toEqual([both]);
      expect((await listContacts({ isVendor: true }, actor.ctx)).items).toEqual([both]);
    });

    /**
     * Neither flag is required and the service must not invent one. A contact that
     * takes part in no subledger is the ordinary case for a party named on a
     * journal line — an employee reimbursement — and defaulting either flag to true
     * would put that party in a picker it does not belong in.
     */
    it('creates a contact that is neither customer nor vendor', async () => {
      const actor = await actorIn(db);

      const neither = await createContact({ displayName: 'A. Employee' }, actor.ctx);

      expect(neither).toMatchObject({ isCustomer: false, isVendor: false });
    });

    it('applies a partial update and leaves absent fields alone', async () => {
      const actor = await actorIn(db);
      const created = await createContact(
        { ...ACME, code: 'V-100', notes: 'Net 30 by agreement' },
        actor.ctx,
      );

      const updated = await updateContact(created.id, { displayName: 'Acme Ltd' }, actor.ctx);

      expect(updated.displayName).toBe('Acme Ltd');
      expect(updated.code).toBe('V-100');
      expect(updated.notes).toBe('Net 30 by agreement');
      expect(updated.isVendor).toBe(true);
      expect(updated.id).toBe(created.id);
    });

    it('clears a nullable field with an explicit null and rejects an empty patch', async () => {
      const actor = await actorIn(db);
      const created = await createContact(
        { ...ACME, legalName: 'Acme Supplies Limited', email: 'ap@acme.test', notes: 'Temporary' },
        actor.ctx,
      );

      const cleared = await updateContact(
        created.id,
        { legalName: null, email: null, notes: null },
        actor.ctx,
      );
      expect(cleared).toMatchObject({ legalName: null, email: null, notes: null });

      await expect(updateContact(created.id, {}, actor.ctx)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('trims a code so the uniqueness key sees the value the user sees', async () => {
      const actor = await actorIn(db);

      const created = await createContact({ ...ACME, code: '  V-100  ' }, actor.ctx);
      expect(created.code).toBe('V-100');
    });

    it('trims an email before validating it, so a pasted address is accepted', async () => {
      const actor = await actorIn(db);

      const created = await createContact({ ...ACME, email: '  ap@acme.test ' }, actor.ctx);
      expect(created.email).toBe('ap@acme.test');

      await expect(
        createContact({ displayName: 'X', email: 'not-an-email' }, actor.ctx),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses a duplicate code within an org and permits it across orgs', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      await createContact({ ...ACME, code: 'V-100' }, mine.ctx);
      await expect(createContact({ ...ACME, code: 'V-100' }, theirs.ctx)).resolves.toBeDefined();

      // Compared case-insensitively under `utf8mb4_0900_ai_ci`, so this is the same
      // code and not a second one.
      const error = await createContact({ ...ACME, code: 'v-100' }, mine.ctx).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ConflictError);
      expect(toWireError(error)).toMatchObject({ code: 'conflict', status: 409 });
    });

    /**
     * `uq_contacts_org_code` treats NULLs as distinct, so an org that does not
     * number its contacts is not forced to invent numbers. This is the reason the
     * column is nullable at all and the reason the conflict translation ignores a
     * null code — see `translateDuplicateCode`.
     */
    it('permits any number of contacts with no code', async () => {
      const actor = await actorIn(db);

      await createContact({ displayName: 'One' }, actor.ctx);
      await createContact({ displayName: 'Two' }, actor.ctx);

      expect((await listContacts({}, actor.ctx)).items).toHaveLength(2);
    });

    it('filters by customer, vendor, and active flags', async () => {
      const actor = await actorIn(db);

      const customer = await createContact(
        { displayName: 'Buyer Co', isCustomer: true },
        actor.ctx,
      );
      const vendor = await createContact({ displayName: 'Seller Co', isVendor: true }, actor.ctx);
      const retired = await createContact({ displayName: 'Gone Co', isCustomer: true }, actor.ctx);
      await deactivateContact(retired.id, actor.ctx);

      const customers = await listContacts({ isCustomer: true }, actor.ctx);
      expect(customers.items.map((contact) => contact.id).sort()).toEqual(
        [customer.id, retired.id].sort(),
      );

      const vendors = await listContacts({ isVendor: true }, actor.ctx);
      expect(vendors.items.map((contact) => contact.id)).toEqual([vendor.id]);

      const activeCustomers = await listContacts({ isCustomer: true, isActive: true }, actor.ctx);
      expect(activeCustomers.items.map((contact) => contact.id)).toEqual([customer.id]);

      const inactive = await listContacts({ isActive: false }, actor.ctx);
      expect(inactive.items.map((contact) => contact.id)).toEqual([retired.id]);
    });

    it('lists only the caller org’s contacts', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      const ours = await createContact(ACME, mine.ctx);
      await createContact({ displayName: 'Their Customer', isCustomer: true }, theirs.ctx);

      expect((await listContacts({}, mine.ctx)).items).toEqual([ours]);
    });
  });

  /**
   * The divergence from D-27, asserted where it is implemented.
   *
   * An account's code is immutable because the chart is ordered by it and because
   * a journal cites it. Neither holds for a contact: the list is ordered by
   * `(created_at, id)` and a posted line names the row, not the code. If a future
   * ticket reverses this, these are the tests that fail — which is the intent.
   */
  describe('a contact code is mutable', () => {
    it('renumbers a contact, and gives up a code entirely', async () => {
      const actor = await actorIn(db);
      const created = await createContact({ ...ACME, code: 'V-100' }, actor.ctx);

      const renumbered = await updateContact(created.id, { code: 'V-200' }, actor.ctx);
      expect(renumbered.code).toBe('V-200');

      const uncoded = await updateContact(created.id, { code: null }, actor.ctx);
      expect(uncoded.code).toBeNull();

      // The number it gave up is now free for another contact, which is the point
      // of allowing it to be given up.
      const other = await createContact({ displayName: 'Successor', code: 'V-200' }, actor.ctx);
      expect(other.code).toBe('V-200');
    });

    it('refuses to move a code onto a contact that would collide', async () => {
      const actor = await actorIn(db);
      await createContact({ displayName: 'Holder', code: 'V-100' }, actor.ctx);
      const other = await createContact({ displayName: 'Claimant', code: 'V-200' }, actor.ctx);

      const error = await updateContact(other.id, { code: 'V-100' }, actor.ctx).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ConflictError);
      // Unchanged, so the refusal left the contact as it was.
      expect((await getContact(other.id, actor.ctx)).code).toBe('V-200');
    });

    /**
     * Renaming is what makes the ordering choice matter, so it is asserted here as
     * well as in `pagination.test.ts`: the field most likely to be edited is
     * `displayName`, which is exactly why no cursor into this list names it.
     */
    it('renames a contact without disturbing its position in the list', async () => {
      const actor = await actorIn(db);
      await createContact({ displayName: 'Aardvark Ltd' }, actor.ctx);
      const second = await createContact({ displayName: 'Zenith Ltd' }, actor.ctx);

      /**
       * The order *before* the rename is the baseline, rather than creation order.
       * `contacts.created_at` is `DATETIME(3)` and two creates in one test land in the
       * same millisecond often enough to matter, so the keyset falls through to the
       * random UUID and creation order is not what the list returns — this test failed
       * about one run in three when it asserted otherwise.
       *
       * That tie is not a defect: the ordering only has to be *total and stable*, which
       * a random tiebreak is, or a cursor could skip a row (D-21). Reading the baseline
       * is also the stronger assertion, because it states the claim being made — the
       * rename moved nothing — rather than a fact about insertion that happens to
       * coincide with it when the clock cooperates.
       */
      const before = (await listContacts({}, actor.ctx)).items.map((contact) => contact.id);

      await updateContact(second.id, { displayName: 'Acme Ltd' }, actor.ctx);

      const after = (await listContacts({}, actor.ctx)).items.map((contact) => contact.id);
      expect(after).toEqual(before);
      expect(after).toHaveLength(2);
    });
  });

  describe('deactivate, reactivate, delete', () => {
    it('deletes a contact nothing in the ledger names', async () => {
      const actor = await actorIn(db);
      const created = await createContact(ACME, actor.ctx);

      await deleteContact(created.id, actor.ctx);

      await expect(getContact(created.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listContacts({}, actor.ctx)).items).toEqual([]);
    });

    /**
     * The rule this ticket exists to get right, and it is proven against a real
     * `journal_lines` row under `fk_journal_lines_contact` rather than against the
     * service's own check — a test that asserted the pre-check would pass against a
     * service whose pre-check was the *only* thing standing there, which is
     * precisely the arrangement `deleteContact` argues is not enough.
     */
    it('refuses to delete a contact a posted journal line names', async () => {
      const actor = await actorIn(db);
      const created = await createContact(ACME, actor.ctx);
      const journal = await db.factories.journal({ orgId: actor.orgId });

      await tagJournalLines(journal.id, uuidToBuffer(created.id));

      const error = await deleteContact(created.id, actor.ctx).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      // The precondition token is what a client branches on; the prose is not.
      expect(toWireError(error)).toMatchObject({
        code: 'precondition_failed',
        status: 412,
        details: { precondition: 'contact_has_postings' },
      });

      // Still there, and still deactivatable — which is the point of refusing.
      const deactivated = await deactivateContact(created.id, actor.ctx);
      expect(deactivated.isActive).toBe(false);
      expect((await getContact(created.id, actor.ctx)).isActive).toBe(false);
    });

    /**
     * The database's refusal, independent of the service's.
     *
     * `deleteContact`'s pre-check is a message and `fk_journal_lines_contact` is
     * the guarantee. This asserts the guarantee directly: even the migrator — which
     * holds every privilege the application does not — cannot remove a contact a
     * posted line names.
     */
    it('is refused by the foreign key even for a connection the service does not use', async () => {
      const actor = await actorIn(db);
      const created = await createContact(ACME, actor.ctx);
      const journal = await db.factories.journal({ orgId: actor.orgId });

      await tagJournalLines(journal.id, uuidToBuffer(created.id));

      await expect(
        db.migrator.deleteFrom('contacts').where('id', '=', uuidToBuffer(created.id)).execute(),
      ).rejects.toMatchObject({ errno: 1451 });
    });

    /**
     * A draft is not a posting, so it gets its own token and its own remedy.
     *
     * `fk_journal_draft_lines_contact` is `ON DELETE RESTRICT` too, and the errno
     * it raises is the same 1451 a posted line raises — so without this pre-check
     * the caller would be told to deactivate a contact over a reference they could
     * have removed by editing the draft.
     */
    it('refuses to delete a contact an unposted draft names, and says why', async () => {
      const actor = await actorIn(db);
      const created = await createContact(ACME, actor.ctx);

      await draftNaming(actor, uuidToBuffer(created.id));

      const error = await deleteContact(created.id, actor.ctx).catch((caught: unknown) => caught);

      expect(toWireError(error)).toMatchObject({
        code: 'precondition_failed',
        status: 412,
        details: { precondition: 'contact_on_draft' },
      });

      // Removing the draft line removes the obstacle, which is the difference the
      // separate token exists to communicate.
      await db.app
        .deleteFrom('journal_draft_lines')
        .where('contact_id', '=', uuidToBuffer(created.id))
        .execute();
      await expect(deleteContact(created.id, actor.ctx)).resolves.toBeUndefined();
    });

    /**
     * When a contact carries both kinds of reference, the permanent one is the one
     * reported: telling someone to edit a draft would imply the contact becomes
     * deletable afterwards, and it does not.
     */
    it('reports the posting when a contact is on both a posted line and a draft', async () => {
      const actor = await actorIn(db);
      const created = await createContact(ACME, actor.ctx);
      const journal = await db.factories.journal({ orgId: actor.orgId });

      await tagJournalLines(journal.id, uuidToBuffer(created.id));
      await draftNaming(actor, uuidToBuffer(created.id));

      const error = await deleteContact(created.id, actor.ctx).catch((caught: unknown) => caught);

      expect(toWireError(error)).toMatchObject({
        details: { precondition: 'contact_has_postings' },
      });
    });

    it('deactivates and reactivates idempotently', async () => {
      const actor = await actorIn(db);
      const created = await createContact(ACME, actor.ctx);

      expect((await deactivateContact(created.id, actor.ctx)).isActive).toBe(false);
      expect((await deactivateContact(created.id, actor.ctx)).isActive).toBe(false);
      expect((await reactivateContact(created.id, actor.ctx)).isActive).toBe(true);
      expect((await reactivateContact(created.id, actor.ctx)).isActive).toBe(true);
    });
  });

  /**
   * A7: a cross-org read returns nothing and does not leak existence.
   *
   * The assertion is deep equality of the serialized errors rather than "both are
   * 404s". Two 404s that differ in `message` or in `details.resource` are still an
   * existence oracle, and the only reason they cannot differ here is that both
   * reach the same `assertFound` call.
   */
  describe('A7 — cross-org reads are indistinguishable from misses', () => {
    it('answers a cross-org id exactly as it answers a nonexistent one', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirContact = await createContact(ACME, theirs.ctx);
      const nonexistent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

      const crossOrg = await getContact(theirContact.id, mine.ctx).catch((error: unknown) => error);
      const missing = await getContact(nonexistent, mine.ctx).catch((error: unknown) => error);

      expect(crossOrg).toBeInstanceOf(NotFoundError);
      expect(toWireError(crossOrg)).toEqual(toWireError(missing));
      expect(toWireError(crossOrg)).toEqual({
        code: 'not_found',
        status: 404,
        message: 'No such contact.',
        details: { resource: 'contact' },
      });
    });

    it('answers a malformed id the same way, rather than as a validation failure', async () => {
      const mine = await actorIn(db);
      const nonexistent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

      const malformed = await getContact('not-a-uuid', mine.ctx).catch((error: unknown) => error);
      const missing = await getContact(nonexistent, mine.ctx).catch((error: unknown) => error);

      expect(toWireError(malformed)).toEqual(toWireError(missing));
    });

    it('does not let a cross-org contact be updated, deactivated, or deleted', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirContact = await createContact(ACME, theirs.ctx);

      await expect(
        updateContact(theirContact.id, { displayName: 'Mine now' }, mine.ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deactivateContact(theirContact.id, mine.ctx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(deleteContact(theirContact.id, mine.ctx)).rejects.toBeInstanceOf(NotFoundError);

      // Untouched, as seen by its own org.
      expect(await getContact(theirContact.id, theirs.ctx)).toEqual(theirContact);
    });

    /**
     * A code is unique per org, so a caller could otherwise probe another org's
     * numbering by watching for a conflict. The unique key is `(org_id, code)`, so
     * the same code in a different org is a different key and not a conflict at
     * all — which is what makes naming the code in the conflict message safe.
     */
    it('does not report a conflict against another org’s code', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      await createContact({ ...ACME, code: 'SECRET-1' }, theirs.ctx);

      await expect(createContact({ ...ACME, code: 'SECRET-1' }, mine.ctx)).resolves.toBeDefined();
    });
  });

  /**
   * Enforcement is service-layer only (spec §2.4, §5), so these assertions are made
   * against the service with no transport in the picture. `read_only` is a seeded
   * system role holding every `*.read` code and no writes — migration
   * `0001_tenancy` — so it is the real pair the catalog ships rather than a bundle
   * invented here.
   */
  describe('requirePermission', () => {
    it('refuses every mutating operation to a role without contacts.write', async () => {
      const owner = await actorIn(db, 'owner');
      const existing = await createContact(ACME, owner.ctx);

      const reader = await actorIn(db, 'readOnly');

      await expect(createContact(ACME, reader.ctx)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        updateContact(existing.id, { displayName: 'Renamed' }, reader.ctx),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(deactivateContact(existing.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(reactivateContact(existing.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(deleteContact(existing.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it('allows a role holding contacts.read to read what a writer created', async () => {
      const owner = await actorIn(db);
      const created = await createContact(ACME, owner.ctx);

      const readerUser = await db.factories.user();
      await db.factories.orgMember({
        orgId: owner.orgId,
        userId: readerUser.id,
        roleId: systemRoleId('readOnly'),
      });
      const readerCtx = contextFor(owner.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, readerUser.uuid);

      expect(await getContact(created.id, readerCtx)).toEqual(created);
      expect((await listContacts({}, readerCtx)).items).toEqual([created]);
    });

    /**
     * Every one of the six seeded roles carries `contacts.read`, so proving the read
     * gate exists needs a role that does not — which means a custom role with an
     * empty bundle. Custom roles are v2 (`roles.org_id` is non-null for them) and
     * the harness clears them between tests, so this creates one directly.
     */
    it('refuses a read to a role carrying no permissions', async () => {
      const owner = await actorIn(db);
      const created = await createContact(ACME, owner.ctx);

      const roleId = newUuidBuffer();
      await db.app
        .insertInto('roles')
        .values({
          id: roleId,
          org_id: owner.orgId,
          code: 'nothing',
          name: 'Nothing',
          description: 'Holds no permissions.',
          is_system: 0,
        })
        .execute();

      const powerless = contextFor(owner.orgUuid, bufferToUuid(roleId), owner.userUuid);

      await expect(getContact(created.id, powerless)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(listContacts({}, powerless)).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('checks authority before validating the payload', async () => {
      const reader = await actorIn(db, 'readOnly');

      // The payload is invalid in three ways. An unauthorized caller must learn only
      // that they are unauthorized: a validation failure here would describe the
      // shape of an operation they may not perform.
      const error = await createContact(
        { displayName: '', code: '', email: 'nope' },
        reader.ctx,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PermissionDeniedError);
    });
  });
});
