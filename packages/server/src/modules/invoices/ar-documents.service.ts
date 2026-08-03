import type { JournalLineInput, PostJournalInput } from '@openbooks/plugin-api';
import type { DocumentLineInput, TaxMode, VoidDocumentRequest } from '@openbooks/shared-types';
import { quantityFromString, quantityUnits } from '@openbooks/shared-types';
import { fromMinorString, toMinorUnits } from '@openbooks/shared-types/money';

import type { RequestContext } from '../../context';
import type { KeysetPage, TenantDatabase } from '../../db';
import { bufferToUuid, tryUuidToBuffer, uuidToBuffer } from '../../db';
import type { ValidationIssue } from '../../errors';
import {
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
} from '../../errors';
import { assertCatalogItemsUsable } from '../catalog';
import { resolveTagsForNewLine } from '../dimensions';
import { emitEvent } from '../events';
import { postSaleCogs, reverseInventoryMovements } from '../inventory';
import { postJournal, reverseJournal } from '../ledger';
import { computePaymentTerm, resolveDocumentTerm } from '../payment-terms';
import { resolveControlAccount } from '../settings';
import { requirePermission } from '../permissions';

import type {
  DocumentFilters,
  DocumentLineRow,
  DocumentPageRow,
  DocumentRow,
  NewDocumentLineRow,
  TaxRateRow,
} from './ar-documents.repository';
import {
  allocateDocumentNumber,
  deleteDocumentRow,
  documentIdBytes,
  insertDocument,
  markApproved,
  markCogsJournal,
  markVoided,
  newDocumentId,
  orgScope,
  replaceDocumentLines,
  selectAllocations,
  selectContact,
  selectDocumentByIdForUpdate,
  selectDocumentById,
  selectDocumentLines,
  selectDocumentNumbers,
  selectDocumentsPage,
  selectExistingAccountIds,
  selectLineDimensions,
  selectTaxRates,
  updateDocumentRow,
  updateLineAmounts,
} from './ar-documents.repository';
import type { ArDocumentKind } from './kinds';
import type { DocumentView } from './projection';
import { toAllocations } from './projection';
import type { PriceableLine } from './pricing';
import {
  NO_TAX_RATE,
  minor,
  money,
  priceDocument,
  quantityFromMicros,
  quantityToMicros,
  toTaxRate,
} from './pricing';

/**
 * The AR document lifecycle, shared by invoices and credit notes (OB-062;
 * ROADMAP D-34, D-35, D-36, D-38, D-39).
 *
 * `invoices.service.ts` and `credit-notes.service.ts` are the public entry points:
 * they check the permission **before** parsing, parse with their own schema, and
 * call in here. Everything below is written once and takes an `ArDocumentKind`
 * (see `kinds.ts`), because a credit note is the same lifecycle pointed the other
 * way — the only sign anywhere in this module is `kind.controlSide`.
 *
 * The permission is re-checked here as well as at the entry point. It is free: the
 * role's bundle is memoized per request context (`permissions.service.ts`), so the
 * second check is a set lookup, and having it means a future caller reaching this
 * file directly cannot skip the gate.
 *
 * ## Approve is the irreversible step, and it is one transaction (D-38)
 *
 * Before approval a document is editable and discardable exactly as a journal draft
 * is (D-16, D-19). Approving allocates the number, posts the journal, and records
 * both — and `chk_ar_documents_approved` (`(journal_id IS NULL) = (sequence_number
 * IS NULL)`) makes a half-approved document *unrepresentable* rather than merely
 * avoided. After it, the ledger has been told, and the correction is a credit note
 * or a void, never an edit.
 *
 * ### The lock order, in full
 *
 *   1. the `ar_documents` row, `FOR UPDATE` — the first statement in the
 *      transaction, so a second approver blocks before it has read anything
 *   2. the `document_sequences` counter row for this org and type, `FOR UPDATE`
 *   3. the fiscal period row, `FOR UPDATE` (`assertPostable`, inside `postJournal`)
 *   4. the `journal_sequences` counter row, `FOR UPDATE` (inside `postJournal`)
 *
 * Steps 3 and 4 are `postJournal`'s and are always taken in that order; this module
 * adds 1 and 2 *outside* them. Two locks acquired in a consistent order across every
 * caller cannot deadlock, so the order above is this module's contract with the rest
 * of M3: **anything that takes a document sequence and then posts must take them in
 * this order.** The reverse in one path would be a deadlock that appears only under
 * concurrency, which is the worst kind to find.
 *
 * That the document lock comes first is also what makes it useful. Taken after
 * validation it would guard nothing, because the losing caller would already have
 * read a document that is about to be approved. Taken here, the loser blocks, and
 * when the winner commits the loser's locking read — a *current* read — returns a
 * row that carries a journal, and it refuses. One journal, one number, one refusal,
 * and no window in which both callers believe they hold a draft.
 *
 * ### A rolled-back approval consumes no number
 *
 * The counter is a row held for the life of the transaction (D-36, D-14). If
 * `postJournal` refuses — a closed period, a deactivated account, a contact taken
 * out of circulation — the whole transaction rolls back, including the counter's
 * increment, so the next approval takes the number this one did not. That is the
 * property `AUTO_INCREMENT` cannot offer, and a gap in a document series is
 * indistinguishable from a deleted document.
 *
 * ## What this module does not do
 *
 * It does not write a journal table. Every ledger effect goes through `postJournal`
 * and `reverseJournal`, which hold balance validation, the period lock, and actor
 * provenance — and which `openbooks/no-journal-writes` makes the only path. It does
 * not store a balance or a status (D-34, D-38); it does not compute tax
 * (`shared-types/tax/compute.ts` does, at D-35's two rounding points); and it does
 * not resolve dimension tags (`resolveTagsForNewLine` does, so the refusals a tag
 * can earn are the dimensions module's rules and not a second copy of them).
 */

