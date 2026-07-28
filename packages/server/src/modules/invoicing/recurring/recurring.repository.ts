import type {
  ListRecurringInvoiceTemplatesQuery,
  RecurringFrequency,
  RecurringInvoiceLine,
  RecurringMaterializationMode,
  TaxMode,
} from '@openbooks/shared-types';
import {
  fromMinorString,
  quantityFromString,
  quantityToString,
  toMinorUnits,
} from '@openbooks/shared-types';
import type { Kysely } from 'kysely';

import type { RequestContext } from '../../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
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
} from '../../../db';
import { quantityFromMicros, quantityToMicros } from '../../invoices/pricing';

/**
 * Data access for `recurring_invoice_templates` and its lines (OB-128).
 *
 * Everything writable goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate (OB-013) — a cross-org id matches
 * nothing, and the service's `assertFound` turns that into the one error a miss
 * may produce (A7). `selectDueTemplates` is the one exception: the daily sweep has
 * no org yet — that is the question it is answering — so it takes a `Kysely<DB>`
 * (the `systemDb()` handle) and reads across every org at once, exactly the shape
 * `idx_recurring_templates_due` was built for. Nothing it returns is written back
 * through this handle; the per-template work that follows re-enters through
 * `orgScope` once the org is known (`engine.ts`).
 *
 * `recurring_invoice_template_lines` mirrors `ar_document_lines`' input columns and
 * nothing it computes (`0008_recurring_dunning`'s header) — a template is not a
 * posted document, and storing computed amounts here would be a second pricing
 * that the first edit of a tax rate would falsify.
 */

export const RECURRING_TEMPLATE_RESOURCE = 'recurring_invoice_template';

const TEMPLATE_COLUMNS = [
  'id',
  'contact_id',
  'name',
  'materialization_mode',
  'tax_mode',
  'frequency',
  'interval_count',
  'due_days',
  'memo',
  'next_run_date',
  'last_run_date',
  'end_date',
  'is_active',
  'created_at',
  'updated_at',
] as const;

/** `TEMPLATE_COLUMNS` plus `org_id`, for `selectDueTemplates`'s cross-org read. */
const DUE_TEMPLATE_COLUMNS = ['org_id', ...TEMPLATE_COLUMNS] as const;

const TEMPLATE_LINE_COLUMNS = [
  'id',
  'line_number',
  'description',
  'quantity_micros',
  'unit_amount_minor',
  'account_id',
  'tax_rate_id',
] as const;

export interface RecurringTemplateRow {
  readonly id: Buffer;
  readonly contact_id: Buffer;
  readonly name: string;
  readonly materialization_mode: string;
  readonly tax_mode: string;
  readonly frequency: string;
  readonly interval_count: number;
  readonly due_days: number;
  readonly memo: string | null;
  readonly next_run_date: string;
  readonly last_run_date: string | null;
  readonly end_date: string | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** `selectDueTemplates` carries `org_id` too — the one read not already org-scoped. */
export interface DueRecurringTemplateRow extends RecurringTemplateRow {
  readonly org_id: Buffer;
}

export interface RecurringTemplateLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly description: string | null;
  readonly quantity_micros: bigint;
  readonly unit_amount_minor: bigint;
  readonly account_id: Buffer;
  readonly tax_rate_id: Buffer | null;
}

export interface NewRecurringTemplateRow {
  readonly contactId: Buffer;
  readonly name: string;
  readonly materializationMode: RecurringMaterializationMode;
  readonly taxMode: TaxMode;
  readonly frequency: RecurringFrequency;
  readonly intervalCount: number;
  readonly dueDays: number;
  readonly memo: string | null;
  readonly nextRunDate: string;
  readonly endDate: string | null;
}

/** `name`, the schedule knobs and `memo`/`endDate` may change; the id and the org may not. */
export interface RecurringTemplatePatch {
  readonly contactId?: Buffer;
  readonly name?: string;
  readonly materializationMode?: RecurringMaterializationMode;
  readonly taxMode?: TaxMode;
  readonly frequency?: RecurringFrequency;
  readonly intervalCount?: number;
  readonly dueDays?: number;
  readonly memo?: string | null;
  readonly endDate?: string | null;
  readonly isActive?: boolean;
}

