import type {
  ListRecurringJournalTemplatesQuery,
  RecurringJournalFrequency,
  RecurringJournalLine,
  RecurringJournalMaterializationMode,
} from '@openbooks/shared-types';
import { fromMinorString, toMinorUnits } from '@openbooks/shared-types';
import type { Kysely } from 'kysely';

import type { RequestContext } from '../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
  uuidToBuffer,
} from '../../db';

/**
 * Data access for `recurring_journal_templates` and its lines (OB-162; ROADMAP D-90,
 * D-113…D-117, `0014_fixed_assets`).
 *
 * `recurring.repository.ts` (`invoicing/recurring`) is this file's sibling and the
 * pattern it mirrors almost verbatim: everything writable goes through `tenantDb`, so
 * `org_id = ctx.orgId` is on every statement before this file adds a predicate
 * (OB-013), and `selectDueRecurringJournalTemplates` is the one exception — the daily
 * sweep has no org yet, which is the question it is answering, so it takes a
 * `Kysely<DB>` (the `systemDb()` handle) and reads `idx_recurring_journal_templates_due`
 * across every org at once. Nothing it returns is written back through that handle;
 * the per-template work that follows re-enters through `orgScope` once the org is
 * known (`engine.ts`).
 *
 * `recurring_journal_template_lines` differs from `recurring_invoice_template_lines`
 * in the one way that matters: a GL line is already a posting instruction —
 * `{ account_id, side, amount_minor }` is exactly `JournalLineInput` — so it is stored
 * and posted verbatim, never re-priced (D-90). There is no pricing to recompute here.
 */

export const RECURRING_JOURNAL_TEMPLATE_RESOURCE = 'recurring_journal_template';