/** The header fields a create takes, in the shape both request schemas produce. */
export interface CreateArDocumentInput {
  readonly contactId: string;
  readonly issueDate: string;
  /** Invoices only; absent on a credit note, which nothing chases. */
  readonly dueDate?: string | undefined;
  /**
   * The document's own term, overriding the contact's default (OB-136, D-108).
   * Invoices only, matching `dueDate` — not yet reachable from a wire request;
   * OB-139's routes are what gives a caller a field to put here.
   */
  readonly paymentTermId?: string | undefined;
  readonly taxMode: TaxMode;
  readonly reference?: string | null | undefined;
  readonly memo?: string | null | undefined;
  readonly lines?: readonly DocumentLineInput[] | undefined;
}

export interface UpdateArDocumentInput {
  readonly contactId?: string | undefined;
  readonly issueDate?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly taxMode?: TaxMode | undefined;
  readonly reference?: string | null | undefined;
  readonly memo?: string | null | undefined;
  readonly lines?: readonly DocumentLineInput[] | undefined;
}

export async function createArDocument(
  kind: ArDocumentKind,
  request: CreateArDocumentInput,
  ctx: RequestContext,
): Promise<DocumentView> {
  await requirePermission(ctx, kind.writePermission);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = newDocumentId();
    const contactId = await resolveContact(trx, request.contactId);

    // A term governs only the documents a business chases for payment (D-79,
    // D-108): a credit note never falls due and never earns an early-pay
    // discount, so none is resolved for one — matching `dueDate`'s own
    // `kind.documentType === 'invoice'` gate below.
    const term =
      kind.documentType === 'invoice'
        ? await resolveDocumentTerm(ctx, {
            contactId: request.contactId,
            documentTermId: request.paymentTermId,
          })
        : null;

    await insertDocument(trx, id, {
      createdByUserId: author,
      documentType: kind.documentType,
      contactId,
      issueDate: request.issueDate,
      // An explicit `dueDate` wins; otherwise a resolved term computes it
      // (`computePaymentTerm`, OB-136), and only a term-less invoice falls back
      // to due on receipt. Defaulted rather than left null because aging
      // measures from the due date (D-40) — a null one would make a document
      // that ages from nothing. A credit note has none at all.
      dueDate:
        kind.documentType === 'invoice'
          ? (request.dueDate ??
            (term === null
              ? request.issueDate
              : computePaymentTerm(term, request.issueDate, '0').dueDate))
          : null,
      // The term itself is recorded whenever one was resolved, independent of
      // whether `dueDate` was given explicitly — this is what lets OB-138 read
      // back which term's discount window governs the document later, rather
      // than only its already-computed due date.
      paymentTermId: term === null ? null : uuidToBuffer(term.id),
      taxMode: request.taxMode,
      reference: request.reference ?? null,
      memo: request.memo ?? null,
    });

    if (request.lines !== undefined) {
      await replaceDocumentLines(trx, id, await resolveLines(trx, request.lines, request.taxMode));
    }

    return readDocument(trx, kind, id);
  });
}

export async function getArDocument(
  kind: ArDocumentKind,
  documentId: string,
  ctx: RequestContext,
): Promise<DocumentView> {
  await requirePermission(ctx, kind.readPermission);

  const db = orgScope(ctx);
  return readDocument(db, kind, assertFound(documentIdBytes(documentId), kind.resource));
}

export async function listArDocuments(
  kind: ArDocumentKind,
  filters: DocumentFilters,
  limit: number,
  ctx: RequestContext,
): Promise<KeysetPage<DocumentPageRow>> {
  await requirePermission(ctx, kind.readPermission);
  return selectDocumentsPage(orgScope(ctx), kind, filters, limit);
}

