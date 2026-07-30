import type {
  CreateRecurringJournalTemplateRequest,
  ListRecurringJournalTemplatesQuery,
  RecurringJournalLine,
  RecurringJournalTemplate,
  UpdateRecurringJournalTemplateRequest,
} from '@openbooks/shared-types';
import {
  createRecurringJournalTemplateRequestSchema,
  listRecurringJournalTemplatesQuerySchema,
  updateRecurringJournalTemplateRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, resolvePageLimit } from '../../db';
import { assertFound, parseInput } from '../../errors';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  selectAccountById,
} from '../accounts/accounts.repository';
import {
  CONTACT_RESOURCE,
  contactIdBytes,
  selectContactById,
} from '../contacts/contacts.repository';
import { requireRecordingUser } from '../payments/input';
import { requirePermission } from '../permissions';

import type {
  RecurringJournalTemplatePatch,
  RecurringJournalTemplateRow,
} from './recurring-journals.repository';
import {
  RECURRING_JOURNAL_TEMPLATE_RESOURCE,
  insertRecurringJournalTemplate,
  orgScope,
  replaceRecurringJournalTemplateLines,
  selectRecurringJournalTemplateById,
  selectRecurringJournalTemplateByIdForUpdate,
  selectRecurringJournalTemplateLines,
  selectRecurringJournalTemplatesPage,
  templateIdBytes,
  toRecurringJournalLine,
  updateRecurringJournalTemplateRow,
} from './recurring-journals.repository';

/**
 * Recurring GL journal templates: create, read, update, deactivate (OB-162; ROADMAP
 * D-90, D-113…D-117).
 *
 * `recurring.service.ts` (`invoicing/recurring`) is this file's sibling and the pattern
 * it mirrors: the engine that materialises a cycle from a due template — `engine.ts` —
 * is a separate file on purpose, because it runs from the worker under a system/
 * automation actor with no request behind it (D-76), while everything here runs from a
 * request or an MCP call with a caller to authorize (spec §2.4). Both reach the same
 * repository.
 *
 * `requirePermission` runs first, before the payload is parsed, so an unauthorized
 * caller learns nothing about the shape of a request it cannot make — the same
 * ordering `invoices.service.ts` and `recurring.service.ts` keep. A miss is always
 * `assertFound`: `tenantDb` has already confined every read to the caller's org, so a
 * cross-org id matches nothing and reaches the same 404 a nonexistent one does (A7).
 *
 * Unlike a recurring invoice template, a GL template has no counterparty of its own —
 * `contactId` lives on the line, not the header (D-90's fixed-line scope) — so there is
 * no `resolveContact` here, only the per-line existence check below.
 */

async function requireWrite(ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'recurring_journals.write');
}

/**
 * Existence only, for every line's `accountId` and, when present, its `contactId` —
 * not a balance check: `createRecurringJournalTemplateRequestSchema`'s own
 * `superRefine` already refuses an unbalanced or under-length line set, so trusting
 * `parseInput` for that rule is deliberate and this function checks only what the
 * schema cannot: whether the referenced rows exist in this org. Checked at authoring
 * time so a template naming a bad account fails with a 404 immediately, rather than
 * failing every future cycle with a foreign-key error the sweep can only log and skip.
 */
async function assertLinesResolvable(
  db: TenantDatabase,
  lines: readonly RecurringJournalLine[],
): Promise<void> {
  for (const line of lines) {
    const accountId = assertFound(accountIdBytes(line.accountId), ACCOUNT_RESOURCE);
    assertFound(await selectAccountById(db, accountId), ACCOUNT_RESOURCE);

    if (line.contactId !== null && line.contactId !== undefined) {
      const contactId = assertFound(contactIdBytes(line.contactId), CONTACT_RESOURCE);
      assertFound(await selectContactById(db, contactId), CONTACT_RESOURCE);
    }
  }
}

export async function createRecurringJournalTemplate(
  input: CreateRecurringJournalTemplateRequest,
  ctx: RequestContext = getContext('createRecurringJournalTemplate()'),
): Promise<RecurringJournalTemplate> {
  await requireWrite(ctx);
  const request = parseInput(createRecurringJournalTemplateRequestSchema, input);
  const author = requireRecordingUser(ctx);

  // One transaction: the template and its lines land together or not at all,
  // `createRecurringInvoiceTemplate`'s shape — a half-created template is worse than
  // none, because the next attempt has nothing to retry against but a duplicate.
  return orgScope(ctx).transaction(async (trx) => {
    await assertLinesResolvable(trx, request.lines);

    const id = await insertRecurringJournalTemplate(trx, {
      name: request.name,
      memo: request.memo ?? null,
      materializationMode: request.materializationMode,
      frequency: request.frequency,
      intervalCount: request.intervalCount,
      nextRunDate: request.startDate,
      endDate: request.endDate ?? null,
      createdByUserId: author,
    });
    await replaceRecurringJournalTemplateLines(trx, id, request.lines);

    return hydrate(trx, id);
  });
}

