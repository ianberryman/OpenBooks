import { sql, type RawBuilder } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * The Q schema — `automations`, `work_items`, `automation_annotations`
 * (initiative Q, M6; OB-200…210; ROADMAP D-99/D-100/D-118/D-119, `0018_automations`).
 *
 * `test/enforcement/grants.test.ts` already proves the full append-only/mutable
 * privilege matrix table-driven, `automation_annotations` and its two mutable
 * siblings included; this file is the schema-specific half `platform.test.ts`
 * and `subledger.test.ts` split off for their own tickets — the composite-key FK
 * a cross-org row cannot satisfy, the append-only claim demonstrated directly
 * against these three tables (rather than trusted to the generic matrix alone),
 * the status enum and its defaults, and the cascade a deleted automation takes
 * its queue and its notes with it.
 */
const db = useTestDatabase();

/** mysql2 errnos, named so a bare number in an expectation reads as intent. */
const NO_REFERENCED_ROW = 1452;
const ACCESS_DENIED = 1142;

interface Scene {
  readonly orgId: Buffer;
  readonly userId: Buffer;
}

async function scene(): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  return { orgId: org.id, userId: user.id };
}

/** The errno a statement failed with, or `null` if it succeeded. */
async function errnoOf(statement: Promise<unknown>): Promise<number | null> {
  try {
    await statement;
    return null;
  } catch (error) {
    const errno = (error as { readonly errno?: unknown }).errno;
    if (typeof errno !== 'number') throw error;
    return errno;
  }
}

interface AutomationOverrides {
  readonly id?: Buffer;
  readonly name?: string;
}

function insertAutomation(s: Scene, overrides: AutomationOverrides = {}): RawBuilder<unknown> {
  return sql`
    INSERT INTO automations
      (id, org_id, name, trigger_type, trigger_config, actions, created_by_user_id)
    VALUES (
      ${overrides.id ?? newUuidBuffer()}, ${s.orgId}, ${overrides.name ?? 'Test automation'},
      'manual', ${'{}'}, ${'[]'}, ${s.userId}
    )
  `;
}

interface WorkItemOverrides {
  readonly id?: Buffer;
  readonly orgId?: Buffer;
}

function insertWorkItem(
  s: Scene,
  automationId: Buffer | null,
  overrides: WorkItemOverrides = {},
): RawBuilder<unknown> {
  return sql`
    INSERT INTO work_items (id, org_id, automation_id, source_kind, source_ref, prompt, context)
    VALUES (
      ${overrides.id ?? newUuidBuffer()}, ${overrides.orgId ?? s.orgId}, ${automationId},
      ${'test'}, NULL, ${'Do the thing'}, ${'{}'}
    )
  `;
}

interface AnnotationOverrides {
  readonly id?: Buffer;
  readonly orgId?: Buffer;
}

function insertAnnotation(
  s: Scene,
  automationId: Buffer,
  runToken: Buffer,
  overrides: AnnotationOverrides = {},
): RawBuilder<unknown> {
  return sql`
    INSERT INTO automation_annotations (id, org_id, automation_id, run_token, note)
    VALUES (
      ${overrides.id ?? newUuidBuffer()}, ${overrides.orgId ?? s.orgId}, ${automationId},
      ${runToken}, ${'A note'}
    )
  `;
}

/**
 * The composite FK `(org_id, automation_id) REFERENCES automations (org_id, id)`,
 * on both `work_items` and `automation_annotations`. A single-column FK on
 * `automation_id` alone would let another org's automation id satisfy it — the
 * exact shape the tenancy pattern exists to forbid (`0018_automations`'s own
 * header, `subledger.test.ts`'s "a cross-org reference cannot be expressed").
 */
describe('a composite-key cross-org reference cannot be expressed', () => {
  it('refuses a work item naming another org’s automation', async () => {
    const [mine, theirs] = await Promise.all([scene(), scene()]);
    const theirAutomation = newUuidBuffer();
    await insertAutomation(theirs, { id: theirAutomation }).execute(db.app);

    expect(await errnoOf(insertWorkItem(mine, theirAutomation).execute(db.app))).toBe(
      NO_REFERENCED_ROW,
    );
  });

  it('refuses an annotation naming another org’s automation', async () => {
    const [mine, theirs] = await Promise.all([scene(), scene()]);
    const theirAutomation = newUuidBuffer();
    await insertAutomation(theirs, { id: theirAutomation }).execute(db.app);

    expect(
      await errnoOf(insertAnnotation(mine, theirAutomation, newUuidBuffer()).execute(db.app)),
    ).toBe(NO_REFERENCED_ROW);
  });

  /**
   * `automation_id` is nullable on `work_items` — a raw producer that enqueues
   * without an automation — and the composite FK is satisfied-when-null (MySQL
   * MATCH SIMPLE), so this is the control: a null names no automation at all,
   * in any org, and must not be refused as if it did.
   */
  it('accepts a work item naming no automation at all', async () => {
    const mine = await scene();
    expect(await errnoOf(insertWorkItem(mine, null).execute(db.app))).toBeNull();
  });
});