/**
 * Updates the header, and — when `lines` is present — replaces the whole line set.
 *
 * The document row is taken `FOR UPDATE` before anything is written, for
 * `updateDraft`'s two reasons, the second of which is the one that matters: an edit
 * racing an approval cannot land between the approval's read of the lines and its
 * posting. Without the lock, a line added after the posting read them would be
 * priced into nothing — the document would carry a line the ledger never heard of,
 * and the invoice the customer receives would not be the entry the books hold.
 *
 * **An approved document accepts none of this.** Not because the schema forbids it
 * — `updateInvoiceRequestSchema` has no idea what state the document is in — but
 * because after approval the ledger has been told (D-38).
 */
export async function updateArDocument(
  kind: ArDocumentKind,
  documentId: string,
  request: UpdateArDocumentInput,
  ctx: RequestContext,
): Promise<DocumentView> {
  await requirePermission(ctx, kind.writePermission);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(documentId), kind.resource);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, kind, id), kind.resource);
    assertDraft(kind, row);

    const contactId =
      request.contactId === undefined ? undefined : await resolveContact(trx, request.contactId);

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
      // Changing the mode **reprices** the lines rather than converting them
      // (`updateInvoiceRequestSchema` says so on the wire, and this is where it
      // happens): the unit prices the user typed are unchanged and their meaning is
      // not, so every line's two rounded amounts are recomputed from the same
      // inputs. Repricing in place rather than through `replaceDocumentLines`
      // deliberately — a replace would issue new line ids and re-insert the tags,
      // and nothing about a mode change is a change to which department a line
      // belongs to.
      await repriceLines(trx, id, taxMode);
    }

    return readDocument(trx, kind, id);
  });
}

/**
 * Discards a draft and everything on it.
 *
 * This is the operation D-16 is about: a document that has not reached the ledger is
 * deleted outright, because deleting it removes nothing an auditor could ask about
 * — no report changes and no past date stops reproducing, since a draft was never in
 * one. It also holds no number: a draft that had reserved one and was then discarded
 * would leave a gap, and a gap is indistinguishable from a deleted document (D-36).
 *
 * The row is locked first so a discard racing an approval is settled by whichever
 * reaches the row first, with no half-state in either order.
 */
export async function discardArDocument(
  kind: ArDocumentKind,
  documentId: string,
  ctx: RequestContext,
): Promise<void> {
  await requirePermission(ctx, kind.writePermission);

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(documentId), kind.resource);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, kind, id), kind.resource);
    assertDraft(kind, row);

    if ((await deleteDocumentRow(trx, id)) !== 1) {
      throw new InternalError(
        'Discarding a document removed no row while holding its row lock. The document was read ' +
          'FOR UPDATE in this transaction, so it cannot have been removed by another one.',
      );
    }
  });
}

/**
 * Approves a draft: allocates its number, posts its journal, and records both.
 *
 * See the file header for the lock order and for why one transaction is the
 * requirement rather than an optimization. What is refused here, and why:
 *
 *  - **A document with no lines, or one totalling zero.** `postJournal` refuses a
 *    journal with fewer than two lines or no value, and its message would describe a
 *    journal the person approving never wrote. Refusing here names the document.
 *  - **An invoice with no due date.** `chk_ar_documents_invoice_due` refuses it at
 *    the database; reaching it would be a constraint violation surfacing as a 500.
 *
 * Everything else is `postJournal`'s and is deliberately not restated: balance,
 * the accounts' existence and activity, the contact's activity, the period lock, the
 * tags' validity, and actor provenance. A second copy of any of them would be a
 * second answer that drifts.
 *
 * Note that `postJournal` checks `journals.post` on its own. A caller holding
 * `invoices.write` and not `journals.post` is therefore refused at that point — see
 * the module's `index.ts`, which records that the seeded `ar_only` role is exactly
 * such a caller.
 */
