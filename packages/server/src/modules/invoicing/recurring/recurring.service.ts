import type {
  CreateRecurringInvoiceTemplateRequest,
  ListRecurringInvoiceTemplatesQuery,
  RecurringFrequency,
  RecurringInvoiceLine,
  RecurringInvoiceTemplate,
  RecurringInvoiceTemplatePage,
  RecurringMaterializationMode,
  TaxMode,
  UpdateRecurringInvoiceTemplateRequest,
} from '@openbooks/shared-types';
import {
  createRecurringInvoiceTemplateRequestSchema,
  listRecurringInvoiceTemplatesQuerySchema,
  updateRecurringInvoiceTemplateRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../../context';
import type { RequestContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { bufferToUuid, resolvePageLimit } from '../../../db';
import { assertFound, parseInput } from '../../../errors';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  selectAccountById,
} from '../../accounts/accounts.repository';
import {
  CONTACT_RESOURCE,
  contactIdBytes,
  selectContactById,
} from '../../contacts/contacts.repository';
import { requirePermission } from '../../permissions';
import {
  TAX_RATE_RESOURCE,
  selectTaxRateById,
  taxRateIdBytes,
} from '../../tax/tax-rates.repository';

import type { RecurringTemplatePatch, RecurringTemplateRow } from './recurring.repository';
import {
  RECURRING_TEMPLATE_RESOURCE,
  insertRecurringTemplate,
  orgScope,
  replaceRecurringTemplateLines,
  selectRecurringTemplateById,
  selectRecurringTemplateByIdForUpdate,
  selectRecurringTemplateLines,
  selectRecurringTemplatesPage,
  templateIdBytes,
  toRecurringInvoiceLine,
  updateRecurringTemplateRow,
} from './recurring.repository';

/**
 * Recurring invoice templates: create, read, update, deactivate (OB-128).
 *
 * The engine that materialises a cycle from a due template — `engine.ts` — is a
 * separate file on purpose: it runs from the worker under a system/automation
 * actor with no request behind it (D-76), while everything here runs from a
 * request or an MCP call with a caller to authorize (spec §2.4). Both reach the
 * same repository.
 *
 * `requirePermission` runs first, before the payload is parsed, so an unauthorized
 * caller learns nothing about the shape of a request it cannot make — the same
 * ordering `invoices.service.ts` keeps. A miss is always `assertFound`: `tenantDb`
 * has already confined every read to the caller's org, so a cross-org id matches
 * nothing and reaches the same 404 a nonexistent one does (A7).
 */

async function requireWrite(ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'invoices.write');
}

/**
 * The contact a template raises invoices to, which must exist in this org —
 * `ar-documents.service.ts`'s `resolveContact`, restated here rather than
 * imported across the module boundary for the same reason `kinds.ts`'s
 * commentary gives for not sharing `ArDocumentKind` beyond invoices/credit notes:
 * the two checks are identical today and are not the same promise — a template's
 * contact is read once per cycle by `createInvoice` itself, not posted here.
 */
async function resolveContact(db: TenantDatabase, contactId: string): Promise<Buffer> {
  const id = assertFound(contactIdBytes(contactId), CONTACT_RESOURCE);
  assertFound(await selectContactById(db, id), CONTACT_RESOURCE);
  return id;
}

/**
 * Existence only, for every line's `accountId` and `taxRateId` — not the pricing
 * validation `ar-documents.service.ts` runs (archived rate, purchases-only rate,
 * a non-positive quantity). A template is not priced or taxed; `createInvoice`
 * re-runs that validation, against the accounts and rates as they stand, every
 * time a cycle actually materialises an invoice (the reason a template stores no
 * computed amount at all — see `0008_recurring_dunning`). Checked here anyway so
 * a template naming a bad account fails at authoring time with a 404 rather than
 * failing every future cycle with a foreign-key 500.
 */
async function assertLinesResolvable(
  db: TenantDatabase,
  lines: readonly RecurringInvoiceLine[],
): Promise<void> {
  for (const line of lines) {
    const accountId = assertFound(accountIdBytes(line.accountId), ACCOUNT_RESOURCE);
    assertFound(await selectAccountById(db, accountId), ACCOUNT_RESOURCE);

    if (line.taxRateId !== null && line.taxRateId !== undefined) {
      const taxRateId = assertFound(taxRateIdBytes(line.taxRateId), TAX_RATE_RESOURCE);
      assertFound(await selectTaxRateById(db, taxRateId), TAX_RATE_RESOURCE);
    }
  }
}

export async function createRecurringInvoiceTemplate(
  input: CreateRecurringInvoiceTemplateRequest,
  ctx: RequestContext = getContext('createRecurringInvoiceTemplate()'),
): Promise<RecurringInvoiceTemplate> {
  await requireWrite(ctx);
  const request = parseInput(createRecurringInvoiceTemplateRequestSchema, input);

  // One transaction: the template and its lines land together or not at all,
  // `chart-templates.service.ts`'s shape — a half-created template is worse than
  // none, because the next attempt has nothing to retry against but a duplicate.
  return orgScope(ctx).transaction(async (trx) => {
    const contactId = await resolveContact(trx, request.contactId);
    await assertLinesResolvable(trx, request.lines);

    const id = await insertRecurringTemplate(trx, {
      contactId,
      name: request.name,
      materializationMode: request.materializationMode,
      taxMode: request.taxMode,
      frequency: request.frequency,
      intervalCount: request.intervalCount,
      dueDays: request.dueDays,
      memo: request.memo ?? null,
      nextRunDate: request.startDate,
      endDate: request.endDate ?? null,
    });
    await replaceRecurringTemplateLines(trx, id, request.lines);

    return hydrate(trx, id);
  });
}