/**
 * `test/enforcement/grants.test.ts` proves this generically, table-driven, for
 * every table `0999_app_grants` names; this is the demonstration specific to Q's
 * own three, run directly against the harness's own app connection rather than
 * trusted to the matrix alone.
 */
describe('automation_annotations is append-only; automations and work_items are mutable', () => {
  it('refuses UPDATE and DELETE on automation_annotations for the app user', async () => {
    const s = await scene();
    const automationId = newUuidBuffer();
    await insertAutomation(s, { id: automationId }).execute(db.app);
    const annotationId = newUuidBuffer();
    await insertAnnotation(s, automationId, newUuidBuffer(), { id: annotationId }).execute(db.app);

    expect(
      await errnoOf(
        sql`UPDATE automation_annotations SET note = ${'edited'} WHERE id = ${annotationId}`.execute(
          db.app,
        ),
      ),
    ).toBe(ACCESS_DENIED);
    expect(
      await errnoOf(
        sql`DELETE FROM automation_annotations WHERE id = ${annotationId}`.execute(db.app),
      ),
    ).toBe(ACCESS_DENIED);
  });

  it('permits UPDATE and DELETE on automations for the app user', async () => {
    const s = await scene();
    const automationId = newUuidBuffer();
    await insertAutomation(s, { id: automationId }).execute(db.app);

    expect(
      await errnoOf(
        sql`UPDATE automations SET name = ${'Renamed'} WHERE id = ${automationId}`.execute(db.app),
      ),
    ).toBeNull();
    expect(
      await errnoOf(sql`DELETE FROM automations WHERE id = ${automationId}`.execute(db.app)),
    ).toBeNull();
  });

  it('permits UPDATE and DELETE on work_items for the app user', async () => {
    const s = await scene();
    const workItemId = newUuidBuffer();
    await insertWorkItem(s, null, { id: workItemId }).execute(db.app);

    expect(
      await errnoOf(
        sql`UPDATE work_items SET attempts = 1 WHERE id = ${workItemId}`.execute(db.app),
      ),
    ).toBeNull();
    expect(
      await errnoOf(sql`DELETE FROM work_items WHERE id = ${workItemId}`.execute(db.app)),
    ).toBeNull();
  });
});

describe('work_items.status', () => {
  it('is an ENUM of the five queue states, defaulting to queued', async () => {
    const { rows } = await sql<{ column_type: string; column_default: string | null }>`
      SELECT COLUMN_TYPE AS column_type, COLUMN_DEFAULT AS column_default
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${db.info.database}
        AND TABLE_NAME = 'work_items' AND COLUMN_NAME = 'status'
    `.execute(db.migrator);

    expect(rows[0]?.column_type).toBe("enum('queued','leased','proposed','failed','cancelled')");
    expect(rows[0]?.column_default).toBe('queued');
  });

  it('lands a freshly-inserted row queued, with zero attempts and not flagged', async () => {
    const s = await scene();
    const workItemId = newUuidBuffer();
    await insertWorkItem(s, null, { id: workItemId }).execute(db.app);

    const { rows } = await sql<{ status: string; attempts: number; flagged: number }>`
      SELECT status, attempts, flagged FROM work_items WHERE id = ${workItemId}
    `.execute(db.app);
    expect(rows).toEqual([{ status: 'queued', attempts: 0, flagged: 0 }]);
  });
});

/**
 * `fk_work_items_automation` and `fk_aa_automation` are both `ON DELETE CASCADE`
 * (`0018_automations`'s own header: "Mutable — not append-only — for
 * `bank_statement_imports`' reason"). Nothing in the service layer deletes an
 * automation today, but the schema's own promise is asserted directly rather
 * than left implicit — the same discipline `ar_document_lines`' "takes its
 * lines and their tags with it" test applies in `subledger.test.ts`.
 */
describe('a deleted automation cascades to its work items and its annotations', () => {
  it('removes the queue rows and the notes a deleted automation owned', async () => {
    const s = await scene();
    const automationId = newUuidBuffer();
    await insertAutomation(s, { id: automationId }).execute(db.app);
    const workItemId = newUuidBuffer();
    await insertWorkItem(s, automationId, { id: workItemId }).execute(db.app);
    const runToken = newUuidBuffer();
    await insertAnnotation(s, automationId, runToken).execute(db.app);

    await sql`DELETE FROM automations WHERE id = ${automationId}`.execute(db.app);

    const { rows } = await sql<{ work_item_count: number; annotation_count: number }>`
      SELECT
        (SELECT COUNT(*) FROM work_items WHERE automation_id = ${automationId}) AS work_item_count,
        (SELECT COUNT(*) FROM automation_annotations WHERE automation_id = ${automationId})
          AS annotation_count
    `.execute(db.app);

    expect({
      workItems: Number(rows[0]!.work_item_count),
      annotations: Number(rows[0]!.annotation_count),
    }).toEqual({ workItems: 0, annotations: 0 });
  });
});
