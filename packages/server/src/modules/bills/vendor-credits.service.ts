import type {
  CreateVendorCreditRequest,
  ListVendorCreditsQuery,
  UpdateVendorCreditRequest,
  VendorCredit,
  VendorCreditPage,
  VendorCreditSummary,
  VoidDocumentRequest,
} from '@openbooks/shared-types';
import {
  createVendorCreditRequestSchema,
  listVendorCreditsQuerySchema,
  updateVendorCreditRequestSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { resolvePageLimit, tryUuidToBuffer } from '../../db';
import { InternalError, assertFound, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { ApDocumentFilters } from './ap-documents.repository';
import {
  AP_DOCUMENT_RESOURCE,
  deleteDraftDocument,
  documentIdBytes,
  insertDocument,
  newDocumentId,
  orgScope,
  replaceDocumentLines,
  selectDocumentById,
  selectDocumentByIdForUpdate,
  selectDocumentsPage,
  updateDocumentRow,
} from './ap-documents.repository';
import type { ApDocumentSummaryView, ApDocumentView } from './ap-documents.service';
import {
  approveDocument,
  assertDraft,
  assertHasValue,
  lifecycleFor,
  readDocumentView,
  repriceLines,
  requireAuthor,
  requireVendor,
  resolveLines,
  toSummaryPage,
  voidDocument,
} from './ap-documents.service';

/**
 * Vendor credits — what a vendor owes back (OB-063; ROADMAP D-38, D-39).
 *
 * ## A vendor credit is a document, not a negative bill
 *
 * D-39 is the decision this file exists because of. A vendor credit has its own
 * gapless sequence, posts its own journal, and reduces what is owed by allocating
 * against bills through the same mechanism a payment uses — so "what is
 * outstanding" has one definition regardless of what reduced it.
 *
 * Modelling it as a bill with negative lines would be less code and worse books:
 * aging would need to special-case the sign, a vendor credit could accidentally be
 * paid, and the document would be a bill claiming the vendor is owed minus two
 * hundred. Every amount in this subsystem is therefore non-negative and the *type*
 * carries the direction — which is why `resolveLines` refuses a negative quantity
 * or unit amount rather than storing one.
 *
 * ## No due date, and one permission short of a bill
 *
 * There is no `dueDate`: nothing about a credit falls due, it is allocated rather
 * than chased, and `chk_ap_documents_bill_due` requires one only of a bill.
 *
 * Voiding takes `vendor_credits.write` where voiding a bill takes `bills.void`,
 * and the asymmetry is the catalog's rather than this module's: the fixed
 * permission list (spec §5) holds `bills.void` and no `vendor_credits.void`, and
 * the AR side has the same shape (`invoices.void`, no `credit_notes.void`).
 * Inventing a code here would mean editing the seed, the catalog union and the
 * drift test, and would land the new code in Owner and Bookkeeper automatically
 * while missing the AP-only clerk who needs it — the argument `drafts/index.ts`
 * makes at length for reusing `journals.post`.
 */

const RESOURCE = AP_DOCUMENT_RESOURCE.vendor_credit;

export async function createVendorCredit(
  input: CreateVendorCreditRequest,
  ctx: RequestContext = getContext('createVendorCredit()'),
): Promise<VendorCredit> {
  await requirePermission(ctx, 'vendor_credits.write');
  const request = parseInput(createVendorCreditRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const contactId = assertFound(tryUuidToBuffer(request.contactId), 'contact');
    await requireVendor(trx, contactId);

    const id = newDocumentId();
    await insertDocument(trx, id, {
      documentType: 'vendor_credit',
      createdByUserId: author,
      contactId,
      issueDate: request.issueDate,
      dueDate: null,
      // Nothing about a vendor credit falls due or earns an early-pay discount
      // (OB-136), matching `dueDate` immediately above.
      paymentTermId: null,
      taxMode: request.taxMode,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
    });

    if (request.lines !== undefined) {
      await replaceDocumentLines(trx, id, await resolveLines(trx, request.lines, request.taxMode));
    }

    return readVendorCredit(trx, id);
  });
}

export async function getVendorCredit(
  vendorCreditId: string,
  ctx: RequestContext = getContext('getVendorCredit()'),
): Promise<VendorCredit> {
  await requirePermission(ctx, 'vendor_credits.read');

  const db = orgScope(ctx);
  return readVendorCredit(db, assertFound(documentIdBytes(vendorCreditId), RESOURCE));
}

/**
 * One page of the org's vendor credits, oldest first (D-21).
 *
 * `unappliedOnly` is a filter on a *computed* quantity — outstanding is total
 * minus allocations, stored nowhere (D-34) — so it is applied after the page is
 * assembled, exactly as `part_paid` and `paid` are. `toSummaryPage` states why
 * paging stays correct.
 */
export async function listVendorCredits(
  query: ListVendorCreditsQuery,
  ctx: RequestContext = getContext('listVendorCredits()'),
): Promise<VendorCreditPage> {
  await requirePermission(ctx, 'vendor_credits.read');
  const request = parseInput(listVendorCreditsQuerySchema, query);
  const limit = resolvePageLimit(request.limit);
  const lifecycle = lifecycleFor(request.status);

  const filters: ApDocumentFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    // `unappliedOnly` narrows to approved documents before the computed filter
    // below, which is the part a `WHERE` clause can carry: a draft and a void have
    // nothing available to apply whatever their lines say (see `settlementOf`).
    ...(lifecycle === undefined
      ? request.unappliedOnly === true
        ? { lifecycle: 'approved' as const }
        : {}
      : { lifecycle }),
  };

  const db = orgScope(ctx);
  const page = await selectDocumentsPage(db, 'vendor_credit', filters, limit);
  const summaries = await toSummaryPage(db, 'vendor_credit', page.rows, request.status);
  const items =
    request.unappliedOnly === true
      ? summaries.filter((row) => BigInt(row.settlement.outstanding) > 0n)
      : summaries;

  return { items: items.map(toVendorCreditSummary), nextCursor: page.nextCursor };
}

