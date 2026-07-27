import type { Allocation, CreateAllocationsRequest } from '@openbooks/shared-types';
import { createAllocationsRequestSchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { NotFoundError, PreconditionFailedError, assertFound, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { AllocationSource } from './allocate';
import { applyAllocations } from './allocate';
import {
  ALLOCATION_RESOURCE,
  DOCUMENT_RESOURCE,
  allocatedFromDocument,
  allocatedFromPayment,
  allocationIdBytes,
  deleteAllocationById,
  documentIdBytes,
  documentTotal,
  findAllocation,
  selectAllocations,
  selectDocumentByIdForUpdate,
} from './allocations.repository';
import type { SubledgerSide } from '../settings';
import { requireRecordingUser } from './input';
import {
  PAYMENT_RESOURCE,
  orgScope,
  paymentIdBytes,
  selectPaymentById,
  selectPaymentByIdForUpdate,
  sideOf,
  toWireDirection,
} from './payments.repository';
import { requirePaymentWrite } from './payments.service';

/**
 * Applying and un-applying (OB-064; ROADMAP D-37, D-39).
 *
 * Four entry points and one mechanism. Whichever source is being applied, the work
 * is `applyAllocations` in `allocate.ts` — that is D-39's "one definition of
 * outstanding regardless of what reduced it" expressed as a call graph rather than
 * as a promise, and it is why nothing downstream of these functions knows or cares
 * whether a payment or a credit note reduced an invoice.
 *
 * Each entry point does three things and then hands over:
 *
 *   1. checks the permission that governs *its* source — a receipt is
 *      `payments_received.write`, a credit note is `credit_notes.write`
 *   2. resolves the source and locks its row, which is where "how much is left to
 *      apply" is read, and reads it under the lock so two batches cannot each
 *      spend the same remainder
 *   3. computes the default date, which is the source's own (D-40)
 *
 * ## Nothing here posts a journal
 *
 * Worth repeating at the surface, because it is the property a reviewer will look
 * for and not finding it can read as an omission. The money moved when the payment
 * posted, and the credit arose when the credit note was approved. An allocation
 * records which document that movement was for. A journal here would double-count
 * — see the file header in `allocate.ts`.
 */

/**
 * Applies a recorded payment to one or more documents.
 *
 * The payment's row is taken `FOR UPDATE` before its remaining amount is read, for
 * the same reason the target documents are: "how much of this payment is left" is
 * a `SUM` over rows another transaction can be inserting, and a decision made from
 * an unlocked read of it is a decision two callers can make at once.
 */
export async function allocatePayment(
  paymentId: string,
  input: CreateAllocationsRequest,
  ctx: RequestContext = getContext('allocatePayment()'),
): Promise<readonly Allocation[]> {
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const id = assertFound(paymentIdBytes(paymentId), PAYMENT_RESOURCE);
    const found = assertFound(await selectPaymentById(trx, id), PAYMENT_RESOURCE);

    await requirePaymentWrite(ctx, toWireDirection(found.direction));
    const request = parseInput(createAllocationsRequestSchema, input);
    const author = requireRecordingUser(ctx);

    const payment = assertFound(await selectPaymentByIdForUpdate(trx, id), PAYMENT_RESOURCE);

    if (payment.void_journal_id !== null) {
      throw new PreconditionFailedError(
        'payment_void',
        'This payment has been voided: its journal is reversed, so no money is available to ' +
          'apply. Record the payment again if it did in fact arrive.',
      );
    }

    const allocated = await allocatedFromPayment(trx, id);

    const source: AllocationSource = {
      side: sideOf(payment.direction),
      kind: 'payment',
      id,
      contactId: payment.contact_id,
      available: payment.amount_minor - allocated,
      label: 'payment',
    };

    const written = await applyAllocations(
      trx,
      source,
      request.allocations,
      request.date ?? payment.payment_date,
      author,
    );

    return selectAllocations(trx, source.side, { kind: 'ids', ids: written });
  });
}

/**
 * Applies a credit note to one or more invoices — D-39's whole point.
 *
 * A credit note is a document, not a negative invoice, and it reduces what is owed
 * through the same rows a payment does. So this function differs from
 * `allocatePayment` in three lines: the permission, where the available amount
 * comes from (the document's total minus what has already been given, rather than
 * a payment's amount minus what has been applied), and the default date.
 */