export async function approveArDocument(
  kind: ArDocumentKind,
  documentId: string,
  ctx: RequestContext,
): Promise<DocumentView> {
  await requirePermission(ctx, kind.writePermission);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(documentId), kind.resource);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, kind, id), kind.resource);

    if (row.journal_id !== null) {
      throw new PreconditionFailedError(
        'document_already_approved',
        `This ${kind.resource} has already been approved. Approval posts to the ledger and ` +
          'happens once; correct it with a credit note or void it (D-38).',
      );
    }

    const lines = await selectDocumentLines(trx, id);
    const rates = await selectTaxRates(trx, rateIds(lines));
    const tags = await selectLineDimensions(
      trx,
      lines.map((line) => line.id),
    );
    const controlAccountId = await resolveControlAccount(trx, 'receivable');

    assertApprovable(kind, row, lines);

    const sequenceNumber = await allocateDocumentNumber(trx, kind.documentType);

    // `postJournal` joins this transaction ambiently (`transaction-scope.ts`), so the
    // number, the posting and the update below are one unit of work on one
    // connection. It is called, never re-implemented.
    //
    // The provenance is the *caller's*, not the document's author's: the journal
    // records who approved, which is the fact an auditor asks about, and who raised
    // the document stays on the document.
    const posted = await postJournal(
      toPostJournalInput(kind, row, sequenceNumber, lines, tags, rates, controlAccountId, ctx),
      ctx,
    );

    const updated = await markApproved(
      trx,
      id,
      sequenceNumber,
      uuidToBuffer(posted.journalId),
      new Date(),
    );
    if (updated !== 1) {
      throw new InternalError(
        `Approving a ${kind.resource} updated ${String(updated)} rows while holding its row ` +
          'lock. The document was read FOR UPDATE in this transaction, so it cannot have been ' +
          'approved by another one — the journal is posted and the document may not record it.',
      );
    }

    // Perpetual COGS (OB-224): an invoice whose lines cite tracked inventory items
    // posts a *second* journal — `Dr COGS / Cr inventory-asset` at the cost of the
    // units sold — separate from the revenue journal above so a void reverses both
    // (D-INV-7). `postSaleCogs` joins this transaction ambiently, filters to the
    // inventory-type lines itself, and returns null when none cost anything. A credit
    // note is deliberately excluded: it is not necessarily a physical return, so
    // restocking is a stock adjustment rather than an automatic reverse-COGS.
    if (kind.documentType === 'invoice') {
      const saleLines = lines.flatMap((line) =>
        line.catalog_item_id === null
          ? []
          : [
              {
                catalogItemId: bufferToUuid(line.catalog_item_id),
                quantityMicros: line.quantity_micros,
              },
            ],
      );
      if (saleLines.length > 0) {
        const cogsJournalId = await postSaleCogs(
          { lines: saleLines, date: row.issue_date, sourceDocId: documentId },
          ctx,
        );
        if (cogsJournalId !== null) {
          await markCogsJournal(trx, id, uuidToBuffer(cogsJournalId), new Date());
        }
      }
    }

    // The outbox append (OB-100, F7): same transaction as the write above, so an
    // event exists if and only if the approval committed. `total` is recomputed
    // rather than read back off `posted`, because `PostedJournal` carries per-line
    // amounts and no aggregate — the same sum `toPostJournalInput` posted as the
    // control account's line.
    const total = sumOf(lines, (line) => line.line_amount_minor + line.tax_amount_minor);
    const actor = {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    };
    if (kind.documentType === 'invoice') {
      await emitEvent(
        {
          name: 'invoice.approved.v1',
          orgId: ctx.orgId,
          actor,
          payload: {
            invoiceId: documentId,
            contactId: bufferToUuid(row.contact_id),
            journalId: posted.journalId,
            total,
            date: posted.date,
          },
        },
        ctx,
      );
    } else {
      await emitEvent(
        {
          name: 'credit_note.approved.v1',
          orgId: ctx.orgId,
          actor,
          payload: {
            creditNoteId: documentId,
            contactId: bufferToUuid(row.contact_id),
            journalId: posted.journalId,
            total,
            date: posted.date,
          },
        },
        ctx,
      );
    }

    return readDocument(trx, kind, id);
  });
}

/**
 * Voids an approved document by **reversing its journal** (D-16, D-38).
 *
 * Never a deletion. The document stays, with its number and its original journal,
 * and the reversal is a second journal recorded in `void_journal_id` — both visible,
 * because a voided document that vanished would make the gapless sequence a lie and
 * would leave a number nobody can account for.
 *
 * The reversal takes its own date, for `reverseJournal`'s reason: the document's
 * period is frequently closed by the time someone voids it, and correcting a closed
 * period by reopening it restates figures already reported, while a reversal in the
 * current period leaves those statements intact and shows the correction where it
 * happened.
 *
 * **A document with allocations against it is refused.** That rule is this module's
 * and it protects C2: the reversal removes the document from what is outstanding,
 * while an allocation of a payment to it would remain — so the payment would read as
 * fully applied, its own journal would still sit in the control account, and the
 * subledger and the ledger would disagree by exactly the allocated amount. The
 * allocations are read under the same row lock the allocation service takes before
 * it writes one (`0005_subledger`), so the check does not race.
 */
