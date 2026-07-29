import type { DiscountSuggestion } from '@openbooks/shared-types';
import { calendarDateSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, tryUuidToBuffer } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import type { ApDocumentRow } from '../bills/ap-documents.repository';
import {
  AP_DOCUMENT_RESOURCE,
  selectDocumentById as selectApDocumentById,
} from '../bills/ap-documents.repository';
import type { DocumentRow as ArDocumentRow } from '../invoices/ar-documents.repository';
import { selectDocumentById as selectArDocumentById } from '../invoices/ar-documents.repository';
import { INVOICE_KIND } from '../invoices/kinds';
import { allocatedToDocument, documentTotal } from '../payments/allocations.repository';
import { requirePermission } from '../permissions';
import type { SubledgerSide } from '../settings';
import { resolveDiscountAccount } from '../settings';

import { computePaymentTerm } from './compute-term';
import { orgScope } from './terms.repository';
import { resolveDocumentTerm } from './terms.service';

/**
 * The terms-driven discount preview (OB-138; ROADMAP D-79, D-106, D-108).
 *
 * A read/preview only — it computes `discountSuggestionSchema`'s shape and returns
 * it; nothing here writes an allocation or a journal (D-43, D-106's own "never
 * auto-posted"). The bank-match workbench and the money-in screen (OB-140) call
 * this before a human confirms it as a `discount`-kind allocation plus a real
 * journal line, which is a different write path entirely (D-106) and not this
 * ticket's.
 *
 * ## What "outstanding" means here
 *
 * `documentTotal`/`allocatedToDocument` (`modules/payments/allocations.repository.ts`)
 * are the same two reads every other "what is left on this document" figure in the
 * system is built from (D-34) — this file adds no third way to compute it. Neither
 * takes a lock: a suggestion is advisory, read again by the confirm path (D-106's
 * discount-kind allocation) under the same `FOR UPDATE`/`FOR SHARE` discipline
 * `over-allocation-race.test.ts` proves is load-bearing there. A stale suggestion
 * shown to a human and then refused at confirm time is an acceptable preview
 * staleness; a stale suggestion that itself posted would not be.
 *
 * ## Why a draft or a void document answers null
 *
 * `documentTotal`/`allocatedToDocument` do not know about `journal_id`/
 * `void_journal_id` — they sum lines and allocations regardless of lifecycle,
 * exactly as they are used elsewhere (D-34's own point: outstanding is computed,
 * not stored). A draft has no allocations yet, so the naive `total − allocated`
 * would be the whole total and would suggest a discount on a document nothing has
 * been posted for; a void has been reversed out of the ledger and owes nothing.
 * `readDocumentView`'s `settlementOf` draws the same line for the same reason
 * (`ap-documents.service.ts`) — this function draws it too rather than surfacing a
 * suggestion for a document that is not, in the ledger's own terms, open.
 */

/** Which side of the shared AP+AR primitive a target document is on. */
const SIDE_BY_TARGET_TYPE: Readonly<Record<'invoice' | 'bill', SubledgerSide>> = {
  invoice: 'receivable',
  bill: 'payable',
};

export interface SuggestDiscountInput {
  readonly targetType: 'invoice' | 'bill';
  readonly targetId: string;
  readonly asOfDate: string;
}

/**
 * A discount suggestion for one invoice or bill, as of a date — or `null` when
 * there is nothing to suggest.
 *
 * `null` covers five distinct reasons, deliberately collapsed to one answer
 * rather than five: the document names no term (or names one with no discount at
 * all — a simple term); the document is a draft or a void, so nothing is owed;
 * the document has nothing outstanding (paid in full, or over-applied — C3
 * refuses that regardless); `asOfDate` is past the term's discount deadline; and
 * the org has not nominated a usable discount-given/received account. A caller
 * showing a suggestion affordance treats all five the same way — there is
 * nothing to offer — and a reason string would be a second thing every future
 * caller has to keep in sync with the five checks below, for no decision anyone
 * makes differently. The one case this deliberately does *not* fold in is a
 * malformed `targetId`/`asOfDate` or a cross-org `targetId`, which are refused
 * (A7's 404, or a `ValidationError`) rather than answered `null` — those are
 * caller mistakes, not "nothing to suggest today".
 *
 * ## The discount's base: document total, unless partially paid
 *
 * D-79's "2/10 Net 30" convention prices the discount off the invoice's face
 * amount, not off whatever happens to remain — an org that offers 2% for paying
 * within 10 days means 2% of what was billed. So the base is the document
 * **total** by default. The one case that reads differently is a document that
 * already carries a partial allocation (some of it settled, discount or not,
 * before this preview ran): the remaining, un-settled amount is all that is left
 * to earn a discount on, so the base there is **outstanding** — total minus what
 * has already been applied. Both branches read `computePaymentTerm`'s own
 * one-multiplication-one-rounding arithmetic (`compute-term.ts`) against whichever
 * base is chosen; nothing here re-derives the percentage.
 */
