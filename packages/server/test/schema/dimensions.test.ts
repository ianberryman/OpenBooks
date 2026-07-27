import { sql, type RawBuilder } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * The dimensions schema (OB-033, ROADMAP D-18).
 *
 * Every assertion here is about something the *database* refuses, because that is
 * what the ticket bought: `journal_line_dimensions` carries a denormalized
 * `dimension_id` and a denormalized `org_id`, and both are only safe if a
 * disagreement is inexpressible rather than merely unwritten by today's service.
 *
 * The first test is the load-bearing one. Acceptance B6 — "every report unsliced
 * equals its slices plus unassigned" — is false the moment one line carries two
 * values on one axis, and a report is a slow and confusing place to discover that.
 */
const db = useTestDatabase();

/** mysql2 errnos, named because a bare number in an expectation reads as noise. */
const DUPLICATE_KEY = 1062;
const NO_REFERENCED_ROW = 1452;
const ROW_IS_REFERENCED = 1451;
const ACCESS_DENIED = 1142;

interface Axis {
  readonly dimensionId: Buffer;
  readonly firstValueId: Buffer;
  readonly secondValueId: Buffer;
}

let codeSequence = 0;

async function createAxis(orgId: Buffer): Promise<Axis> {
  const dimensionId = newUuidBuffer();
  const firstValueId = newUuidBuffer();
  const secondValueId = newUuidBuffer();
  const code = `AXIS${(codeSequence += 1)}`;

  await sql`
    INSERT INTO dimensions (id, org_id, code, name)
    VALUES (${dimensionId}, ${orgId}, ${code}, ${'Department'})
  `.execute(db.app);

  await sql`
    INSERT INTO dimension_values (id, org_id, dimension_id, code, name)
    VALUES
      (${firstValueId}, ${orgId}, ${dimensionId}, ${'ONE'}, ${'One'}),
      (${secondValueId}, ${orgId}, ${dimensionId}, ${'TWO'}, ${'Two'})
  `.execute(db.app);

  return { dimensionId, firstValueId, secondValueId };
}

/** The id of a real posted line, which is what a tag hangs off. */
async function firstLineId(journalId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ id: bigint }>`
    SELECT id FROM journal_lines WHERE journal_id = ${journalId} ORDER BY line_number
  `.execute(db.app);
  return rows[0]!.id;
}

function tag(
  orgId: Buffer,
  lineId: bigint,
  dimensionId: Buffer,
  valueId: Buffer,
): RawBuilder<unknown> {
  return sql`
    INSERT INTO journal_line_dimensions (org_id, journal_line_id, dimension_id, dimension_value_id)
    VALUES (${orgId}, ${lineId}, ${dimensionId}, ${valueId})
  `;
}