const TEMPLATE_COLUMNS = [
  'id',
  'name',
  'memo',
  'materialization_mode',
  'frequency',
  'interval_count',
  'next_run_date',
  'last_run_date',
  'end_date',
  'is_active',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

/** `TEMPLATE_COLUMNS` plus `org_id`, for `selectDueRecurringJournalTemplates`'s cross-org read. */
const DUE_TEMPLATE_COLUMNS = ['org_id', ...TEMPLATE_COLUMNS] as const;

const TEMPLATE_LINE_COLUMNS = [
  'id',
  'line_number',
  'account_id',
  'side',
  'amount_minor',
  'contact_id',
  'description',
] as const;

/**
 * `materialization_mode` and `frequency` read back as the narrow literal unions
 * `generated.ts` already carries for these two columns (`0014_fixed_assets`'s codegen
 * pass), unlike `recurring_invoice_templates.tax_mode` — so, unlike that sibling row,
 * neither needs an `as` cast at the wire boundary; the `CHECK`/`ENUM` constraint and
 * the type agree already.
 */
export interface RecurringJournalTemplateRow {
  readonly id: Buffer;
  readonly name: string;
  readonly memo: string | null;
  readonly materialization_mode: RecurringJournalMaterializationMode;
  readonly frequency: RecurringJournalFrequency;
  readonly interval_count: number;
  readonly next_run_date: string;
  readonly last_run_date: string | null;
  readonly end_date: string | null;
  readonly is_active: number;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Carries `org_id` too — `selectDueRecurringJournalTemplates`'s one read not already scoped. */
export interface DueRecurringJournalTemplateRow extends RecurringJournalTemplateRow {
  readonly org_id: Buffer;
}

export interface RecurringJournalTemplateLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly account_id: Buffer;
  readonly side: RecurringJournalLine['side'];
  readonly amount_minor: bigint;
  readonly contact_id: Buffer | null;
  readonly description: string | null;
}

export interface NewRecurringJournalTemplateRow {
  readonly name: string;
  readonly memo: string | null;
  readonly materializationMode: RecurringJournalMaterializationMode;
  readonly frequency: RecurringJournalFrequency;
  readonly intervalCount: number;
  readonly nextRunDate: string;
  readonly endDate: string | null;
  /** `NOT NULL` on the table (`0014_fixed_assets`) — a template names who authored it. */
  readonly createdByUserId: Buffer;
}

/** `name` and the schedule knobs may change; the id, the org and the author never do. */
export interface RecurringJournalTemplatePatch {
  readonly name?: string;
  readonly memo?: string | null;
  readonly materializationMode?: RecurringJournalMaterializationMode;
  readonly frequency?: RecurringJournalFrequency;
  readonly intervalCount?: number;
  readonly endDate?: string | null;
  readonly isActive?: boolean;
}

/** The engine's own patch: only the schedule state a cycle advances. */
export interface RecurringJournalTemplateCyclePatch {
  readonly lastRunDate: string;
  readonly nextRunDate: string;
  readonly isActive: boolean;
}

/**
 * The org-scoped handle for the current operation — the shape every other
 * repository in this codebase builds (`accounts.repository.ts`, `contacts.repository.ts`).
 */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied template id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (A7).
 */
export function templateIdBytes(templateId: string): Buffer | undefined {
  return tryUuidToBuffer(templateId);
}

export async function insertRecurringJournalTemplate(
  db: TenantDatabase,
  input: NewRecurringJournalTemplateRow,
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('recurring_journal_templates')
    .values({
      id,
      name: input.name,
      memo: input.memo,
      materialization_mode: input.materializationMode,
      frequency: input.frequency,
      interval_count: input.intervalCount,
      next_run_date: input.nextRunDate,
      last_run_date: null,
      end_date: input.endDate,
      created_by_user_id: input.createdByUserId,
    })
    .execute();

  return id;
}

export async function selectRecurringJournalTemplateById(
  db: TenantDatabase,
  id: Buffer,
): Promise<RecurringJournalTemplateRow | undefined> {
  return db
    .selectFrom('recurring_journal_templates')
    .select(TEMPLATE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the engine's guard against two ticks
 * materialising the same cycle concurrently (D-76's once-per-cycle promise made to
 * survive a restart mid-sweep, not only a single-process crash). `recurring_journal_templates`
 * is in `0999_app_grants`'s mutable allowlist, so the app user may take a locking read on it.
 */
export async function selectRecurringJournalTemplateByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<RecurringJournalTemplateRow | undefined> {
  return db
    .selectFrom('recurring_journal_templates')
    .select(TEMPLATE_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function selectRecurringJournalTemplateLines(
  db: TenantDatabase,
  templateId: Buffer,
): Promise<readonly RecurringJournalTemplateLineRow[]> {
  return db
    .selectFrom('recurring_journal_template_lines')
    .select(TEMPLATE_LINE_COLUMNS)
    .where('template_id', '=', templateId)
    .orderBy('line_number', 'asc')
    .execute();
}

/**
 * Every active template due on or before `runDate`, across every org.
 *
 * Takes `systemDb()` rather than a `TenantDatabase`, `selectDueTemplates`'s own
 * reasoning applied here: the sweep's whole job is to find which org each due
 * template belongs to, which is the one question a per-org handle cannot answer.
 * Reads `idx_recurring_journal_templates_due (org_id, is_active, next_run_date)` —
 * the index `0014_fixed_assets` built for exactly this query, org by org even though
 * this reads across all of them at once.
 *
 * Nothing here writes. The per-template cycle that follows re-enters through
 * `orgScope` once the org is known, and that is where `0999_app_grants`'s write
 * allowlist and A7 apply.
 */
export async function selectDueRecurringJournalTemplates(
  db: Kysely<DB>,
  runDate: string,
): Promise<readonly DueRecurringJournalTemplateRow[]> {
  return db
    .selectFrom('recurring_journal_templates')
    .select(DUE_TEMPLATE_COLUMNS)
    .where('is_active', '=', 1)
    .where('next_run_date', '<=', runDate)
    .execute();
}

/**
 * Replaces a template's lines wholesale — `replaceRecurringTemplateLines`'s reason
 * exactly: `lines` on the wire is a whole set (`updateRecurringJournalTemplateRequestSchema`),
 * and a diff would need stable line identities across an edit that inserts one in
 * the middle.
 */
export async function replaceRecurringJournalTemplateLines(
  db: TenantDatabase,
  templateId: Buffer,
  lines: readonly RecurringJournalLine[],
): Promise<void> {
  await db
    .deleteFrom('recurring_journal_template_lines')
    .where('template_id', '=', templateId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('recurring_journal_template_lines')
    .values(
      lines.map((line, index) => ({
        template_id: templateId,
        line_number: index + 1,
        account_id: uuidToBuffer(line.accountId),
        side: line.side,
        amount_minor: toMinorUnits(fromMinorString(line.amount)),
        contact_id:
          line.contactId === null || line.contactId === undefined
            ? null
            : uuidToBuffer(line.contactId),
        description: line.description ?? null,
      })),
    )
    .execute();
}

export async function updateRecurringJournalTemplateRow(
  db: TenantDatabase,
  id: Buffer,
  patch: RecurringJournalTemplatePatch,
): Promise<void> {
  await db
    .updateTable('recurring_journal_templates')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      ...(patch.materializationMode === undefined
        ? {}
        : { materialization_mode: patch.materializationMode }),
      ...(patch.frequency === undefined ? {} : { frequency: patch.frequency }),
      ...(patch.intervalCount === undefined ? {} : { interval_count: patch.intervalCount }),
      ...(patch.endDate === undefined ? {} : { end_date: patch.endDate }),
      ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
    })
    .where('id', '=', id)
    .execute();

  /**
   * The affected-row count is deliberately not consulted, `updateAccountRow`'s
   * reason: mysql2 does not set `CLIENT_FOUND_ROWS`, so a no-op update and a miss
   * report the same zero. Existence is established by the caller's own read.
   */
}

/**
 * The engine's write: advance the schedule after a cycle, in the same transaction
 * the journal (or draft) it raised was created in.
 */
export async function advanceRecurringJournalTemplateCycle(
  db: TenantDatabase,
  id: Buffer,
  patch: RecurringJournalTemplateCyclePatch,
): Promise<void> {
  await db
    .updateTable('recurring_journal_templates')
    .set({
      last_run_date: patch.lastRunDate,
      next_run_date: patch.nextRunDate,
      is_active: patch.isActive ? 1 : 0,
    })
    .where('id', '=', id)
    .execute();
}

export function toRecurringJournalLine(row: RecurringJournalTemplateLineRow): RecurringJournalLine {
  return {
    accountId: bufferToUuid(row.account_id),
    side: row.side,
    amount: row.amount_minor.toString(),
    contactId: row.contact_id === null ? null : bufferToUuid(row.contact_id),
    description: row.description,
  };
}

/** `(created_at, id)` — `contacts.repository.ts`'s reasoning applied to a template. */
const TEMPLATE_KEYSET: KeysetOrdering<RecurringJournalTemplateRow> = [
  instantKey('recurring_journal_templates.created_at', (row) => row.created_at),
  uuidKey('recurring_journal_templates.id', (row) => row.id),
];

export async function selectRecurringJournalTemplatesPage(
  db: TenantDatabase,
  filters: ListRecurringJournalTemplatesQuery,
  limit: number,
): Promise<KeysetPage<RecurringJournalTemplateRow>> {
  let query = db.selectFrom('recurring_journal_templates').select(TEMPLATE_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  const rows = await applyKeyset(query, TEMPLATE_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, TEMPLATE_KEYSET, limit);
}
