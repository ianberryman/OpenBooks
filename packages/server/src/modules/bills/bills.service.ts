import type {
  Bill,
  BillPage,
  BillSummary,
  CreateBillRequest,
  ListBillsQuery,
  UpdateBillRequest,
  VoidDocumentRequest,
} from '@openbooks/shared-types';
import {
  createBillRequestSchema,
  listBillsQuerySchema,
  updateBillRequestSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';
import { fromMinorString } from '@openbooks/shared-types/money';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { resolvePageLimit, tryUuidToBuffer, uuidToBuffer } from '../../db';
import { InternalError, ValidationError, assertFound, parseInput } from '../../errors';
import { emitEvent } from '../events';
import { computePaymentTerm, resolveDocumentTerm } from '../payment-terms';
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
 * Bills — what this business owes its vendors (OB-063; ROADMAP D-34 to D-39).
 *
 * Read `index.ts` for the surface and `ap-documents.service.ts` for the shared
 * machinery, the lock order at approval, and the duplicate-vendor-reference rule.
 * Three things are uniform across every operation here and are stated once,
 * following `drafts.service.ts`:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed, so an
 *    unauthorized caller learns nothing about the shape of an API they cannot use.
 *    Enforcement is service-layer only (spec §2.4, §5).
 * 2. **Every payload is parsed with the shared zod schema**, because the HTTP
 *    route is not the only caller (spec §12) — an MCP tool and the workflow engine
 *    reach these functions with no schema in front of them.
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined every read to the context's org, so a cross-org id returns no
 *    row and reaches the same line a nonexistent id reaches (A7).
 */

const RESOURCE = AP_DOCUMENT_RESOURCE.bill;

/**
 * Creates a draft bill, with or without lines.
 *
 * `dueDate` defaults to the issue date — due on receipt — when the caller omits
 * one *and* the vendor carries no payment term (OB-136): when it does, the
 * resolved term computes it instead (`computePaymentTerm`), the AP mirror of
 * `createArDocument`'s own default. That fallback exists because the contract
 * requires it either way: `billSchema.dueDate` is non-nullable while
 * `createBillRequestSchema.dueDate` is optional, so a draft with no due date
 * could be stored and then not serialized. Aging measures from this field
 * (D-40) — leaving it null until approval would make a draft's place in an
 * aging preview unanswerable.
 *
 * The term itself resolves the same way `createArDocument` resolves one for an
 * invoice (OB-139, D-108): `paymentTermId`, if the caller sent one, overrides the
 * vendor's default, and `resolveDocumentTerm` is the single place that decides
 * between them.
 *
 * The transaction is unconditional even when there are no lines: `TenantDatabase`
 * joins an ambient one (`transaction-scope.ts`), so the cost when there is nothing
 * to protect is one `BEGIN`, and with lines it is what keeps a bill from existing
 * for a moment without them.
 */
export async function createBill(
  input: CreateBillRequest,
  ctx: RequestContext = getContext('createBill()'),
): Promise<Bill> {
  await requirePermission(ctx, 'bills.write');
  const request = parseInput(createBillRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const contactId = assertFound(tryUuidToBuffer(request.contactId), 'contact');
    await requireVendor(trx, contactId);

    const term = await resolveDocumentTerm(ctx, {
      contactId: request.contactId,
      documentTermId: request.paymentTermId,
    });

    const id = newDocumentId();
    await insertDocument(trx, id, {
      documentType: 'bill',
      createdByUserId: author,
      contactId,
      issueDate: request.issueDate,
      dueDate:
        request.dueDate ??
        (term === null
          ? request.issueDate
          : computePaymentTerm(term, request.issueDate, '0').dueDate),
      // Recorded whenever a term was resolved, independent of whether `dueDate`
      // was given explicitly — matching `createArDocument`'s own reasoning.
      paymentTermId: term === null ? null : uuidToBuffer(term.id),
      taxMode: request.taxMode,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
    });

    if (request.lines !== undefined) {
      await replaceDocumentLines(trx, id, await resolveLines(trx, request.lines, request.taxMode));
    }

    return readBill(trx, id);
  });
}