export async function updateVendorCredit(
  vendorCreditId: string,
  input: UpdateVendorCreditRequest,
  ctx: RequestContext = getContext('updateVendorCredit()'),
): Promise<VendorCredit> {
  await requirePermission(ctx, 'vendor_credits.write');
  const request = parseInput(updateVendorCreditRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(vendorCreditId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'vendor_credit'), RESOURCE);
    assertDraft(row);

    const contactId =
      request.contactId === undefined
        ? undefined
        : assertFound(tryUuidToBuffer(request.contactId), 'contact');
    if (contactId !== undefined) await requireVendor(trx, contactId);

    await updateDocumentRow(
      trx,
      id,
      {
        ...(contactId === undefined ? {} : { contactId }),
        ...(request.issueDate === undefined ? {} : { issueDate: request.issueDate }),
        ...(request.taxMode === undefined ? {} : { taxMode: request.taxMode }),
        ...(request.reference === undefined ? {} : { reference: request.reference }),
        ...(request.memo === undefined ? {} : { memo: request.memo }),
      },
      new Date(),
    );

    const taxMode = request.taxMode ?? row.tax_mode;
    if (request.lines !== undefined) {
      await replaceDocumentLines(trx, id, await resolveLines(trx, request.lines, taxMode));
    } else if (taxMode !== row.tax_mode) {
      await repriceLines(trx, id, taxMode);
    }

    return readVendorCredit(trx, id);
  });
}

export async function discardVendorCredit(
  vendorCreditId: string,
  ctx: RequestContext = getContext('discardVendorCredit()'),
): Promise<void> {
  await requirePermission(ctx, 'vendor_credits.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(vendorCreditId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'vendor_credit'), RESOURCE);
    assertDraft(row);

    if ((await deleteDraftDocument(trx, id, 'vendor_credit')) !== 1) {
      throw new InternalError(
        'Discarding a vendor credit deleted no rows while holding its row lock. The document ' +
          'was read FOR UPDATE in this transaction, so it cannot have been removed by another one.',
      );
    }
  });
}

/**
 * Approves a vendor credit: numbers it and posts its journal (D-38, D-39).
 *
 * The journal is the exact mirror of a bill's — the line accounts are credited and
 * accounts payable is debited — which is what makes a credit reduce the payables
 * control account without anybody netting two documents together. `journalSides`
 * in `ap-documents.service.ts` is the single place that direction is decided.
 *
 * There is no duplicate-reference check on this side, for the reason stated at
 * `assertNoDuplicateReference`: the double-payment risk that justifies refusing a
 * repeated vendor invoice number does not exist on a credit, and the false
 * refusals would.
 */
export async function approveVendorCredit(
  vendorCreditId: string,
  ctx: RequestContext = getContext('approveVendorCredit()'),
): Promise<VendorCredit> {
  await requirePermission(ctx, 'vendor_credits.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(vendorCreditId), RESOURCE);

    await approveDocument(trx, id, 'vendor_credit', ctx, async (row, lines) => {
      assertHasValue(lines, 'vendor_credit');
      await requireVendor(trx, row.contact_id);
    });

    return readVendorCredit(trx, id);
  });
}

export async function voidVendorCredit(
  vendorCreditId: string,
  input: VoidDocumentRequest,
  ctx: RequestContext = getContext('voidVendorCredit()'),
): Promise<VendorCredit> {
  await requirePermission(ctx, 'vendor_credits.write');
  const request = parseInput(voidDocumentRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(vendorCreditId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'vendor_credit'), RESOURCE);

    await voidDocument(trx, row, request, ctx);
    return readVendorCredit(trx, id);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readVendorCredit(db: TenantDatabase, id: Buffer): Promise<VendorCredit> {
  const row = assertFound(await selectDocumentById(db, id, 'vendor_credit'), RESOURCE);
  return toVendorCredit(await readDocumentView(db, row));
}

/** The view narrowed to `vendorCreditSchema`, which has no `dueDate`. */
function toVendorCredit(view: ApDocumentView): VendorCredit {
  return {
    id: view.id,
    documentNumber: view.documentNumber,
    reference: view.reference,
    contactId: view.contactId,
    issueDate: view.issueDate,
    taxMode: view.taxMode,
    status: view.status,
    memo: view.memo,
    lines: [...view.lines],
    totals: view.totals,
    taxSummary: [...view.taxSummary],
    settlement: view.settlement,
    allocations: [...view.allocations],
    journalId: view.journalId,
    voidJournalId: view.voidJournalId,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function toVendorCreditSummary(view: ApDocumentSummaryView): VendorCreditSummary {
  return {
    id: view.id,
    documentNumber: view.documentNumber,
    reference: view.reference,
    contactId: view.contactId,
    issueDate: view.issueDate,
    status: view.status,
    totals: view.totals,
    settlement: view.settlement,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}
