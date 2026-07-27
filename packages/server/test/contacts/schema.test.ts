import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer } from '../../src/db';
import { useTestDatabase } from '../db';

/**
 * The `contacts` schema (OB-032).
 *
 * DDL only. Create, list, archive are OB-036's, and there is deliberately no wire
 * schema yet — a request shape for a resource whose rules are not written is the
 * mistake `parent_account_id` avoided through M1.
 *
 * What is worth asserting now is the part that is expensive to change later: that
 * one table with two flags represents the entity that is both, and that a
 * `journal_lines.contact_id` naming another org's contact is unrepresentable
 * rather than merely unchecked.
 */

/** `ER_NO_REFERENCED_ROW_2` — the parent row a foreign key names does not exist. */
const NO_REFERENCED_ROW_ERRNO = 1452;

/** `ER_ROW_IS_REFERENCED_2` — a child still points at this row. */
const ROW_IS_REFERENCED_ERRNO = 1451;

const db = useTestDatabase();

async function contact(
  orgId: Buffer,
  values: {
    readonly code?: string | null;
    readonly isCustomer?: boolean;
    readonly isVendor?: boolean;
  } = {},
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      code: values.code ?? null,
      display_name: 'Acme Supplies',
      is_customer: values.isCustomer === true ? 1 : 0,
      is_vendor: values.isVendor === true ? 1 : 0,
    })
    .execute();

  return id;
}

describe('contacts', () => {
  /**
   * The reason this is one table and not two.
   *
   * A supplier who also buys from you is one legal entity, and modelling it as two
   * rows means two names to keep in step and an M3 report that has to know they are
   * the same party. The flags being independent is what makes "both" the ordinary
   * case rather than a duplication.
   */
  it('represents an entity that is both a customer and a vendor as one row', async () => {
    const org = await db.factories.org();
    const id = await contact(org.id, { isCustomer: true, isVendor: true });

    const row = await db.app
      .selectFrom('contacts')
      .select(['is_customer', 'is_vendor', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(row).toEqual({ is_customer: 1, is_vendor: 1, is_active: 1 });
  });

  /**
   * Neither flag is required, and that is a decision rather than an omission — see
   * the `contacts` block in `0002_ledger`. A line tagged with a contact states who the amount
   * is with, which is independent of whether that party is ever invoiced or billed.
   */
  it('permits a contact that is neither customer nor vendor', async () => {
    const org = await db.factories.org();

    await expect(contact(org.id)).resolves.toBeDefined();
  });

  it('scopes codes per org, and permits any number of contacts without one', async () => {
    const mine = await db.factories.org();
    const theirs = await db.factories.org();

    await contact(mine.id, { code: 'ACME' });
    await expect(contact(theirs.id, { code: 'ACME' })).resolves.toBeDefined();
    await expect(contact(mine.id, { code: 'ACME' })).rejects.toMatchObject({ errno: 1062 });

    // MySQL treats NULLs as distinct in a unique index, so an org that does not
    // number its contacts is not forced to invent numbers.
    await contact(mine.id, { code: null });
    await expect(contact(mine.id, { code: null })).resolves.toBeDefined();
  });

  /**
   * The composite foreign key doing the work the README describes.
   *
   * `journal_lines` references `contacts (org_id, id)` rather than `contacts (id)`,
   * so a line whose `org_id` disagrees with its contact's has nothing to point at.
   * This is asserted rather than assumed because it is the property that makes the
   * denormalized `journal_lines.org_id` safe rather than a correctness risk.
   *
   * Raw SQL and the migrator connection, deliberately: this is a statement about
   * the schema, and the application holds no `UPDATE` on `journal_lines` by design
   * (`0004_app_grants`), so there is no application path that could make it.
   */
  it('makes a cross-org contact on a journal line unrepresentable', async () => {
    const journal = await db.factories.journal();
    const stranger = await db.factories.org();

    const theirContact = await contact(stranger.id, { isCustomer: true });
    const myContact = await contact(journal.orgId, { isCustomer: true });

    await expect(
      sql`
        UPDATE journal_lines SET contact_id = ${theirContact} WHERE journal_id = ${journal.id}
      `.execute(db.migrator),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW_ERRNO });

    // The same statement with this org's own contact is accepted, so the refusal
    // above was the tenancy key and not the column.
    await sql`
      UPDATE journal_lines SET contact_id = ${myContact} WHERE journal_id = ${journal.id}
    `.execute(db.migrator);

    const { rows } = await sql<{ tagged: number }>`
      SELECT COUNT(*) AS tagged FROM journal_lines WHERE contact_id = ${myContact}
    `.execute(db.migrator);
    expect(Number(rows[0]?.tagged)).toBe(2);
  });

  /**
   * `ON DELETE RESTRICT`, matching `fk_journal_lines_account`. A contact a posted
   * line names is part of what that entry says, so removing it would change the
   * meaning of a journal that is supposed to be immutable — the same argument
   * `deleteAccount` makes about an account with postings.
   *
   * Attempted as the migrator, and that is temporary rather than principled: the
   * app user holds no `DELETE` on `contacts` until `'contacts'` joins
   * `0004_app_grants`'s `MUTABLE_TABLES` (OB-034), so as the app user this would
   * be refused for the wrong reason — 1142 rather than 1451 — and would keep
   * passing after the grant landed while proving something else. When the grant
   * arrives this should move to `db.app`.
   */
  it('refuses to delete a contact a journal line names', async () => {
    const journal = await db.factories.journal();
    const tagged = await contact(journal.orgId, { isVendor: true });

    await sql`
      UPDATE journal_lines SET contact_id = ${tagged} WHERE journal_id = ${journal.id}
    `.execute(db.migrator);

    await expect(
      db.migrator.deleteFrom('contacts').where('id', '=', tagged).execute(),
    ).rejects.toMatchObject({ errno: ROW_IS_REFERENCED_ERRNO });
  });

  /**
   * Untagged is the normal state of a journal line, and it has to stay expressible:
   * a nullable column that something quietly defaulted would make every posting
   * claim a counterparty it does not have.
   */
  it('leaves contact_id null on an ordinary posting', async () => {
    const journal = await db.factories.journal();

    const lines = await db.app
      .selectFrom('journal_lines')
      .select('contact_id')
      .where('journal_id', '=', journal.id)
      .execute();

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.contact_id === null)).toBe(true);
  });
});