export async function getBill(
  billId: string,
  ctx: RequestContext = getContext('getBill()'),
): Promise<Bill> {
  await requirePermission(ctx, 'bills.read');

  const db = orgScope(ctx);
  return readBill(db, assertFound(documentIdBytes(billId), RESOURCE));
}

/**
 * One page of the org's bills, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`, even though the schema declares
 * the same bounds: the schema is a restatement for `openapi.json`'s benefit and
 * this function is the authority, because spec §12 puts an MCP tool and the
 * workflow engine on this service with no schema in front of them.
 *
 * `reference` is a filter here and on no other document's list, and D-36 is why:
 * "have we already entered this bill" is a question someone asks several times a
 * week with the vendor's number in their hand. Nobody looks an invoice up by the
 * customer's purchase-order number.
 */
export async function listBills(
  query: ListBillsQuery,
  ctx: RequestContext = getContext('listBills()'),
): Promise<BillPage> {
  await requirePermission(ctx, 'bills.read');
  const request = parseInput(listBillsQuerySchema, query);
  const limit = resolvePageLimit(request.limit);
  const lifecycle = lifecycleFor(request.status);

  const filters: ApDocumentFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    // A well-formed id belonging to nobody is an empty page, not an error: the
    // filter names a vendor, and "this vendor has no bills" is the honest answer
    // whether or not the vendor exists in this org.
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.dueBefore === undefined ? {} : { dueBefore: request.dueBefore }),
    ...(request.reference === undefined ? {} : { reference: request.reference }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };

  const db = orgScope(ctx);
  const page = await selectDocumentsPage(db, 'bill', filters, limit);
  const summaries = await toSummaryPage(db, 'bill', page.rows, request.status);

  return { items: summaries.map(toBillSummary), nextCursor: page.nextCursor };
}

/**
 * Updates a draft's header, and — when `lines` is present — replaces the whole
 * line set.
 *
 * The row is taken `FOR UPDATE` before anything is written, for the two reasons
 * `updateDraft` gives, of which the second is the one that matters: an edit racing
 * `approveBill` cannot land between the approval's read of the lines and its
 * posting, so a line added after the posting priced them cannot be silently
 * dropped from a journal that is then immutable.
 *
 * ## Changing `taxMode` re-prices the lines that are already there
 *
 * `unitAmount` means "including tax" or "excluding tax" depending on that single
 * flag (`taxModeSchema`), so a mode change with no `lines` in the same request
 * would leave every stored line priced under the old reading — a document whose
 * own net, tax and gross no longer add up the way the page does. The re-pricing
 * runs through `resolveLines`, so it is the same arithmetic and the same rounding
 * as an ordinary edit rather than a second implementation.
 */
export async function updateBill(
  billId: string,
  input: UpdateBillRequest,
  ctx: RequestContext = getContext('updateBill()'),
): Promise<Bill> {
  await requirePermission(ctx, 'bills.write');
  const request = parseInput(updateBillRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(billId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'bill'), RESOURCE);
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
        ...(request.dueDate === undefined ? {} : { dueDate: request.dueDate }),
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

    return readBill(trx, id);
  });
}

/**
 * Discards a draft bill and everything on it.
 *
 * This is the operation D-16 is about: a document that has not reached the ledger
 * is deleted outright, because deleting it removes nothing an auditor could ask
 * about — no report changes and no past date stops reproducing, since a draft was
 * never in one. It consumed no number either (D-36), so the series stays gapless.
 *
 * The row is locked first rather than relying on the `DELETE`'s own lock, which is
 * where this differs from `discardDraft`: a journal draft has no approved state,
 * so "deleted nothing" could only mean "was not there". Here it could also mean
 * "is approved", and reporting a 404 for a bill the caller can plainly read would
 * be a lie. The lock lets the two be told apart and answered differently.
 */
export async function discardBill(
  billId: string,
  ctx: RequestContext = getContext('discardBill()'),
): Promise<void> {
  await requirePermission(ctx, 'bills.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(billId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'bill'), RESOURCE);
    assertDraft(row);

    if ((await deleteDraftDocument(trx, id, 'bill')) !== 1) {
      throw new InternalError(
        'Discarding a bill deleted no rows while holding its row lock. The bill was read FOR ' +
          'UPDATE in this transaction, so it cannot have been removed by another one.',
      );
    }
  });
}