export async function getRecurringInvoiceTemplate(
  templateId: string,
  ctx: RequestContext = getContext('getRecurringInvoiceTemplate()'),
): Promise<RecurringInvoiceTemplate> {
  await requirePermission(ctx, 'invoices.read');

  const db = orgScope(ctx);
  const id = assertFound(templateIdBytes(templateId), RECURRING_TEMPLATE_RESOURCE);
  return hydrate(db, id);
}

/**
 * One page of templates, oldest first (D-21). `resolvePageLimit` and not the
 * parsed `limit`, `listInvoices`'s reason: the schema restates the same bounds
 * for `openapi.json`'s benefit, and this function is the authority an MCP tool or
 * the workflow engine reaches with no schema in front of them (spec §12).
 */
export async function listRecurringInvoiceTemplates(
  query: ListRecurringInvoiceTemplatesQuery,
  ctx: RequestContext = getContext('listRecurringInvoiceTemplates()'),
): Promise<RecurringInvoiceTemplatePage> {
  await requirePermission(ctx, 'invoices.read');
  const request = parseInput(listRecurringInvoiceTemplatesQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const db = orgScope(ctx);
  const page = await selectRecurringTemplatesPage(db, request, limit);
  const items = await Promise.all(page.rows.map((row) => toRecurringInvoiceTemplate(db, row)));

  return { items, nextCursor: page.nextCursor };
}

export async function updateRecurringInvoiceTemplate(
  templateId: string,
  input: UpdateRecurringInvoiceTemplateRequest,
  ctx: RequestContext = getContext('updateRecurringInvoiceTemplate()'),
): Promise<RecurringInvoiceTemplate> {
  await requireWrite(ctx);
  const request = parseInput(updateRecurringInvoiceTemplateRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(templateIdBytes(templateId), RECURRING_TEMPLATE_RESOURCE);
    assertFound(await selectRecurringTemplateByIdForUpdate(trx, id), RECURRING_TEMPLATE_RESOURCE);

    const contactId =
      request.contactId === undefined ? undefined : await resolveContact(trx, request.contactId);
    if (request.lines !== undefined) await assertLinesResolvable(trx, request.lines);

    const patch: RecurringTemplatePatch = {
      ...(contactId === undefined ? {} : { contactId }),
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.materializationMode === undefined
        ? {}
        : { materializationMode: request.materializationMode }),
      ...(request.taxMode === undefined ? {} : { taxMode: request.taxMode }),
      ...(request.frequency === undefined ? {} : { frequency: request.frequency }),
      ...(request.intervalCount === undefined ? {} : { intervalCount: request.intervalCount }),
      ...(request.dueDays === undefined ? {} : { dueDays: request.dueDays }),
      ...(request.memo === undefined ? {} : { memo: request.memo }),
      ...(request.endDate === undefined ? {} : { endDate: request.endDate }),
      ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
    };
    await updateRecurringTemplateRow(trx, id, patch);

    if (request.lines !== undefined) {
      await replaceRecurringTemplateLines(trx, id, request.lines);
    }

    return hydrate(trx, id);
  });
}

/**
 * Retires a template. Idempotent, `deactivateAccount`'s shape: an already-inactive
 * template is returned unchanged rather than refused, so a retry never fails on
 * the thing it was trying to achieve.
 */
export async function deactivateRecurringInvoiceTemplate(
  templateId: string,
  ctx: RequestContext = getContext('deactivateRecurringInvoiceTemplate()'),
): Promise<RecurringInvoiceTemplate> {
  await requireWrite(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(templateIdBytes(templateId), RECURRING_TEMPLATE_RESOURCE);
    assertFound(await selectRecurringTemplateByIdForUpdate(trx, id), RECURRING_TEMPLATE_RESOURCE);

    await updateRecurringTemplateRow(trx, id, { isActive: false });

    return hydrate(trx, id);
  });
}

async function hydrate(db: TenantDatabase, id: Buffer): Promise<RecurringInvoiceTemplate> {
  const row = assertFound(await selectRecurringTemplateById(db, id), RECURRING_TEMPLATE_RESOURCE);
  return toRecurringInvoiceTemplate(db, row);
}

async function toRecurringInvoiceTemplate(
  db: TenantDatabase,
  row: RecurringTemplateRow,
): Promise<RecurringInvoiceTemplate> {
  const lines = await selectRecurringTemplateLines(db, row.id);

  return {
    id: bufferToUuid(row.id),
    contactId: bufferToUuid(row.contact_id),
    name: row.name,
    // The three columns below read back as `string` rather than as the narrower
    // literal unions `ar_documents.tax_mode` already carries in `generated.ts` —
    // `0008_recurring_dunning`'s codegen pass did not extend the column-override
    // list this table would need one, which is a codegen-owned edit (needs a live
    // migrated database) rather than one a repository file can make for itself.
    // The `CHECK` constraints these columns carry are the actual guarantee; this
    // is a type-level restatement of it at the one seam it does not already hold.
    materializationMode: row.materialization_mode as RecurringMaterializationMode,
    taxMode: row.tax_mode as TaxMode,
    frequency: row.frequency as RecurringFrequency,
    intervalCount: row.interval_count,
    dueDays: row.due_days,
    memo: row.memo,
    nextRunDate: row.next_run_date,
    lastRunDate: row.last_run_date,
    endDate: row.end_date,
    isActive: row.is_active !== 0,
    lines: lines.map(toRecurringInvoiceLine),
  };
}