export async function allocateCreditNote(
  creditNoteId: string,
  input: CreateAllocationsRequest,
  ctx: RequestContext = getContext('allocateCreditNote()'),
): Promise<readonly Allocation[]> {
  await requirePermission(ctx, 'credit_notes.write');
  return allocateCreditDocument(
    'receivable',
    'credit_note',
    'credit note',
    creditNoteId,
    input,
    ctx,
  );
}

/** The payables mirror: a vendor credit applied to bills. */
export async function allocateVendorCredit(
  vendorCreditId: string,
  input: CreateAllocationsRequest,
  ctx: RequestContext = getContext('allocateVendorCredit()'),
): Promise<readonly Allocation[]> {
  await requirePermission(ctx, 'vendor_credits.write');
  return allocateCreditDocument(
    'payable',
    'vendor_credit',
    'vendor credit',
    vendorCreditId,
    input,
    ctx,
  );
}

/**
 * Removes one allocation, which is how something is un-applied.
 *
 * An ordinary delete, not a reversing row, and `0005_subledger` argues why at the
 * table: the allocation posted no journal, so removing it restates no financial
 * statement. What changes is what is outstanding, and that is computed on read
 * (D-34) — there is nothing else to correct anywhere.
 *
 * No lock is taken. Every check this module makes is of the form "is there room
 * for this much", and removing an allocation only ever makes more room; a delete
 * racing an allocation therefore cannot produce a state either of them would have
 * refused. The delete itself is serialized by InnoDB on the row.
 *
 * The permission is the *source's*, because un-applying is a change to what that
 * payment or credit note has done — the same authority that applied it.
 */
export async function deleteAllocation(
  allocationId: string,
  ctx: RequestContext = getContext('deleteAllocation()'),
): Promise<void> {
  const db = orgScope(ctx);

  await db.transaction(async (trx) => {
    const id = assertFound(allocationIdBytes(allocationId), ALLOCATION_RESOURCE);
    const allocation = assertFound(await findAllocation(trx, id), ALLOCATION_RESOURCE);

    if (allocation.paymentId !== null) {
      const payment = assertFound(
        await selectPaymentById(trx, allocation.paymentId),
        ALLOCATION_RESOURCE,
      );
      await requirePaymentWrite(ctx, toWireDirection(payment.direction));
    } else if (allocation.side === 'receivable') {
      await requirePermission(ctx, 'credit_notes.write');
    } else {
      await requirePermission(ctx, 'vendor_credits.write');
    }

    await deleteAllocationById(trx, allocation.side, id);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function allocateCreditDocument(
  side: SubledgerSide,
  documentType: 'credit_note' | 'vendor_credit',
  label: 'credit note' | 'vendor credit',
  documentId: string,
  input: CreateAllocationsRequest,
  ctx: RequestContext,
): Promise<readonly Allocation[]> {
  const request = parseInput(createAllocationsRequestSchema, input);
  const author = requireRecordingUser(ctx);
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const id = assertFound(documentIdBytes(documentId), DOCUMENT_RESOURCE);
    const document = assertFound(
      await selectDocumentByIdForUpdate(trx, side, id),
      DOCUMENT_RESOURCE,
    );

    // An id naming an invoice is not a credit note that exists elsewhere — it is
    // no credit note at all, so it is the same 404 an unknown id gets (A7's shape,
    // applied within an org rather than across them).
    if (document.document_type !== documentType) throw new NotFoundError(DOCUMENT_RESOURCE);

    if (document.journal_id === null) {
      throw new PreconditionFailedError(
        'document_not_approved',
        `This ${label} is still a draft, so there is no credit to apply. Approving it is what ` +
          'posts the journal the credit comes from.',
      );
    }
    if (document.void_journal_id !== null) {
      throw new PreconditionFailedError(
        'document_void',
        `This ${label} has been voided: its journal is reversed, so the credit no longer exists.`,
      );
    }

    const source: AllocationSource = {
      side,
      kind: 'credit_document',
      id,
      contactId: document.contact_id,
      available:
        (await documentTotal(trx, side, id)) - (await allocatedFromDocument(trx, side, id)),
      label,
    };

    const written = await applyAllocations(
      trx,
      source,
      request.allocations,
      request.date ?? document.issue_date,
      author,
    );

    return selectAllocations(trx, side, { kind: 'ids', ids: written });
  });
}
