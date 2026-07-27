import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * The journal-draft schema (OB-034, ROADMAP D-19).
 *
 * Two claims are being proved, and they pull in opposite directions, which is why
 * the allowlist in `0004_app_grants` is the milestone's most load-bearing edit:
 *
 *  - the app user *can* update and delete drafts, or the state D-16 promised —
 *    an entry that has not reached the ledger and may be edited or discarded —
 *    does not exist at all;
 *  - the app user still *cannot* update or delete journals, which is gate A6 and
 *    is asserted unchanged in `test/db/harness.test.ts` and
 *    `test/enforcement/grants.test.ts`.
 *
 * Everything mutable here is written through a real `openbooks_app` connection, so
 * the first claim is a statement about the grant rather than about the harness.
 */
const db = useTestDatabase();

const DUPLICATE_KEY = 1062;
const NO_REFERENCED_ROW = 1452;
const CHECK_VIOLATED = 3819;

async function createDraft(orgId: Buffer, userId: Buffer): Promise<Buffer> {
  const id = newUuidBuffer();
  await sql`
    INSERT INTO journal_drafts (id, org_id, created_by_user_id, memo)
    VALUES (${id}, ${orgId}, ${userId}, ${'Rent, splitting across departments'})
  `.execute(db.app);
  return id;
}

