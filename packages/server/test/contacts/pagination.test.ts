import { PAGE_SIZE_MAX } from '@openbooks/shared-types';
import type { Contact } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { uuidToBuffer } from '../../src/db';
import { ValidationError } from '../../src/errors';
import {
  createContact,
  deleteContact,
  listContacts,
  updateContact,
} from '../../src/modules/contacts';
import { actorIn, useServiceDatabase } from './support';

/**
 * The list envelope and keyset pagination, on contacts (D-21).
 *
 * This file carries the claim the ordering was chosen for, and it is a claim the
 * chart of accounts cannot make. D-27 answered "a keyset over a mutable column
 * drops rows" by removing the mutability — an account's code cannot change, so the
 * failure is unreachable there and the accounts suite asserts its absence by
 * asserting that the operation does not exist. A contact's name *must* stay
 * editable, so the failure is reachable in principle and is excluded by the
 * ordering instead. The test that matters is therefore the one that renames a
 * contact mid-page and finds it still on exactly one page.
 *
 * `created_at` is stamped explicitly. Two contacts created in the same millisecond
 * share it, and the tie is broken by a random `id`, so an unstamped fixture would
 * come back in an order no assertion could predict — the problem OB-031 hit before
 * D-27 and the reason the accounts suite no longer stamps anything.
 */
const db = useServiceDatabase();

/**
 * `count` contacts, one millisecond apart, named in reverse alphabetical order so
 * nothing here can pass by accidentally agreeing with a name sort.
 */
async function contactsIn(count: number, ctx: RequestContext): Promise<readonly Contact[]> {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  const created: Contact[] = [];

  for (let index = 0; index < count; index += 1) {
    const contact = await createContact(
      { displayName: `${String.fromCharCode(90 - index)} Company`, code: `C-${String(index)}` },
      ctx,
    );

    // `contacts` is in `0004_app_grants`'s mutable allowlist, so this runs as the
    // application rather than the migrator — the same identity the service uses.
    await db.app
      .updateTable('contacts')
      .set({ created_at: new Date(base + index) })
      .where('id', '=', uuidToBuffer(contact.id))
      .execute();

    created.push(contact);
  }

  return created;
}

describe('paginating contacts', () => {
  it('returns items and a cursor, and pages the whole list exactly once', async () => {
    const actor = await actorIn(db);
    const created = await contactsIn(5, actor.ctx);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = await listContacts(
        { limit: 2, ...(cursor === null ? {} : { cursor }) },
        actor.ctx,
      );
      seen.push(...page.items.map((contact) => contact.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(created.map((contact) => contact.id));
  });

  /**
   * The whole argument for `(created_at, id)`, stated as a test.
   *
   * The reader has taken the first two contacts. `Y Company` — already read — is
   * renamed to something that sorts last, and `W Company` — not yet read — is
   * renamed to something that sorts first. Under a `display_name` ordering the
   * second of those moves *behind* a cursor that has already passed it and appears
   * on no page at all: a contact silently missing from a contact list, which is
   * the failure D-21 chose keyset to eliminate and which D-27 removed from the
   * chart of accounts by a route not available here. The cursor names a position in
   * `(created_at, id)`, neither of which a rename touches, so both rows land
   * exactly where they did before.
   */
  it('loses nothing when contacts are renamed while the list is being paged', async () => {
    const actor = await actorIn(db);
    const created = await contactsIn(6, actor.ctx);

    const page1 = await listContacts({ limit: 2 }, actor.ctx);
    expect(page1.items.map((contact) => contact.displayName)).toEqual(['Z Company', 'Y Company']);

    const alreadyRead = created[1]?.id ?? '';
    const notYetRead = created[3]?.id ?? '';
    await updateContact(alreadyRead, { displayName: 'Zzzz Company' }, actor.ctx);
    await updateContact(notYetRead, { displayName: 'Aaaa Company', code: 'C-999' }, actor.ctx);

    const seen: string[] = [...page1.items.map((contact) => contact.id)];
    let cursor = page1.nextCursor;
    while (cursor !== null) {
      const page = await listContacts({ limit: 2, cursor }, actor.ctx);
      seen.push(...page.items.map((contact) => contact.id));
      cursor = page.nextCursor;
    }

    expect(seen).toEqual(created.map((contact) => contact.id));
    expect(new Set(seen).size).toBe(6);
  });

  /**
   * The `OFFSET` failure in its other form.
   *
   * The reader has taken the first two contacts; one of them is then deleted. Under
   * `OFFSET 2` the third contact has moved into position 2 and the next page starts
   * at position 3, so it is never returned. The cursor names the last row read, so
   * deleting a row before it changes nothing about where the next page begins.
   */
  it('skips nothing when a row behind the cursor is deleted', async () => {
    const actor = await actorIn(db);
    const created = await contactsIn(6, actor.ctx);

    const page1 = await listContacts({ limit: 2 }, actor.ctx);
    expect(page1.items.map((contact) => contact.id)).toEqual([created[0]?.id, created[1]?.id]);

    // A contact nothing in the ledger names deletes freely — see `deleteContact`.
    await deleteContact(created[0]?.id ?? '', actor.ctx);

    const page2 = await listContacts({ limit: 2, cursor: page1.nextCursor ?? '' }, actor.ctx);
    expect(page2.items.map((contact) => contact.id)).toEqual([created[2]?.id, created[3]?.id]);

    const page3 = await listContacts({ limit: 2, cursor: page2.nextCursor ?? '' }, actor.ctx);
    expect(page3.items.map((contact) => contact.id)).toEqual([created[4]?.id, created[5]?.id]);
    expect(page3.nextCursor).toBeNull();
  });

  /**
   * A filtered page has to end where the next filtered page begins.
   *
   * The predicate is composed with the filters rather than applied to the
   * unfiltered list, which is why `selectContactsPage` adds the filters first. A
   * cursor minted against "vendors only" and resumed against a differently filtered
   * query is a client error this API cannot detect — the cursor is opaque and
   * carries no filter — so what is asserted is the case that must work.
   */
  it('pages a filtered list without leaking the rows the filter excluded', async () => {
    const actor = await actorIn(db);
    const all = await contactsIn(6, actor.ctx);

    const vendors = [all[1], all[3], all[5]];
    for (const contact of vendors) {
      await updateContact(contact?.id ?? '', { isVendor: true }, actor.ctx);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listContacts(
        { limit: 2, isVendor: true, ...(cursor === null ? {} : { cursor }) },
        actor.ctx,
      );
      seen.push(...page.items.map((contact) => contact.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(vendors.map((contact) => contact?.id));
  });

  /**
   * Refused rather than clamped: a client that asked for 1,000 and received 200
   * with no `nextCursor` cannot tell a truncated answer from a complete one. The
   * authority is `resolvePageLimit`, not the schema, because an MCP tool reaches
   * this service with no schema in front of it (spec §12).
   */
  it('refuses a page size outside the bounds, and a cursor it did not mint', async () => {
    const actor = await actorIn(db);
    await contactsIn(1, actor.ctx);

    await expect(listContacts({ limit: PAGE_SIZE_MAX + 1 }, actor.ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listContacts({ limit: 0 }, actor.ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(listContacts({ cursor: 'not-a-cursor' }, actor.ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
