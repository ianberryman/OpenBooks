import type {
  CreateExpenseRequest,
  Expense,
  ExpensePage,
  ExpenseSummary,
  ListExpensesQuery,
  UpdateExpenseRequest,
} from '@openbooks/shared-types';
import {
  createExpenseRequestSchema,
  listExpensesQuerySchema,
  updateExpenseRequestSchema,
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
// The leaf module, not the pay-bills barrel — `bills.service.ts`'s own reason
// for the same import applies unchanged: an expense is a `document_type='bill'`
// row (D-M2), so it is just as payable through the Pay Bills queue as a vendor
// bill, and `committed` means the same thing for both.
import { committedTotals } from '../pay-bills/queue.repository';

import type { ApDocumentFilters } from '../bills/ap-documents.repository';
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
  updateDocumentRow,
} from '../bills/ap-documents.repository';
import type { ApDocumentSummaryView, ApDocumentView } from '../bills/ap-documents.service';
import {
  approveDocument,
  assertDraft,
  assertHasValue,
  lifecycleFor,
  readDocumentView,
  repriceLines,
  requireAuthor,
  requireEmployee,
  resolveLines,
  toSummaryPage,
} from '../bills/ap-documents.service';

import { selectExpensesPage } from './expenses.repository';

/**
 * Expenses — employee reimbursements, entered as bills (initiative M, OB-177;
 * ROADMAP D-M2).
 *
 * An employee expense **is** an `ap_documents` bill (`document_type='bill'`)
 * whose contact carries `is_employee`. This file is `bills.service.ts` cloned
 * with exactly two swaps: `requireVendor` → `requireEmployee`, and the
 * `bills.*` permission keys → `expenses.*`. Every primitive that does real
 * work — `resolveLines`, `approveDocument`, `readDocumentView`, the journal
 * direction inside `ap-documents.service.ts` — is `createBill`'s own, reused
 * verbatim; nothing about posting an expense is reimplemented here.
 *
 * `expenses.approve` is the one place this surface is *not* a bill-for-bill
 * copy of `bills.service.ts`: entry (`expenses.write`) is separated from
 * approval (`expenses.approve`), the way `disbursements.issue` is separated
 * from `pending_payments.write` in Pay Bills. A bill has no such split —
 * `approveBill` is gated by `bills.write`, the same key that creates one —
 * because the catalog holds no `bills.approve` (spec §5 fixes the catalog).
 * Expenses gets its own approval key because reimbursement is money leaving
 * the business on an employee's word, and the SoD argument that justifies a
 * release gate for a disbursement applies here too: the clerk who enters an
 * expense should not be the only signature it needs before it becomes a
 * payable.
 *
 * There is no `voidExpense`, `discardExpense` only reaches drafts, and there
 * is no `expenses.void` in the catalog — a mis-entered expense reimbursement
 * is corrected exactly as a mis-entered bill is: a vendor credit against the
 * same contact, or a void through `voidBill` (the row is the same table, the
 * same document type, and `bills.void` already gates that operation).
 */

const RESOURCE = AP_DOCUMENT_RESOURCE.bill;

/**
 * Creates a draft expense.
 *
 * Everything `createBill`'s own doc comment argues about `dueDate` and the
 * payment-term resolution applies unchanged — the row this writes is
 * indistinguishable from a bill until the reader checks the contact's flags,
 * and the due-date default exists for the same aging reason (D-40). The only
 * difference is which contact flag is required: `requireEmployee` rather than
 * `requireVendor`.
 */
export async function createExpense(
  input: CreateExpenseRequest,
  ctx: RequestContext = getContext('createExpense()'),
): Promise<Expense> {
  await requirePermission(ctx, 'expenses.write');
  const request = parseInput(createExpenseRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const contactId = assertFound(tryUuidToBuffer(request.contactId), 'contact');
    await requireEmployee(trx, contactId);

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
      paymentTermId: term === null ? null : uuidToBuffer(term.id),
      taxMode: request.taxMode,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
    });

    if (request.lines !== undefined) {
      await replaceDocumentLines(trx, id, await resolveLines(trx, request.lines, request.taxMode));
    }

    return readExpense(trx, id);
  });
}

export async function getExpense(
  expenseId: string,
  ctx: RequestContext = getContext('getExpense()'),
): Promise<Expense> {
  await requirePermission(ctx, 'expenses.read');

  const db = orgScope(ctx);
  return readExpense(db, assertFound(documentIdBytes(expenseId), RESOURCE));
}

/**
 * One page of the org's expenses, oldest first (D-21) — bills whose contact is
 * an employee, and only those (D-M8). `selectExpensesPage` is the one query
 * this module does not share with `bills.service.ts`: it joins `contacts` and
 * filters `is_employee = 1` so the two lists stay clean mirrors of each other,
 * a contact flagged both a vendor and an employee appearing on both by the
 * user's own explicit choice.
 */