/** The engine's own patch: only the schedule state a cycle advances. */
export interface RecurringTemplateCyclePatch {
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

export async function insertRecurringTemplate(
  db: TenantDatabase,
  input: NewRecurringTemplateRow,
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('recurring_invoice_templates')
    .values({
      id,
      contact_id: input.contactId,
      name: input.name,
      materialization_mode: input.materializationMode,
      tax_mode: input.taxMode,
      frequency: input.frequency,
      interval_count: input.intervalCount,
      due_days: input.dueDays,
      memo: input.memo,
      next_run_date: input.nextRunDate,
      last_run_date: null,
      end_date: input.endDate,
    })
    .execute();

  return id;
}

export async function selectRecurringTemplateById(
  db: TenantDatabase,
  id: Buffer,
): Promise<RecurringTemplateRow | undefined> {
  return db
    .selectFrom('recurring_invoice_templates')
    .select(TEMPLATE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the engine's guard against two
 * ticks materialising the same cycle concurrently (D-76's once-per-cycle promise
 * made to survive a restart mid-sweep, not only a single-process crash).
 * `recurring_invoice_templates` is in `0999_app_grants`'s mutable allowlist, so
 * the app user may take a locking read on it.
 */
export async function selectRecurringTemplateByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<RecurringTemplateRow | undefined> {
  return db
    .selectFrom('recurring_invoice_templates')
    .select(TEMPLATE_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function selectRecurringTemplateLines(
  db: TenantDatabase,
  templateId: Buffer,
): Promise<readonly RecurringTemplateLineRow[]> {
  return db
    .selectFrom('recurring_invoice_template_lines')
    .select(TEMPLATE_LINE_COLUMNS)
    .where('template_id', '=', templateId)
    .orderBy('line_number', 'asc')
    .execute();
}

/**
 * Every active template due on or before `runDate`, across every org.
 *
 * Takes `systemDb()` rather than a `TenantDatabase`: the sweep's whole job is to
 * find which org each due template belongs to, which is the one question a
 * per-org handle cannot answer. Reads `idx_recurring_templates_due (org_id,
 * is_active, next_run_date)` — the index the migration built for exactly this
 * query, org by org even though this reads across all of them at once.
 *
 * Nothing here writes. The per-template cycle that follows re-enters through
 * `orgScope` once the org is known, and that is where `0999_app_grants`'
 * write allowlist and A7 apply.
 */
export async function selectDueTemplates(
  db: Kysely<DB>,
  runDate: string,
): Promise<readonly DueRecurringTemplateRow[]> {
  return db
    .selectFrom('recurring_invoice_templates')
    .select(DUE_TEMPLATE_COLUMNS)
    .where('is_active', '=', 1)
    .where('next_run_date', '<=', runDate)
    .execute();
}

/**
 * Replaces a template's lines wholesale — `replaceDocumentLines`'s reason exactly:
 * `lines` on the wire is a whole set (`updateRecurringInvoiceTemplateRequestSchema`),
 * and a diff would need stable line identities across an edit that inserts one in
 * the middle.
 */
export async function replaceRecurringTemplateLines(
  db: TenantDatabase,
  templateId: Buffer,
  lines: readonly RecurringInvoiceLine[],
): Promise<void> {
  await db
    .deleteFrom('recurring_invoice_template_lines')
    .where('template_id', '=', templateId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('recurring_invoice_template_lines')
    .values(
      lines.map((line, index) => ({
        template_id: templateId,
        line_number: index + 1,
        description: line.description ?? null,
        quantity_micros: quantityToMicros(quantityFromString(line.quantity)),
        unit_amount_minor: toMinorUnits(fromMinorString(line.unitAmount)),
        account_id: uuidToBuffer(line.accountId),
        tax_rate_id:
          line.taxRateId === null || line.taxRateId === undefined
            ? null
            : uuidToBuffer(line.taxRateId),
      })),
    )
    .execute();
}

export async function updateRecurringTemplateRow(
  db: TenantDatabase,
  id: Buffer,
  patch: RecurringTemplatePatch,
): Promise<void> {
  await db
    .updateTable('recurring_invoice_templates')
    .set({
      ...(patch.contactId === undefined ? {} : { contact_id: patch.contactId }),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.materializationMode === undefined
        ? {}
        : { materialization_mode: patch.materializationMode }),
      ...(patch.taxMode === undefined ? {} : { tax_mode: patch.taxMode }),
      ...(patch.frequency === undefined ? {} : { frequency: patch.frequency }),
      ...(patch.intervalCount === undefined ? {} : { interval_count: patch.intervalCount }),
      ...(patch.dueDays === undefined ? {} : { due_days: patch.dueDays }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
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
 * the invoice it raised was posted in.
 */
export async function advanceRecurringTemplateCycle(
  db: TenantDatabase,
  id: Buffer,
  patch: RecurringTemplateCyclePatch,
): Promise<void> {
  await db
    .updateTable('recurring_invoice_templates')
    .set({
      last_run_date: patch.lastRunDate,
      next_run_date: patch.nextRunDate,
      is_active: patch.isActive ? 1 : 0,
    })
    .where('id', '=', id)
    .execute();
}

export function toRecurringInvoiceLine(row: RecurringTemplateLineRow): RecurringInvoiceLine {
  return {
    description: row.description,
    quantity: quantityToString(quantityFromMicros(row.quantity_micros)),
    unitAmount: row.unit_amount_minor.toString(),
    accountId: bufferToUuid(row.account_id),
    taxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
  };
}

/** `(created_at, id)` — `contacts.repository.ts`'s reasoning applied to a template. */
const TEMPLATE_KEYSET: KeysetOrdering<RecurringTemplateRow> = [
  instantKey('recurring_invoice_templates.created_at', (row) => row.created_at),
  uuidKey('recurring_invoice_templates.id', (row) => row.id),
];

export async function selectRecurringTemplatesPage(
  db: TenantDatabase,
  filters: ListRecurringInvoiceTemplatesQuery,
  limit: number,
): Promise<KeysetPage<RecurringTemplateRow>> {
  let query = db.selectFrom('recurring_invoice_templates').select(TEMPLATE_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  const rows = await applyKeyset(query, TEMPLATE_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, TEMPLATE_KEYSET, limit);
}