export async function suggestDiscount(
  ctx: RequestContext,
  input: SuggestDiscountInput,
): Promise<DiscountSuggestion | null> {
  // Two literal `requirePermission` calls rather than one on a computed key, so
  // the enforcement points stay greppable — `payments.service.ts`'s own
  // `requirePaymentRead` argues this at length: a key assembled at runtime is an
  // enforcement point `permission-matrix.test.ts`'s source scan cannot see.
  if (input.targetType === 'invoice') {
    await requirePermission(ctx, 'invoices.read');
  } else {
    await requirePermission(ctx, 'bills.read');
  }
  const asOfDate = parseInput(calendarDateSchema, input.asOfDate);

  const db = orgScope(ctx);
  const side = SIDE_BY_TARGET_TYPE[input.targetType];
  const documentId = assertFound(
    tryUuidToBuffer(input.targetId),
    input.targetType === 'invoice' ? INVOICE_KIND.resource : AP_DOCUMENT_RESOURCE.bill,
  );

  const document = await loadDocument(db, input.targetType, documentId);
  if (document.journal_id === null || document.void_journal_id !== null) return null;

  const [total, allocated] = await Promise.all([
    documentTotal(db, side, documentId),
    allocatedToDocument(db, side, documentId),
  ]);
  const outstanding = total - allocated;
  if (outstanding <= 0n) return null;

  // Untouched (`allocated === 0n`): price the discount off the face amount, per
  // D-79's "2/10" convention. Already partially settled: only what is left can
  // still earn a discount.
  const discountBase = allocated > 0n ? outstanding : total;

  const term = await resolveDocumentTerm(ctx, {
    contactId: bufferToUuid(document.contact_id),
    documentTermId:
      document.payment_term_id === null ? undefined : bufferToUuid(document.payment_term_id),
  });
  if (term === null) return null;

  const computed = computePaymentTerm(term, document.issue_date, discountBase.toString());
  if (computed.discountAmountMinor === null || computed.discountDeadline === null) return null;

  // `calendarDateSchema` is fixed-width `YYYY-MM-DD` (`compute-term.ts`'s own
  // `addCalendarDays` relies on the same fact), so lexicographic comparison is
  // calendar-date comparison — no `Date` parsing, no timezone.
  if (asOfDate > computed.discountDeadline) return null;

  const accountId = await resolveDiscountAccount(
    db,
    input.targetType === 'invoice' ? 'given' : 'received',
  ).catch((error: unknown) => {
    // Nothing to post the confirmed discount to, so there is nothing to suggest
    // — the account nomination is `orgs.write` territory (D-107), not something
    // a suggestion preview can fix or work around.
    if (error instanceof PreconditionFailedError) return null;
    throw error;
  });
  if (accountId === null) return null;

  return {
    targetId: input.targetId,
    discountAmountMinor: computed.discountAmountMinor,
    deadline: computed.discountDeadline,
    accountId: bufferToUuid(accountId),
  };
}

async function loadDocument(
  db: TenantDatabase,
  targetType: 'invoice' | 'bill',
  id: Buffer,
): Promise<ArDocumentRow | ApDocumentRow> {
  if (targetType === 'invoice') {
    return assertFound(await selectArDocumentById(db, INVOICE_KIND, id), INVOICE_KIND.resource);
  }
  return assertFound(await selectApDocumentById(db, id, 'bill'), AP_DOCUMENT_RESOURCE.bill);
}
