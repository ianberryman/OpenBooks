import type {
  CreatePaymentTermRequest,
  PaymentTerm,
  UpdatePaymentTermRequest,
} from '@openbooks/shared-types';
import {
  createPaymentTermRequestSchema,
  updatePaymentTermRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import { bufferToUuid, tryUuidToBuffer } from '../../db';
import { assertFound, parseInput, ValidationError } from '../../errors';
import { requirePermission } from '../permissions';

import type { PaymentTermPatch, PaymentTermRow } from './terms.repository';
import {
  insertPaymentTerm,
  listPaymentTermRows,
  orgScope,
  PAYMENT_TERM_RESOURCE,
  paymentTermIdBytes,
  selectContactDefaultTermId,
  selectPaymentTermById,
  updatePaymentTermRow,
} from './terms.repository';

/**
 * The per-org payment-term list, and the contact-default-then-document-override
 * resolution every AR and AP create reads (OB-136; ROADMAP D-79, D-106, D-107,
 * D-108).
 *
 * Read `compute-term.ts` for the arithmetic a term does and `index.ts` for what
 * this module is not — OB-138's suggestion and OB-139's routes. `orgs.read`/
 * `orgs.write` gate every operation here (D-107): a term nomination is
 * settings-like in exactly the way the control-account nominations beside it in
 * `org_accounting_settings` are, and reuses the same two keys rather than
 * inventing a `payment_terms.*` pair nothing else in this org's role bundles
 * would carry.
 *
 * Three things are uniform across every write below, following
 * `control-accounts.ts`/`tax-rates.service.ts`:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed.
 * 2. **Every payload is parsed with the shared zod schema** — spec §12 puts an
 *    MCP tool and the workflow engine on this service with no schema in front of
 *    them.
 * 3. **A miss is `assertFound`** — `tenantDb` has already confined the read to
 *    this org, so a cross-org id and a nonexistent one reach the same line (A7).
 */

/**
 * Creates a term, active.
 *
 * No transaction: the one write this does is the insert itself, and
 * `uq_payment_terms_org_name` is the integrity guarantee — the pre-check a
 * transaction would buy nothing over, matching `createTaxRate`'s own reasoning.
 */
export async function createPaymentTerm(
  input: CreatePaymentTermRequest,
  ctx: RequestContext = getContext('createPaymentTerm()'),
): Promise<PaymentTerm> {
  await requirePermission(ctx, 'orgs.write');
  const request = parseInput(createPaymentTermRequestSchema, input);
  const author = requireAuthor(ctx);

  const row = await insertPaymentTerm(orgScope(ctx), {
    name: request.name,
    netDays: request.netDays,
    ...(request.discountRatePpm === undefined ? {} : { discountRatePpm: request.discountRatePpm }),
    ...(request.discountWindowDays === undefined
      ? {}
      : { discountWindowDays: request.discountWindowDays }),
    createdByUserId: author,
  });

  return toPaymentTerm(row);
}

export async function getPaymentTerm(
  paymentTermId: string,
  ctx: RequestContext = getContext('getPaymentTerm()'),
): Promise<PaymentTerm> {
  await requirePermission(ctx, 'orgs.read');

  const db = orgScope(ctx);
  const id = assertFound(paymentTermIdBytes(paymentTermId), PAYMENT_TERM_RESOURCE);
  return toPaymentTerm(assertFound(await selectPaymentTermById(db, id), PAYMENT_TERM_RESOURCE));
}

/**
 * Every term the org has defined, active ones first, by name (a picker list —
 * see `listPaymentTermRows`). `includeInactive` defaults to false: an archived
 * term stays on every document that used it and is never offered for a new one,
 * so the ordinary caller — a document's term picker — never wants it.
 */
export async function listPaymentTerms(
  includeInactive = false,
  ctx: RequestContext = getContext('listPaymentTerms()'),
): Promise<readonly PaymentTerm[]> {
  await requirePermission(ctx, 'orgs.read');

  const rows = await listPaymentTermRows(orgScope(ctx), includeInactive ? {} : { isActive: true });
  return rows.map(toPaymentTerm);
}

/**
 * Renames a term, or changes its net days or its discount, or both.
 *
 * The discount fields still pair on the way in — `updatePaymentTermRequestSchema`
 * refuses one without the other — and there is no path from here to *clearing*
 * an existing discount, for the reason that schema states: a term already
 * referenced by a document must not have its arithmetic change under it.
 * Retiring the discount is `deactivatePaymentTerm` plus a new, simple term.
 */
export async function updatePaymentTerm(
  paymentTermId: string,
  input: UpdatePaymentTermRequest,
  ctx: RequestContext = getContext('updatePaymentTerm()'),
): Promise<PaymentTerm> {
  await requirePermission(ctx, 'orgs.write');
  const request = parseInput(updatePaymentTermRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(paymentTermIdBytes(paymentTermId), PAYMENT_TERM_RESOURCE);
  assertFound(await selectPaymentTermById(db, id), PAYMENT_TERM_RESOURCE);

  const patch: PaymentTermPatch = {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.netDays === undefined ? {} : { netDays: request.netDays }),
    ...(request.discountRatePpm === undefined ? {} : { discountRatePpm: request.discountRatePpm }),
    ...(request.discountWindowDays === undefined
      ? {}
      : { discountWindowDays: request.discountWindowDays }),
  };

  await updatePaymentTermRow(db, id, patch);
  return toPaymentTerm(assertFound(await selectPaymentTermById(db, id), PAYMENT_TERM_RESOURCE));
}

/**
 * Archives a term. Not a delete: `fk_ar_documents_payment_term`/
 * `fk_ap_documents_payment_term`/`fk_contacts_default_payment_term` are all
 * `ON DELETE RESTRICT`, so a term any document or contact still names cannot be
 * removed regardless, and `is_active = 0` is the same "stop offering it, never
 * unpick it" shape `archiveTaxRate` and the control-account model both take.
 */
export async function deactivatePaymentTerm(
  paymentTermId: string,
  ctx: RequestContext = getContext('deactivatePaymentTerm()'),
): Promise<PaymentTerm> {
  await requirePermission(ctx, 'orgs.write');

  const db = orgScope(ctx);
  const id = assertFound(paymentTermIdBytes(paymentTermId), PAYMENT_TERM_RESOURCE);
  assertFound(await selectPaymentTermById(db, id), PAYMENT_TERM_RESOURCE);

  await updatePaymentTermRow(db, id, { isActive: false });
  return toPaymentTerm(assertFound(await selectPaymentTermById(db, id), PAYMENT_TERM_RESOURCE));
}

/**
 * Which term governs a document: the document's own override if one was
 * chosen, else the contact's default, else no term at all (D-108's
 * "contact-default-then-document-override").
 *
 * Called from `createArDocument`/`createBill` inside their own transaction —
 * `db` is not threaded through explicitly because `tenantDb()` joins whatever
 * transaction is already open in the async scope (`transaction-scope.ts`), so a
 * plain `ctx` here reaches the same connection and the same row locks its
 * caller holds, exactly as `resolveControlAccount(db, side)`'s callers rely on
 * for control accounts — the difference is only that this function is not
 * itself mid-transaction, so it takes `ctx` rather than `db`.
 *
 * A `documentTermId` that does not resolve to a term in this org is a 404 on
 * `payment_term` (A7) — a caller-supplied override is validated exactly as a
 * control-account nomination is. The contact's own default is trusted without
 * re-validation here: `fk_contacts_default_payment_term` guarantees it names a
 * real term in this org, and a term that has since been deactivated is still a
 * legitimate default to inherit — deactivating a term stops it being *offered*,
 * not the terms already resting on it (the same distinction `resolveTaxAccount`
 * draws between "does not exist" and "administratively retired").
 */
export async function resolveDocumentTerm(
  ctx: RequestContext,
  input: { readonly contactId: string; readonly documentTermId?: string | undefined },
): Promise<PaymentTerm | null> {
  const db = orgScope(ctx);

  if (input.documentTermId !== undefined) {
    const id = assertFound(paymentTermIdBytes(input.documentTermId), PAYMENT_TERM_RESOURCE);
    return toPaymentTerm(assertFound(await selectPaymentTermById(db, id), PAYMENT_TERM_RESOURCE));
  }

  const contactId = tryUuidToBuffer(input.contactId);
  const defaultTermId =
    contactId === undefined ? undefined : await selectContactDefaultTermId(db, contactId);
  if (defaultTermId === undefined || defaultTermId === null) return null;

  const row = await selectPaymentTermById(db, defaultTermId);
  // `fk_contacts_default_payment_term` guarantees this row exists; `undefined`
  // here would mean the reference and the table have gone out of sync, which is
  // a fault in this process rather than a case a caller can act on.
  if (row === undefined) {
    throw new ValidationError(
      `Contact ${input.contactId} names a default payment term that no longer exists.`,
    );
  }
  return toPaymentTerm(row);
}

function requireAuthor(ctx: RequestContext): Buffer {
  const userId =
    ctx.userId === null || ctx.userId === undefined ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    // `payment_terms.created_by_user_id` is NOT NULL and references `users` with
    // RESTRICT, matching `ar_documents`/`ap_documents`: who defined a term is
    // part of the record it becomes.
    throw new ValidationError('A payment term is created by a user.', [
      {
        path: 'actor',
        message: 'This caller has no user identity, so it cannot create a payment term.',
      },
    ]);
  }
  return userId;
}

function toPaymentTerm(row: PaymentTermRow): PaymentTerm {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    netDays: row.net_days,
    discountRatePpm: row.discount_rate_ppm,
    discountWindowDays: row.discount_window_days,
    isActive: row.is_active !== 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
