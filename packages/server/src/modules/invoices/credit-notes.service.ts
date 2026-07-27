import type {
  CreateCreditNoteRequest,
  CreditNote,
  CreditNotePage,
  ListCreditNotesQuery,
  UpdateCreditNoteRequest,
  VoidDocumentRequest,
} from '@openbooks/shared-types';
import {
  createCreditNoteRequestSchema,
  listCreditNotesQuerySchema,
  updateCreditNoteRequestSchema,
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
import { CREDIT_NOTE_KIND as KIND } from './kinds';
import { toCreditNote, toCreditNoteSummary } from './projection';

/**
 * Credit notes (OB-062; ROADMAP D-39).
 *
 * A credit note is a **document, not a negative invoice**. It has its own gapless
 * series, posts its own journal, and reduces what a customer owes by *allocating*
 * against invoices through the same mechanism payments use — so "what is
 * outstanding" has one definition regardless of what reduced it.
 *
 * Modelling it as an invoice with negative lines would be less code and worse books:
 * aging would need to special-case the sign, a credit note could accidentally be
 * paid, and the document the customer receives would be an invoice claiming they owe
 * minus two hundred. Its lines are positive, like an invoice's, and the direction is
 * carried by `CREDIT_NOTE_KIND.controlSide` — one field, in one place.
 *
 * `settlement.outstanding` therefore reads as "credit still available to apply"
 * rather than "still owed", and `status: 'paid'` reads as "fully applied". One
 * arithmetic, two readings.
 *
 * It has no due date: nothing about a credit note falls due, and aging never ages
 * one. Everything else — the draft lifecycle, the pricing, the approval transaction,
 * the void — is `ar-documents.service.ts`'s, unchanged.
 */

export async function createCreditNote(
  input: CreateCreditNoteRequest,
  ctx: RequestContext = getContext('createCreditNote()'),
): Promise<CreditNote> {
  await requirePermission(ctx, KIND.writePermission);
  const request = parseInput(createCreditNoteRequestSchema, input);

  return toCreditNote(await createArDocument(KIND, request, ctx));
}

export async function getCreditNote(
  creditNoteId: string,
  ctx: RequestContext = getContext('getCreditNote()'),
): Promise<CreditNote> {
  return toCreditNote(await getArDocument(KIND, creditNoteId, ctx));
}

/**
 * One page of the org's credit notes, oldest first (D-21).
 *
 * `unappliedOnly` is the filter the "apply a credit" screen is built from: the
 * credit notes with something left on them, which is `settlement.outstanding` being
 * non-zero — computed, like everything else about settlement (D-34).
 */
export async function listCreditNotes(
  query: ListCreditNotesQuery,
  ctx: RequestContext = getContext('listCreditNotes()'),
): Promise<CreditNotePage> {
  await requirePermission(ctx, KIND.readPermission);
  const request = parseInput(listCreditNotesQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const filters: DocumentFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.contactId === undefined ? {} : { contactId: tryUuidToBuffer(request.contactId) }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.unappliedOnly === undefined ? {} : { unappliedOnly: request.unappliedOnly }),
  };

  const page = await listArDocuments(KIND, filters, limit, ctx);
  return { items: page.rows.map(toCreditNoteSummary), nextCursor: page.nextCursor };
}

export async function updateCreditNote(
  creditNoteId: string,
  input: UpdateCreditNoteRequest,
  ctx: RequestContext = getContext('updateCreditNote()'),
): Promise<CreditNote> {
  await requirePermission(ctx, KIND.writePermission);
  const request = parseInput(updateCreditNoteRequestSchema, input);

  return toCreditNote(await updateArDocument(KIND, creditNoteId, request, ctx));
}

export async function discardCreditNote(
  creditNoteId: string,
  ctx: RequestContext = getContext('discardCreditNote()'),
): Promise<void> {
  await discardArDocument(KIND, creditNoteId, ctx);
}

/**
 * Approves a draft credit note: allocates its number and posts its journal.
 *
 * The exact mirror of an invoice's approval — the receivables control account is
 * credited and the income and tax accounts debited — because `addTax` and
 * `extractTax` are symmetric about zero, so a credit note for the same lines as an
 * invoice posts the same amounts the other way round.
 */
export async function approveCreditNote(
  creditNoteId: string,
  ctx: RequestContext = getContext('approveCreditNote()'),
): Promise<CreditNote> {
  return toCreditNote(await approveArDocument(KIND, creditNoteId, ctx));
}

/** Voids an approved credit note by reversing its journal (D-16, D-38). */
export async function voidCreditNote(
  creditNoteId: string,
  input: VoidDocumentRequest,
  ctx: RequestContext = getContext('voidCreditNote()'),
): Promise<CreditNote> {
  await requirePermission(ctx, KIND.voidPermission);
  const request = parseInput(voidDocumentRequestSchema, input);

  return toCreditNote(await voidArDocument(KIND, creditNoteId, request, ctx));
}