export async function voidArDocument(
  kind: ArDocumentKind,
  documentId: string,
  request: VoidDocumentRequest,
  ctx: RequestContext,
): Promise<DocumentView> {
  await requirePermission(ctx, kind.voidPermission);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(documentIdBytes(documentId), kind.resource);
    const row = assertFound(await selectDocumentByIdForUpdate(trx, kind, id), kind.resource);

    const journalId = row.journal_id;
    if (journalId === null) {
      throw new PreconditionFailedError(
        'document_not_approved',
        `This ${kind.resource} has not been approved, so there is nothing in the ledger to ` +
          'reverse. Discard it instead — a draft is deleted outright (D-16).',
      );
    }
    if (row.void_journal_id !== null) {
      throw new PreconditionFailedError(
        'document_already_void',
        `This ${kind.resource} is already void. Its journal has been reversed once, and ` +
          'reversing the reversal would re-instate it.',
      );
    }

    const allocations = await selectAllocations(trx, kind, id);
    if (allocations.length > 0) {
      throw new PreconditionFailedError(
        'document_has_allocations',
        `This ${kind.resource} has ${String(allocations.length)} allocation(s) against it. ` +
          'Remove them first: voiding reverses the journal, and an allocation left pointing at a ' +
          'voided document would make the subledger disagree with the control account by exactly ' +
          'the amount applied.',
      );
    }

    const reversal = await reverseJournal(
      {
        journalId: bufferToUuid(journalId),
        date: request.date,
        ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
      },
      ctx,
    );

    const updated = await markVoided(trx, id, uuidToBuffer(reversal.journalId), new Date());
    if (updated !== 1) {
      throw new InternalError(
        `Voiding a ${kind.resource} updated ${String(updated)} rows while holding its row lock. ` +
          'The reversal is posted and the document may not record it.',
      );
    }

    // The inventory void ripple (OB-224, D-INV-7): a voided invoice that posted COGS
    // must also reverse that COGS journal and emit compensating stock movements, or
    // Σ movements stops tying to the inventory-asset control account. The COGS
    // reversal is a second reversing journal, discoverable via `reverses_journal_id`;
    // `reverseInventoryMovements` appends the opposite deltas tied to it.
    if (row.cogs_journal_id !== null) {
      const cogsReversal = await reverseJournal(
        {
          journalId: bufferToUuid(row.cogs_journal_id),
          date: request.date,
          ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        },
        ctx,
      );
      await reverseInventoryMovements(
        {
          sourceDocId: documentId,
          mainOriginalJournalId: bufferToUuid(row.cogs_journal_id),
          mainReversalJournalId: cogsReversal.journalId,
          date: request.date,
        },
        ctx,
      );
    }

    return readDocument(trx, kind, id);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Everything a detail response is built from, in five statements.
 *
 * The totals are summed from the line rows this function already holds rather than
 * asked of the database again: the numbers are the same either way, and one
 * traversal cannot disagree with itself.
 */
async function readDocument(
  db: TenantDatabase,
  kind: ArDocumentKind,
  id: Buffer,
): Promise<DocumentView> {
  const row = assertFound(await selectDocumentById(db, kind, id), kind.resource);
  const lines = await selectDocumentLines(db, id);
  const tags = await selectLineDimensions(
    db,
    lines.map((line) => line.id),
  );
  const rates = await selectTaxRates(db, rateIds(lines));
  const allocationRows = await selectAllocations(db, kind, id);

  // The far end of each allocation, so both ends can be named. A credit note's
  // allocations point at invoices; an invoice's point back at the credit notes that
  // reduced it (a payment has no number to quote — D-36).
  const counterpartIds =
    kind.allocationColumn === 'credit_note_id'
      ? allocationRows.map((allocation) => allocation.invoice_id)
      : allocationRows
          .map((allocation) => allocation.credit_note_id)
          .filter((value): value is Buffer => value !== null);

  const counterpartNumbers = await selectDocumentNumbers(db, dedupe(counterpartIds));

  return {
    row,
    lines,
    tags,
    rates,
    allocations: toAllocations(kind, allocationRows, id, row.sequence_number, counterpartNumbers),
    net: sumOf(lines, (line) => line.line_amount_minor),
    tax: sumOf(lines, (line) => line.tax_amount_minor),
    allocated: sumOf(allocationRows, (allocation) => allocation.amount_minor),
  };
}

// ---------------------------------------------------------------------------
// Writing lines
// ---------------------------------------------------------------------------

/**
 * Turns wire lines into priced rows, resolving and checking every reference.
 *
 * The references are checked by *reading* them through `tenantDb` rather than by
 * letting the foreign keys refuse the insert. Both would refuse, and only this one
 * produces the right error: another org's account id arrives at the database as
 * errno 1452 and becomes a 500, where A7 requires the same 404 a nonexistent id
 * gets. The foreign keys stay as the backstop for the race between this read and the
 * insert.
 *
 * Every issue is collected before any is thrown, so a user fixing a document fixes
 * it in one pass rather than one field per attempt.
 */
async function resolveLines(
  db: TenantDatabase,
  lines: readonly DocumentLineInput[],
  mode: TaxMode,
): Promise<readonly NewDocumentLineRow[]> {
  const accountIds = dedupe(
    lines.map((line) => idBytes(line.accountId, 'account')).filter(isPresent),
  );
  const requestedRateIds = dedupe(
    lines
      .map((line) => (line.taxRateId == null ? undefined : idBytes(line.taxRateId, 'tax_rate')))
      .filter(isPresent),
  );

  const [accounts, rates] = await Promise.all([
    selectExistingAccountIds(db, accountIds),
    selectTaxRates(db, requestedRateIds),
  ]);

  if (accountIds.some((id) => !accounts.has(id.toString('hex'))))
    throw new NotFoundError('account');
  if (requestedRateIds.some((id) => !rates.has(id.toString('hex')))) {
    throw new NotFoundError('tax_rate');
  }

  // A catalog item on a line is checked here, where the line first cites it: it must
  // exist in this org (a cross-org id is A7's 404, B11) and be a `'sales'` item, an
  // invoice and a credit note both earning rather than spending (D-CAT-1). Its
  // `is_active` is deliberately not re-validated (D-CAT-2) — see `assertCatalogItemsUsable`.
  await assertCatalogItemsUsable(
    db,
    lines.flatMap((line) =>
      line.catalogItemId == null
        ? []
        : [{ catalogItemId: line.catalogItemId, expected: 'sales' as const }],
    ),
  );

  const issues: ValidationIssue[] = [];
  const priceable: PriceableLine[] = [];
  const resolved: Omit<NewDocumentLineRow, 'lineAmountMinor' | 'taxAmountMinor'>[] = [];

  for (const [index, line] of lines.entries()) {
    const path = `lines.${String(index)}`;
    const quantity = quantityFromString(line.quantity);
    const unitAmount = fromMinorString(line.unitAmount);

    // `quantitySchema` permits a negative quantity — a discount or a return line —
    // and `chk_ar_document_lines_quantity` forbids one. The table is right for this
    // document: every amount in the AR subsystem is non-negative and the *type*
    // carries the direction (D-39), so a negative line is a credit note. Refused
    // here rather than at the CHECK, which would arrive as a 500.
    if (quantityUnits(quantity) <= 0n) {
      issues.push({
        path: `${path}.quantity`,
        message:
          'A quantity must be greater than zero. A line that takes value off a document is a ' +
          'credit note, which is its own document with its own number (D-39) — not a negative ' +
          'line on this one.',
      });
    }

    if (toMinorUnits(unitAmount) < 0n) {
      issues.push({
        path: `${path}.unitAmount`,
        message:
          'A unit amount must not be negative. The document type carries the direction, so a ' +
          'negative price is a caller that has confused two models.',
      });
    }

    const rateRow = line.taxRateId == null ? undefined : rates.get(hexOf(line.taxRateId));

    // An archived rate stays on every document that already used it and cannot be
    // chosen for a new line (`taxRateSchema.isActive`). Enforced here because this
    // is where a line first cites one; the check is deliberately *not* repeated at
    // approval, where re-checking would refuse a document priced while the rate was
    // live and posted after somebody tidied the rate list.
    if (rateRow !== undefined && rateRow.is_active !== 1) {
      issues.push({
        path: `${path}.taxRateId`,
        message:
          'This tax rate is archived and cannot be put on a new line. An archived rate stays on ' +
          'the documents that already used it.',
      });
    }

    // A rate restricted to purchases may not price a sale (D-35, `applies_to` in
    // `0005_subledger`). Checked here, where the line first cites the rate, and
    // deliberately not repeated at approval — re-checking would refuse a document
    // priced while the rate was unrestricted and narrowed afterwards, which is the
    // same reasoning the archived check above follows.
    //
    // A `validation_failed` naming the line rather than a `precondition_failed`:
    // the fix is to pick a different rate on that line, which is a change to the
    // request, and the caller needs to know *which* line to change.
    if (rateRow !== undefined && rateRow.applies_to === 'purchases') {
      issues.push({
        path: `${path}.taxRateId`,
        message:
          'This tax rate applies to purchases only, so it cannot price a line on an invoice or ' +
          'a credit note. A rate posts to one account, and an org that reclaims input tax holds ' +
          'a separate rate for sales — using this one would post output tax to the input-tax ' +
          'account and the return would stop reconciling.',
      });
    }

    priceable.push({
      quantity,
      unitAmount,
      rate: rateRow === undefined ? NO_TAX_RATE : toTaxRate(rateRow.rate_ppm),
    });

    resolved.push({
      lineNumber: index + 1,
      description: line.description,
      quantityMicros: quantityToMicros(quantity),
      unitAmountMinor: toMinorUnits(unitAmount),
      accountId: idBytes(line.accountId, 'account'),
      taxRateId: line.taxRateId == null ? null : idBytes(line.taxRateId, 'tax_rate'),
      // Existence and direction were checked above; a malformed id is A7's 404 here
      // too, the same shape `accountId` and `taxRateId` take (D-CAT-2: provenance).
      catalogItemId:
        line.catalogItemId == null ? null : idBytes(line.catalogItemId, 'catalog_item'),
      // Resolved through the dimensions module, so the refusals a tag can earn —
      // unknown, cross-org, archived, two values on one axis — are that module's
      // rules and not a second implementation of them (D-18).
      dimensions: await resolveTagsForNewLine(line.dimensionValueIds ?? [], db),
    });
  }

  if (issues.length > 0) throw new ValidationError('Document line is not storable.', issues);

  // One call, at the end, so the document is priced by the shared implementation
  // exactly as a client previewing it would be — D-35's two rounding points, and
  // totals that are the sum of rounded lines rather than the rounded sum.
  const priced = priceDocument(priceable, mode);

  return resolved.map((line, index) => {
    const split = priced.lines[index];
    if (split === undefined) {
      throw new InternalError('The pricing returned fewer lines than it was given.');
    }
    return { ...line, lineAmountMinor: minor(split.net), taxAmountMinor: minor(split.tax) };
  });
}

/**
 * Recomputes both stored amounts on every line, under a new tax mode.
 *
 * In place rather than through a replace: the inputs (quantity, unit amount, rate)
 * have not changed and neither have the tags, so re-issuing line ids would churn
 * rows that nothing asked to change.
 */
async function repriceLines(db: TenantDatabase, id: Buffer, mode: TaxMode): Promise<void> {
  const lines = await selectDocumentLines(db, id);
  if (lines.length === 0) return;

  const rates = await selectTaxRates(db, rateIds(lines));
  const priced = priceDocument(
    lines.map((line) => toPriceableLine(line, rates)),
    mode,
  );

  for (const [index, line] of lines.entries()) {
    const split = priced.lines[index];
    if (split === undefined) {
      throw new InternalError('The pricing returned fewer lines than it was given.');
    }
    await updateLineAmounts(db, line.id, minor(split.net), minor(split.tax));
  }
}

function toPriceableLine(
  line: DocumentLineRow,
  rates: ReadonlyMap<string, TaxRateRow>,
): PriceableLine {
  const rate = line.tax_rate_id === null ? undefined : rates.get(line.tax_rate_id.toString('hex'));

  return {
    quantity: quantityFromMicros(line.quantity_micros),
    unitAmount: money(line.unit_amount_minor),
    rate: rate === undefined ? NO_TAX_RATE : toTaxRate(rate.rate_ppm),
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * The document as `postJournal` takes it.
 *
 * The shape is the same for both types and the direction is `kind.controlSide`,
 * which is the whole of D-39 in this file: an invoice debits the receivables
 * control account and credits income and tax; a credit note is the exact mirror,
 * because `addTax`/`extractTax` are symmetric about zero and the amounts are
 * identical.
 *
 * Three things about the lines are decisions rather than mechanics:
 *
 *  - **The control line carries the contact**, and the income and tax lines do not.
 *    A line naming a contact states who the amount is *with* (`0002_ledger`), and
 *    the amount that is with the customer is the receivable. Tagging the income
 *    lines with the contact too would double every per-contact figure read off the
 *    ledger.
 *  - **Tax posts per rate, not per line.** A document's tax is the sum of its
 *    rounded lines (D-35) either way, so grouping changes no number; it changes what
 *    the journal *says*, and one line per rate is what a return is filed from. Two
 *    rates sharing an account stay two lines for the same reason.
 *  - **Zero-value lines are dropped.** `postJournal` requires every line to be
 *    strictly positive, because the side carries the sign. A line whose extension
 *    rounds to nothing, or an untaxed line's absent tax, contributes nothing to the
 *    journal and its absence changes no total.
 */
function toPostJournalInput(
  kind: ArDocumentKind,
  row: DocumentRow,
  sequenceNumber: bigint,
  lines: readonly DocumentLineRow[],
  tags: ReadonlyMap<string, readonly string[]>,
  rates: ReadonlyMap<string, TaxRateRow>,
  controlAccountId: Buffer,
  ctx: RequestContext,
): PostJournalInput {
  const gross = sumOf(lines, (line) => line.line_amount_minor + line.tax_amount_minor);
  const opposite = kind.controlSide === 'debit' ? 'credit' : 'debit';
  const reference = `${kind.label} ${sequenceNumber.toString()}`;

  const journalLines: JournalLineInput[] = [
    {
      accountId: bufferToUuid(controlAccountId),
      side: kind.controlSide,
      amount: gross,
      memo: reference,
      contactId: bufferToUuid(row.contact_id),
    },
  ];

  for (const line of lines) {
    if (line.line_amount_minor <= 0n) continue;
    const lineTags = tags.get(line.id.toString()) ?? [];

    journalLines.push({
      accountId: bufferToUuid(line.account_id),
      side: opposite,
      amount: line.line_amount_minor,
      ...(line.description === null ? {} : { memo: line.description }),
      ...(lineTags.length === 0 ? {} : { dimensionValueIds: lineTags }),
    });
  }

  for (const group of taxByRate(lines, rates)) {
    journalLines.push({
      accountId: bufferToUuid(group.accountId),
      side: opposite,
      amount: group.amount,
      memo: group.name,
    });
  }

  return {
    date: row.issue_date,
    // The document's own memo when it has one, and its number when it does not, so
    // a journal list is readable without joining back to the subledger.
    memo: row.memo ?? reference,
    // `invoice` or `credit_note` — the origin the subledger header always claimed
    // the journal carries and, before OB-091, never actually set.
    source: kind.documentType,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    lines: journalLines,
  };
}

interface TaxGroup {
  readonly accountId: Buffer;
  readonly name: string;
  readonly amount: bigint;
}

/** The document's tax, grouped by the rate that produced it, in line order. */
function taxByRate(
  lines: readonly DocumentLineRow[],
  rates: ReadonlyMap<string, TaxRateRow>,
): readonly TaxGroup[] {
  const groups = new Map<string, { rate: TaxRateRow; amount: bigint }>();

  for (const line of lines) {
    if (line.tax_amount_minor <= 0n || line.tax_rate_id === null) continue;

    const key = line.tax_rate_id.toString('hex');
    const rate = rates.get(key);
    if (rate === undefined) {
      // `fk_ar_document_lines_tax_rate` guarantees the row exists in this org, and
      // the rates were read from the same transaction. Reaching here means a rate
      // was deleted between the two, which RESTRICT forbids.
      throw new InternalError(
        'A document line cites a tax rate that no longer exists; ' +
          'fk_ar_document_lines_tax_rate should make that impossible.',
      );
    }

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { rate, amount: line.tax_amount_minor });
    } else {
      existing.amount += line.tax_amount_minor;
    }
  }

  return [...groups.values()].map((group) => ({
    accountId: group.rate.tax_account_id,
    name: group.rate.name,
    amount: group.amount,
  }));
}

function assertApprovable(
  kind: ArDocumentKind,
  row: DocumentRow,
  lines: readonly DocumentLineRow[],
): void {
  const issues: ValidationIssue[] = [];

  if (lines.length === 0) {
    issues.push({
      path: 'lines',
      message: `A ${kind.resource} needs at least one line before it can be approved.`,
    });
  } else if (sumOf(lines, (line) => line.line_amount_minor + line.tax_amount_minor) <= 0n) {
    issues.push({
      path: 'lines',
      message:
        `This ${kind.resource} totals zero. Approving posts a journal, and a journal must move ` +
        'a non-zero amount.',
    });
  }

  if (kind.documentType === 'invoice' && row.due_date === null) {
    issues.push({
      path: 'dueDate',
      message:
        'An invoice needs a due date before it can be approved. Aging measures from it (D-40), ' +
        'and `chk_ar_documents_invoice_due` refuses an approved invoice without one.',
    });
  }

  if (issues.length > 0) {
    throw new ValidationError(`This ${kind.resource} is not ready to approve.`, issues);
  }
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

function assertDraft(kind: ArDocumentKind, row: DocumentRow): void {
  if (row.journal_id === null) return;

  throw new PreconditionFailedError(
    'document_approved',
    `This ${kind.resource} has been approved, so it can no longer be edited or discarded. The ` +
      'ledger has been told (D-38): correct it with a credit note, or void it — which reverses ' +
      'its journal and leaves both visible.',
  );
}

/**
 * A reference id as bytes.
 *
 * A malformed id is a miss rather than a validation failure, for the reason
 * `tryUuidToBuffer` gives: 400 for a malformed id and 404 for an unknown one is a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
function idBytes(value: string, resource: string): Buffer {
  return assertFound(tryUuidToBuffer(value), resource);
}

function hexOf(value: string): string {
  return idBytes(value, 'tax_rate').toString('hex');
}

/**
 * The contact, which must exist in this org.
 *
 * Existence only. Whether the contact is still *active* is checked at approval, by
 * `postJournal`, because that is where naming it in the ledger happens — and a
 * document composed while a contact was live must be a draft somebody can fix
 * rather than a draft they cannot save.
 */
async function resolveContact(db: TenantDatabase, contactId: string): Promise<Buffer> {
  const id = idBytes(contactId, 'contact');
  assertFound(await selectContact(db, id), 'contact');
  return id;
}

function rateIds(lines: readonly DocumentLineRow[]): readonly Buffer[] {
  return dedupe(lines.map((line) => line.tax_rate_id).filter(isPresent));
}

function dedupe(ids: readonly Buffer[]): readonly Buffer[] {
  return [...new Map(ids.map((id) => [id.toString('hex'), id])).values()];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function sumOf<T>(rows: readonly T[], of: (row: T) => bigint): bigint {
  return rows.reduce((total, row) => total + of(row), 0n);
}

function requireAuthor(ctx: RequestContext): Buffer {
  const userId =
    ctx.userId === null || ctx.userId === undefined ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    // `ar_documents.created_by_user_id` is NOT NULL and references `users`, and it
    // is RESTRICT where a draft's author CASCADEs: an approved invoice is a fact,
    // and who raised it is part of the record.
    throw new ValidationError('A document is raised by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot raise a document. Who raised an ' +
          'invoice is part of the record it becomes.',
      },
    ]);
  }
  return userId;
}