export async function listExpenses(
  query: ListExpensesQuery,
  ctx: RequestContext = getContext('listExpenses()'),
): Promise<ExpensePage> {
  await requirePermission(ctx, 'expenses.read');
  const request = parseInput(listExpensesQuerySchema, query);
  const limit = resolvePageLimit(request.limit);
  const lifecycle = lifecycleFor(request.status);

  const filters: ApDocumentFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.dueBefore === undefined ? {} : { dueBefore: request.dueBefore }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };

  const db = orgScope(ctx);
  const page = await selectExpensesPage(db, filters, limit);
  // `toSummaryPage` is `ap-documents.service.ts`'s own aggregation over
  // `ap_documents`/`ap_document_lines`, keyed by the row ids already in hand —
  // it does not care that these rows came from the employee-joined page rather
  // than `selectDocumentsPage`, and `'bill'` is the right `documentType` for
  // both (D-M2).
  const ids = page.rows.map((row) => row.id);
  const [summaries, committedByBill] = await Promise.all([
    toSummaryPage(db, 'bill', page.rows, request.status),
    committedTotals(db, ids),
  ]);

  return {
    items: summaries.map((view) =>
      toExpenseSummary(view, committedByBill.get(uuidToBuffer(view.id).toString('hex')) ?? 0n),
    ),
    nextCursor: page.nextCursor,
  };
}

/**
 * Updates a draft's header, and — when `lines` is present — replaces the whole
 * line set. See `updateBill` for the `FOR UPDATE` and re-pricing arguments,
 * which apply here unchanged.
 */
export async function updateExpense(
  expenseId: string,
  input: UpdateExpenseRequest,
  ctx: RequestContext = getContext('updateExpense()'),
): Promise<Expense> {
  await requirePermission(ctx, 'expenses.write');
  const request = parseInput(updateExpenseRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(expenseId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'bill'), RESOURCE);
    assertDraft(row);

    const contactId =
      request.contactId === undefined
        ? undefined
        : assertFound(tryUuidToBuffer(request.contactId), 'contact');
    if (contactId !== undefined) await requireEmployee(trx, contactId);

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

    return readExpense(trx, id);
  });
}

/**
 * Discards a draft expense and everything on it. See `discardBill`: nothing
 * reached the ledger, so nothing is restated and no number was consumed.
 */
export async function discardExpense(
  expenseId: string,
  ctx: RequestContext = getContext('discardExpense()'),
): Promise<void> {
  await requirePermission(ctx, 'expenses.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(expenseId), RESOURCE);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, id, 'bill'), RESOURCE);
    assertDraft(row);

    if ((await deleteDraftDocument(trx, id, 'bill')) !== 1) {
      throw new InternalError(
        'Discarding an expense deleted no rows while holding its row lock. The expense was read ' +
          'FOR UPDATE in this transaction, so it cannot have been removed by another one.',
      );
    }
  });
}

/**
 * Approves an expense: numbers it and posts its journal, in one transaction
 * (D-38), gated by `expenses.approve` rather than `expenses.write` — the SoD
 * split this module adds on top of `approveDocument`, which supplies
 * everything else: the lock order, the exactly-once argument, and (because the
 * row's `document_type` is `'bill'`) the duplicate-vendor-reference check too,
 * running here against whatever the caller put in `reference` for this
 * expense. It debits the expense lines and **credits** accounts payable —
 * `journalSides('bill')` — which is the correct direction for a reimbursement
 * owed to the employee, not paid yet.
 *
 * The event emitted is `bill.approved.v1`, unchanged. An expense-bill is a
 * bill, and a second event name for the identical fact would be a second
 * consumer contract for something `packages/server/src/modules/events` and any
 * subscriber already understand.
 */
export async function approveExpense(
  expenseId: string,
  ctx: RequestContext = getContext('approveExpense()'),
): Promise<Expense> {
  await requirePermission(ctx, 'expenses.approve');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(expenseId), RESOURCE);

    const outcome = await approveDocument(trx, id, 'bill', ctx, async (row, lines) => {
      if (row.due_date === null) throw missingDueDateAtApproval();
      assertHasValue(lines, 'bill');
      await requireEmployee(trx, row.contact_id);
    });

    const expense = await readExpense(trx, id);

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
          billId: expenseId,
          contactId: expense.contactId,
          journalId: outcome.journal.journalId,
          total: fromMinorString(expense.totals.gross),
          date: outcome.journal.date,
        },
      },
      ctx,
    );

    return expense;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readExpense(db: TenantDatabase, id: Buffer): Promise<Expense> {
  const row = assertFound(await selectDocumentById(db, id, 'bill'), RESOURCE);
  const committed = await committedTotals(db, [id]);
  return toExpense(await readDocumentView(db, row), committed.get(id.toString('hex')) ?? 0n);
}

/**
 * The view narrowed to `billSchema` (an expense's response shape, D-M2). See
 * `toBill` for why a null `dueDate` is a fault rather than a case: every
 * expense this service writes is given one at creation.
 */
function toExpense(view: ApDocumentView, committed: bigint): Expense {
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
    committed: committed.toString(),
    allocations: [...view.allocations],
    journalId: view.journalId,
    voidJournalId: view.voidJournalId,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function toExpenseSummary(view: ApDocumentSummaryView, committed: bigint): ExpenseSummary {
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
    committed: committed.toString(),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function missingDueDate(id: string): InternalError {
  return new InternalError(
    `Expense ${id} has no due date. Every expense this service writes is given one at creation ` +
      'and `billSchema` requires it, so the row was written by something else.',
  );
}

function missingDueDateAtApproval(): ValidationError {
  return new ValidationError('This expense is not ready to approve.', [
    {
      path: 'dueDate',
      message:
        'An expense needs a due date before it can be approved. Aging measures from it rather ' +
        'than from the issue date (D-40), and `chk_ap_documents_bill_due` refuses the row ' +
        'without one.',
    },
  ]);
}