/**
 * Approves a bill: numbers it and posts its journal, in one transaction (D-38).
 *
 * This is **the irreversible step**. Before it a bill is editable and discardable
 * exactly as a journal draft is (D-16, D-19); after it the ledger has been told,
 * and the only corrections are a vendor credit or a void.
 *
 * `approveDocument` holds the lock order, the exactly-once argument, and the
 * duplicate-vendor-reference rule. What is specific to a bill is here: it must
 * have a due date, it must have value, and its contact must still be a vendor.
 */
export async function approveBill(
  billId: string,
  ctx: RequestContext = getContext('approveBill()'),
): Promise<Bill> {
  await requirePermission(ctx, 'bills.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(billId), RESOURCE);

    const outcome = await approveDocument(trx, id, 'bill', ctx, async (row, lines) => {
      if (row.due_date === null) throw missingDueDateAtApproval();
      assertHasValue(lines, 'bill');
      await requireVendor(trx, row.contact_id);
    });

    const bill = await readBill(trx, id);

    // The outbox append (OB-100, F7): same transaction as `approveDocument`'s
    // write, so an event exists if and only if the approval committed. `total`
    // comes off the read-back view rather than `outcome.journal`, which carries
    // per-line amounts and no aggregate.
    await emitEvent(
      {
        name: 'bill.approved.v1',
        orgId: ctx.orgId,
        actor: {
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        },
        payload: {
          billId,
          contactId: bill.contactId,
          journalId: outcome.journal.journalId,
          total: fromMinorString(bill.totals.gross),
          date: outcome.journal.date,
        },
      },
      ctx,
    );

    return bill;
  });
}

/**
 * Voids an approved bill by reversing its journal (D-16, D-38, C7).
 *
 * `bills.void` rather than `bills.write`: the catalog holds the code, and what it
 * names is the one operation that writes to the ledger without anybody composing
 * anything. The bill, its number and its original journal all stay visible — a
 * voided bill that vanished would make the gapless sequence a lie.
 */
export async function voidBill(
  billId: string,
  input: VoidDocumentRequest,
  ctx: RequestContext = getContext('voidBill()'),
): Promise<Bill> {
  await requirePermission(ctx, 'bills.void');
  const request = parseInput(voidDocumentRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(billId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'bill'), RESOURCE);

    await voidDocument(trx, row, request, ctx);
    return readBill(trx, id);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readBill(db: TenantDatabase, id: Buffer): Promise<Bill> {
  const row = assertFound(await selectDocumentById(db, id, 'bill'), RESOURCE);
  return toBill(await readDocumentView(db, row));
}

/**
 * The view narrowed to `billSchema`.
 *
 * `dueDate` is non-nullable on the wire and nullable in the column, because the
 * column is shared with vendor credits, which have none. Every bill this service
 * writes has one (`createBill` defaults it), so a null here is a fault rather than
 * a case — and `?? issueDate` would quietly invent a due date for a row written by
 * something else, which is how an aging report acquires a bucket nobody can trace.
 */
function toBill(view: ApDocumentView): Bill {
  if (view.dueDate === null) throw missingDueDate(view.id);

  return {
    id: view.id,
    documentNumber: view.documentNumber,
    reference: view.reference,
    contactId: view.contactId,
    issueDate: view.issueDate,
    dueDate: view.dueDate,
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

function toBillSummary(view: ApDocumentSummaryView): BillSummary {
  if (view.dueDate === null) throw missingDueDate(view.id);

  return {
    id: view.id,
    documentNumber: view.documentNumber,
    reference: view.reference,
    contactId: view.contactId,
    issueDate: view.issueDate,
    dueDate: view.dueDate,
    status: view.status,
    totals: view.totals,
    settlement: view.settlement,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function missingDueDate(id: string): InternalError {
  return new InternalError(
    `Bill ${id} has no due date. Every bill this service writes is given one at creation and ` +
      '`billSchema` requires it, so the row was written by something else.',
  );
}

function missingDueDateAtApproval(): ValidationError {
  return new ValidationError('This bill is not ready to approve.', [
    {
      path: 'dueDate',
      message:
        'A bill needs a due date before it can be approved. Aging measures from it rather than ' +
        'from the issue date (D-40), and `chk_ap_documents_bill_due` refuses the row without one.',
    },
  ]);
}