export async function getRecurringJournalTemplate(
  templateId: string,
  ctx: RequestContext = getContext('getRecurringJournalTemplate()'),
): Promise<RecurringJournalTemplate> {
  await requirePermission(ctx, 'recurring_journals.read');

  const db = orgScope(ctx);
  const id = assertFound(templateIdBytes(templateId), RECURRING_JOURNAL_TEMPLATE_RESOURCE);
  return hydrate(db, id);
}

/**
 * One page of the org's templates, oldest first (D-21).
 *
 * There is no `RecurringJournalTemplatePage` wire schema yet: OB-167 (Wave 2) is where
 * `/v1` routes and their `pageSchema(...)` land, `recurring-journals.ts`'s own header
 * explains why none of this module's schemas carry a `.meta({ id })` before then. This
 * function's return shape is the plain `{ items, nextCursor }` envelope every list
 * already uses (D-21) — declared locally below rather than invented twice when the
 * wire schema does arrive.
 */
export async function listRecurringJournalTemplates(
  query: ListRecurringJournalTemplatesQuery,
  ctx: RequestContext = getContext('listRecurringJournalTemplates()'),
): Promise<RecurringJournalTemplatePage> {
  await requirePermission(ctx, 'recurring_journals.read');
  const request = parseInput(listRecurringJournalTemplatesQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const db = orgScope(ctx);
  const page = await selectRecurringJournalTemplatesPage(db, request, limit);
  const items = await Promise.all(page.rows.map((row) => toRecurringJournalTemplate(db, row)));

  return { items, nextCursor: page.nextCursor };
}

export async function updateRecurringJournalTemplate(
  templateId: string,
  input: UpdateRecurringJournalTemplateRequest,
  ctx: RequestContext = getContext('updateRecurringJournalTemplate()'),
): Promise<RecurringJournalTemplate> {
  await requireWrite(ctx);
  const request = parseInput(updateRecurringJournalTemplateRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(templateIdBytes(templateId), RECURRING_JOURNAL_TEMPLATE_RESOURCE);
    assertFound(
      await selectRecurringJournalTemplateByIdForUpdate(trx, id),
      RECURRING_JOURNAL_TEMPLATE_RESOURCE,
    );

    if (request.lines !== undefined) await assertLinesResolvable(trx, request.lines);

    const patch: RecurringJournalTemplatePatch = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      ...(request.materializationMode === undefined
        ? {}
        : { materializationMode: request.materializationMode }),
      ...(request.frequency === undefined ? {} : { frequency: request.frequency }),
      ...(request.intervalCount === undefined ? {} : { intervalCount: request.intervalCount }),
      ...(request.endDate === undefined ? {} : { endDate: request.endDate }),
      ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
    };
    await updateRecurringJournalTemplateRow(trx, id, patch);

    if (request.lines !== undefined) {
      await replaceRecurringJournalTemplateLines(trx, id, request.lines);
    }

    return hydrate(trx, id);
  });
}

/**
 * Retires a template. Idempotent, `deactivateRecurringInvoiceTemplate`'s shape: an
 * already-inactive template is returned unchanged rather than refused, so a retry
 * never fails on the thing it was trying to achieve.
 */
export async function deactivateRecurringJournalTemplate(
  templateId: string,
  ctx: RequestContext = getContext('deactivateRecurringJournalTemplate()'),
): Promise<RecurringJournalTemplate> {
  await requireWrite(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(templateIdBytes(templateId), RECURRING_JOURNAL_TEMPLATE_RESOURCE);
    assertFound(
      await selectRecurringJournalTemplateByIdForUpdate(trx, id),
      RECURRING_JOURNAL_TEMPLATE_RESOURCE,
    );

    await updateRecurringJournalTemplateRow(trx, id, { isActive: false });

    return hydrate(trx, id);
  });
}

/** One page of recurring journal templates — see `listRecurringJournalTemplates` above. */
export interface RecurringJournalTemplatePage {
  readonly items: readonly RecurringJournalTemplate[];
  readonly nextCursor: string | null;
}

async function hydrate(db: TenantDatabase, id: Buffer): Promise<RecurringJournalTemplate> {
  const row = assertFound(
    await selectRecurringJournalTemplateById(db, id),
    RECURRING_JOURNAL_TEMPLATE_RESOURCE,
  );
  return toRecurringJournalTemplate(db, row);
}

async function toRecurringJournalTemplate(
  db: TenantDatabase,
  row: RecurringJournalTemplateRow,
): Promise<RecurringJournalTemplate> {
  const lines = await selectRecurringJournalTemplateLines(db, row.id);

  return {
    id: bufferToUuid(row.id),
    name: row.name,
    memo: row.memo,
    materializationMode: row.materialization_mode,
    frequency: row.frequency,
    intervalCount: row.interval_count,
    nextRunDate: row.next_run_date,
    lastRunDate: row.last_run_date,
    endDate: row.end_date,
    isActive: row.is_active !== 0,
    lines: lines.map(toRecurringJournalLine),
  };
}