describe('journal_line_dimensions', () => {
  it('refuses a second tag on the same line and the same axis', async () => {
    const journal = await db.factories.journal();
    const lineId = await firstLineId(journal.id);
    const axis = await createAxis(journal.orgId);

    await tag(journal.orgId, lineId, axis.dimensionId, axis.firstValueId).execute(db.app);

    // Two values on one axis for one line is the shape that breaks B6: a report
    // grouped by that axis would count the line's amount under both.
    await expect(
      tag(journal.orgId, lineId, axis.dimensionId, axis.secondValueId).execute(db.app),
    ).rejects.toMatchObject({ errno: DUPLICATE_KEY });

    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM journal_line_dimensions WHERE journal_line_id = ${lineId}
    `.execute(db.app);
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('accepts one tag per axis, so a line can be sliced several ways at once', async () => {
    const journal = await db.factories.journal();
    const lineId = await firstLineId(journal.id);
    const [department, project] = await Promise.all([
      createAxis(journal.orgId),
      createAxis(journal.orgId),
    ]);

    await tag(journal.orgId, lineId, department.dimensionId, department.firstValueId).execute(
      db.app,
    );
    await tag(journal.orgId, lineId, project.dimensionId, project.firstValueId).execute(db.app);

    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM journal_line_dimensions WHERE journal_line_id = ${lineId}
    `.execute(db.app);
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('tags a line rather than a journal, so one entry can split across values', async () => {
    // D-18's worked example: rent split across departments. Two lines of one journal
    // carrying different values on the same axis is the case header tagging cannot
    // express, and it has to be ordinary here.
    const journal = await db.factories.journal();
    const axis = await createAxis(journal.orgId);
    const { rows: lines } = await sql<{ id: bigint }>`
      SELECT id FROM journal_lines WHERE journal_id = ${journal.id} ORDER BY line_number
    `.execute(db.app);

    await tag(journal.orgId, lines[0]!.id, axis.dimensionId, axis.firstValueId).execute(db.app);
    await tag(journal.orgId, lines[1]!.id, axis.dimensionId, axis.secondValueId).execute(db.app);

    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM journal_line_dimensions WHERE org_id = ${journal.orgId}
    `.execute(db.app);
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('refuses a value that belongs to a different axis than the tag names', async () => {
    const journal = await db.factories.journal();
    const lineId = await firstLineId(journal.id);
    const [department, project] = await Promise.all([
      createAxis(journal.orgId),
      createAxis(journal.orgId),
    ]);

    // The denormalized dimension_id is what the B6 key is built on, so it must not be
    // able to disagree with the value's own axis — a tag filed under the wrong axis
    // moves money between slices without touching a journal.
    await expect(
      tag(journal.orgId, lineId, department.dimensionId, project.firstValueId).execute(db.app),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });
  });

  it("refuses a tag whose org is not the line's org", async () => {
    const [mine, theirs] = await Promise.all([db.factories.journal(), db.factories.journal()]);
    const lineId = await firstLineId(theirs.id);
    const axis = await createAxis(mine.orgId);

    await expect(
      tag(mine.orgId, lineId, axis.dimensionId, axis.firstValueId).execute(db.app),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });
  });

  it('refuses a dimension value whose axis belongs to another org', async () => {
    const [mine, theirs] = await Promise.all([db.factories.org(), db.factories.org()]);
    const foreignAxis = await createAxis(theirs.id);

    await expect(
      sql`
        INSERT INTO dimension_values (id, org_id, dimension_id, code, name)
        VALUES (${newUuidBuffer()}, ${mine.id}, ${foreignAxis.dimensionId}, ${'X'}, ${'X'})
      `.execute(db.app),
    ).rejects.toMatchObject({ errno: NO_REFERENCED_ROW });
  });

  it('refuses to delete a value a posted line carries, and the axis under it', async () => {
    const journal = await db.factories.journal();
    const lineId = await firstLineId(journal.id);
    const axis = await createAxis(journal.orgId);
    await tag(journal.orgId, lineId, axis.dimensionId, axis.firstValueId).execute(db.app);

    // OB-037 archives a used value instead of deleting it. This is why it has to:
    // deleting one would restate every report ever sliced by it, so the schema does
    // not permit the delete at all.
    await expect(
      sql`DELETE FROM dimension_values WHERE id = ${axis.firstValueId}`.execute(db.app),
    ).rejects.toMatchObject({ errno: ROW_IS_REFERENCED });

    await expect(
      sql`DELETE FROM dimensions WHERE id = ${axis.dimensionId}`.execute(db.app),
    ).rejects.toMatchObject({ errno: ROW_IS_REFERENCED });
  });

  it('deletes an unused value freely', async () => {
    const org = await db.factories.org();
    const axis = await createAxis(org.id);

    await sql`DELETE FROM dimension_values WHERE id = ${axis.secondValueId}`.execute(db.app);

    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM dimension_values WHERE dimension_id = ${axis.dimensionId}
    `.execute(db.app);
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

/**
 * The grants half, asserted from a real `openbooks_app` connection rather than the
 * pooled harness handle, for the reason spec §11 gives: a privilege claim proved as
 * anyone else is not a claim about production.
 *
 * `test/enforcement/grants.test.ts` already walks the whole matrix. These two exist
 * because the *classification* is the decision OB-033 made — settings mutable, tags
 * append-only — and a decision deserves a test that names it.
 */
describe('the app user, on the dimension tables', () => {
  it('may rename and archive a dimension and its values', async () => {
    const org = await db.factories.org();
    const axis = await createAxis(org.id);
    const connection = await db.openAppConnection();

    try {
      await sql`
        UPDATE dimensions SET name = ${'Cost centre'}, is_active = 0 WHERE id = ${axis.dimensionId}
      `.execute(connection.db);
      await sql`
        UPDATE dimension_values SET is_active = 0 WHERE id = ${axis.firstValueId}
      `.execute(connection.db);

      const { rows } = await sql<{ name: string; is_active: number }>`
        SELECT name, is_active FROM dimensions WHERE id = ${axis.dimensionId}
      `.execute(connection.db);
      expect(rows[0]!.name).toBe('Cost centre');
      expect(Number(rows[0]!.is_active)).toBe(0);
    } finally {
      await connection.close();
    }
  });

  /**
   * A tag is mutable even though the line it tags is not, which is the one asymmetry
   * in the grant split (see `0004_app_grants`). It holds because retagging moves no
   * money: the trial balance, the P&L and the balance sheet are identical before and
   * after, and only a sliced report divides the same total differently. The
   * alternative — reversing and reposting a financially correct journal to fix a
   * label — puts two entries in the ledger to record a change that was never a
   * transaction.
   *
   * The assertion that matters here is the *pair*: the app user may edit a tag and
   * still cannot touch the line. If a future grant edit widened `journal_lines` by
   * accident, this test would go on passing on its first half, which is why the
   * second half is in the same test rather than trusting the file next door.
   */
  it('may edit and remove a tag while the line it tags stays immutable', async () => {
    const journal = await db.factories.journal();
    const lineId = await firstLineId(journal.id);
    const axis = await createAxis(journal.orgId);
    const connection = await db.openAppConnection();

    try {
      await expect(
        tag(journal.orgId, lineId, axis.dimensionId, axis.firstValueId).execute(connection.db),
      ).resolves.toBeDefined();

      await expect(
        sql`
          UPDATE journal_line_dimensions SET dimension_value_id = ${axis.secondValueId}
          WHERE journal_line_id = ${lineId}
        `.execute(connection.db),
      ).resolves.toBeDefined();

      await expect(
        sql`DELETE FROM journal_line_dimensions WHERE journal_line_id = ${lineId}`.execute(
          connection.db,
        ),
      ).resolves.toBeDefined();

      // The line itself is untouched by any of that (gate A6).
      await expect(
        sql`UPDATE journal_lines SET memo = 'moved' WHERE id = ${lineId}`.execute(connection.db),
      ).rejects.toMatchObject({ errno: ACCESS_DENIED });
    } finally {
      await connection.close();
    }
  });
});
