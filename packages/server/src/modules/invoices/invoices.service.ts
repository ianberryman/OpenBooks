import type {
  CreateInvoiceRequest,
  Invoice,
  InvoicePage,
  ListInvoicesQuery,
  UpdateInvoiceRequest,
  VoidDocumentRequest,
} from '@openbooks/shared-types';
import {
  createInvoiceRequestSchema,
  listInvoicesQuerySchema,
  updateInvoiceRequestSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { resolvePageLimit, tryUuidToBuffer } from '../../db';
import { parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { DocumentFilters } from './ar-documents.repository';
import {
  approveArDocument,
  createArDocument,
  discardArDocument,
  getArDocument,
  listArDocuments,
  updateArDocument,
  voidArDocument,
} from './ar-documents.service';
import { INVOICE_KIND as KIND } from './kinds';
import { toInvoice, toInvoiceSummary } from './projection';

/**
 * Customer invoices (OB-062; ROADMAP D-34, D-36, D-38).
 *
 * The lifecycle lives in `ar-documents.service.ts`, which invoices and credit notes
 * share. What is here is the part that is specific to being owed money — the
 * schemas, the filters, and the projection — and the three things every operation
 * in this module does uniformly:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed, so an
 *    unauthorized caller learns nothing about the shape of an API they cannot use.
 *    Enforcement is service-layer only (spec §2.4, §5).
 * 2. **Every payload is parsed with the shared zod schema**, because the HTTP route
 *    is not the only caller (spec §12): an MCP tool and the workflow engine reach
 *    the same functions with no schema in front of them.
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has already
 *    confined every read to the context's org, so a cross-org id returns no row and
 *    reaches the same line a nonexistent id reaches (A7).
 *
 * There are no routes. Transport is OB-067.
 */

export async function createInvoice(
  input: CreateInvoiceRequest,
  ctx: RequestContext = getContext('createInvoice()'),
): Promise<Invoice> {
  await requireWrite(ctx);
  const request = parseInput(createInvoiceRequestSchema, input);

  return toInvoice(await createArDocument(KIND, request, ctx));
}

export async function getInvoice(
  invoiceId: string,
  ctx: RequestContext = getContext('getInvoice()'),
): Promise<Invoice> {
  return toInvoice(await getArDocument(KIND, invoiceId, ctx));
}

/**
 * One page of the org's invoices, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`, even though the schema declares the
 * same bounds: the schema is a restatement for `openapi.json`'s benefit and the
 * function is the authority, because spec §12 puts an MCP tool and the workflow
 * engine on this service with no schema in front of them.
 *
 * `status` filters on a value that is *computed* (D-38), which is the one place the
 * derived-status decision costs something — see `selectDocumentsPage`.
 */
export async function listInvoices(
  query: ListInvoicesQuery,
  ctx: RequestContext = getContext('listInvoices()'),
): Promise<InvoicePage> {
  await requirePermission(ctx, KIND.readPermission);
  const request = parseInput(listInvoicesQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const filters: DocumentFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    // A well-formed id belonging to nobody is an empty page, not an error: the
    // filter names a customer, and "this customer has no invoices" is the honest
    // answer whether or not the customer exists in this org.
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.dueBefore === undefined ? {} : { dueBefore: request.dueBefore }),
    ...(request.status === undefined ? {} : { status: request.status }),
  };

  const page = await listArDocuments(KIND, filters, limit, ctx);
  return { items: page.rows.map(toInvoiceSummary), nextCursor: page.nextCursor };
}

export async function updateInvoice(
  invoiceId: string,
  input: UpdateInvoiceRequest,
  ctx: RequestContext = getContext('updateInvoice()'),
): Promise<Invoice> {
  await requireWrite(ctx);
  const request = parseInput(updateInvoiceRequestSchema, input);

  return toInvoice(await updateArDocument(KIND, invoiceId, request, ctx));
}

export async function discardInvoice(
  invoiceId: string,
  ctx: RequestContext = getContext('discardInvoice()'),
): Promise<void> {
  await discardArDocument(KIND, invoiceId, ctx);
}

/**
 * Approves a draft invoice: allocates its number and posts its journal (C1).
 *
 * Takes no arguments beyond the id, and that is deliberate (`invoices.ts` in
 * shared-types argues it): the entry date is the invoice's own `issueDate`, the
 * actor comes from the session, and the amounts come from the lines the invoice
 * already holds. The first field anyone would add to an empty body is the one that
 * lets a client date the journal differently from the invoice it is posting.
 */
export async function approveInvoice(
  invoiceId: string,
  ctx: RequestContext = getContext('approveInvoice()'),
): Promise<Invoice> {
  return toInvoice(await approveArDocument(KIND, invoiceId, ctx));
}

/** Voids an approved invoice by reversing its journal (D-16, D-38, C7). */
export async function voidInvoice(
  invoiceId: string,
  input: VoidDocumentRequest,
  ctx: RequestContext = getContext('voidInvoice()'),
): Promise<Invoice> {
  await requirePermission(ctx, KIND.voidPermission);
  const request = parseInput(voidDocumentRequestSchema, input);

  return toInvoice(await voidArDocument(KIND, invoiceId, request, ctx));
}

/**
 * The permission check that has to happen before `parseInput`.
 *
 * The shared lifecycle checks it again on the way in — free, because the role's
 * bundle is memoized per context — so this is about *ordering* rather than about
 * enforcement: a caller who may not write invoices must not learn the shape of the
 * request body by being told which field of it is wrong.
 */
async function requireWrite(ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, KIND.writePermission);
}