describe('journal_drafts', () => {
  it('lets the app user create, edit, and discard a draft', async () => {
    const ledger = await db.factories.ledger();
    const connection = await db.openAppConnection();

    try {
      const draftId = newUuidBuffer();
      await sql`
        INSERT INTO journal_drafts (id, org_id, created_by_user_id, memo)
        VALUES (${draftId}, ${ledger.org.id}, ${ledger.user.id}, ${'First pass'})
      `.execute(connection.db);

      await sql`
        UPDATE journal_drafts SET memo = ${'Second pass'} WHERE id = ${draftId}
      `.execute(connection.db);

      const { rows } = await sql<{ memo: string }>`
        SELECT memo FROM journal_drafts WHERE id = ${draftId}
      `.execute(connection.db);
      expect(rows[0]!.memo).toBe('Second pass');

      await sql`DELETE FROM journal_drafts WHERE id = ${draftId}`.execute(connection.db);

      const { rows: after } = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM journal_drafts WHERE id = ${draftId}
      `.execute(connection.db);
      expect(Number(after[0]!.count)).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it('carries no sequence number', async () => {
    // D-14's gapless guarantee is only gapless because numbers are allocated at post
    // from the counter row. A draft that reserved one and was discarded would leave a
    // hole, and a hole in a journal sequence is indistinguishable from a deleted
    // entry. Asserted against the live schema rather than trusted to the DDL: the
    // column would be added by someone reasonable, in good faith, to show a number in
    // the UI before posting.
    const { rows } = await sql<{ column_name: string }>`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND TABLE_NAME IN ('journal_drafts', 'journal_draft_lines')
        AND COLUMN_NAME LIKE '%sequence%'
    `.execute(db.migrator);

    expect(rows).toEqual([]);
  });

  it('discards the lines with the draft', async () => {
    const ledger = await db.factories.ledger();
    const connection = await db.openAppConnection();

    try {
      const draftId = await createDraft(ledger.org.id, ledger.user.id);
      await sql`
        INSERT INTO journal_draft_lines (org_id, draft_id, line_number, account_id, debit_minor)
        VALUES (${ledger.org.id}, ${draftId}, 1, ${ledger.debitAccount.id}, 150000)
      `.execute(connection.db);

      await sql`DELETE FROM journal_drafts WHERE id = ${draftId}`.execute(connection.db);

      const { rows } = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM journal_draft_lines WHERE draft_id = ${draftId}
      `.execute(connection.db);
      expect(Number(rows[0]!.count)).toBe(0);
    } finally {
      await connection.close();
    }
  });

  it('accepts a half-finished, one-sided, unbalanced draft', async () => {
    // The ledger's invariants are absent here on purpose: `journal_lines` would reject
    // every one of these rows. A draft is the state of a form in progress, and a form
    // that cannot be saved until it is already correct is not a draft.
    const ledger = await db.factories.ledger();
    const connection = await db.openAppConnection();

    try {
      const draftId = await createDraft(ledger.org.id, ledger.user.id);

      await expect(
        sql`
          INSERT INTO journal_draft_lines
            (org_id, draft_id, line_number, account_id, debit_minor, credit_minor)
          VALUES
            (${ledger.org.id}, ${draftId}, 1, ${ledger.debitAccount.id}, 150000, 0),
            (${ledger.org.id}, ${draftId}, 2, ${ledger.creditAccount.id}, 0, 25),
            (${ledger.org.id}, ${draftId}, 3, NULL, 0, 0),
            (${ledger.org.id}, ${draftId}, 4, ${ledger.debitAccount.id}, 100, 100)
        `.execute(connection.db),
      ).resolves.toBeDefined();

      const { rows } = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM journal_draft_lines WHERE draft_id = ${draftId}
      `.execute(connection.db);
      expect(Number(rows[0]!.count)).toBe(4);
    } finally {
      await connection.close();
    }
  });

  it('refuses a negative amount, which is not incompleteness', async () => {
    const ledger = await db.factories.ledger();
    const draftId = await createDraft(ledger.org.id, ledger.user.id);

    await expect(
      sql`
        INSERT INTO journal_draft_lines (org_id, draft_id, line_number, account_id, debit_minor)
        VALUES (${ledger.org.id}, ${draftId}, 1, ${ledger.debitAccount.id}, -500)
      `.execute(db.app),
    ).rejects.toMatchObject({ errno: CHECK_VIOLATED });
  });

  it('refuses two lines with the same number', async () => {
    const ledger = await db.factories.ledger();
    const draftId = await createDraft(ledger.org.id, ledger.user.id);

    await sql`
      INSERT INTO journal_draft_lines (org_id, draft_id, line_number, account_id)
      VALUES (${ledger.org.id}, ${draftId}, 1, ${ledger.debitAccount.id})
    `.execute(db.app);

    await expect(
      sql`
        INSERT INTO journal_draft_lines (org_id, draft_id, line_number, account_id)
        VALUES (${ledger.org.id}, ${draftId}, 1, ${ledger.creditAccount.id})
      `.execute(db.app),
    ).rejects.toMatchObject({ errno: DUPLICATE_KEY });
  });

  it('refuses an account from another org, and a draft line from another org', async () => {
    const [mine, theirs] = await Promise.all([db.factories.ledger(), db.factories.ledger()]);
    const draftId = await createDraft(mine.org.id, mine.user.id);

    await expect(
      sql`
        INSERT INTO journal_draft_lines (org_id, draft_id, line_number, account_id)
        VALUES (${mine.org.id}, ${draftId}, 1, ${theirs.debitAccount.id})
      `.execute(db.app),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });

    await expect(
      sql`
        INSERT INTO journal_draft_lines (org_id, draft_id, line_number, account_id)
        VALUES (${theirs.org.id}, ${draftId}, 1, ${theirs.debitAccount.id})
      `.execute(db.app),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });
  });

  it('refuses a draft in an org that does not exist', async () => {
    // The schema ties a draft to an org and to a user; it deliberately does not tie
    // the user to *membership* of that org, which is a service-layer authorization
    // question (spec §5) and not something a foreign key can answer. What it does
    // catch is an org that does not exist.
    const user = await db.factories.user();

    await expect(
      sql`
        INSERT INTO journal_drafts (id, org_id, created_by_user_id)
        VALUES (${newUuidBuffer()}, ${newUuidBuffer()}, ${user.id})
      `.execute(db.app),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });
  });
});
