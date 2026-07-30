import type { PredocumentDelivery, SendPredocumentRequest } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { newUuid, orgScope as toOrgId, tenantDb, tryUuidToBuffer, uuidToBuffer } from '../../db';
import type { TenantDatabase } from '../../db';
import { assertFound, NotFoundError, PreconditionFailedError, ValidationError } from '../../errors';
import { outboundEmail } from '../../providers';
import { requirePermission } from '../permissions';

import {
  insertPredocumentDelivery,
  selectEstimateForSend,
  selectPurchaseOrderForSend,
} from './predocument-delivery.repository';
import type { PredocumentKind, PredocumentSendRow } from './predocument-delivery.repository';

/**
 * `sendPurchaseOrder` / `sendEstimate` (initiative M, OB-177) — emailing a
 * pre-document to its counterparty.
 *
 * ## D-M5: this is the LEAN send, and the gap is deliberate
 *
 * Unlike `sendInvoice` (`modules/delivery/send-invoice.service.ts`), this send
 * mints **no capability token**, renders **no PDF**, and retains **no artifact** —
 * there is no hosted page for a purchase order or an estimate to open in v1. What
 * it does is exactly two things: email the counterparty an HTML summary through
 * the same `outboundEmail()` seam `sendInvoice` uses, and record the attempt as an
 * append-only `predocument_deliveries` row. The token-gated hosted page and a
 * themed PDF (reusing INV's delivery stack: `renderer/`, `token.ts`,
 * `public-invoice.service.ts`) are DEFERRED follow-ups (ROADMAP D-M5) — flagged
 * here rather than half-built, because a hosted page with no token is not a
 * smaller version of one, it is a different feature.
 *
 * ## Why a provider rejection is a `status: 'failed'` row and not a throw
 *
 * Exactly `sendInvoice`'s reasoning: a delivery attests that a document went to an
 * address at a time, so whether the provider accepted it is data the row carries,
 * not an exception the caller has to catch. A retry is a new send — a new row —
 * because the table is append-only (`0015_procure_to_pay`).
 *
 * ## Why POs and estimates share one function body
 *
 * The two differ only in which table holds the document, which permission gates
 * it, and the label an email prints — `purchase-orders.ts`/`estimates.ts`'s own
 * reason for being spelled out separately does not apply here, because nothing
 * about *sending* is a lifecycle decision worth restating twice. `sendPredocument`
 * takes the two points of difference — the table's select and the printed label's
 * kind — as parameters; `sendPurchaseOrder` and `sendEstimate` are the two callers
 * that fix them. The `requirePermission` call stays in those two callers with a
 * literal key rather than being threaded through here, because the permission
 * matrix's enforcement-point scanner reads literals, not a variable passed in.
 */

/** The label an email and its refusal messages print for each kind. */
const KIND_LABEL: Record<PredocumentKind, string> = {
  purchase_order: 'Purchase order',
  estimate: 'Estimate',
};

async function sendPredocument(
  kind: PredocumentKind,
  select: (db: TenantDatabase, id: Buffer) => Promise<PredocumentSendRow | undefined>,
  documentId: string,
  input: SendPredocumentRequest,
  ctx: RequestContext,
): Promise<PredocumentDelivery> {
  const label = KIND_LABEL[kind];

  // A malformed id and a nonexistent one are one indistinguishable miss (A7): the
  // shape check here and the zero-row check below both raise the single
  // `NotFoundError(kind)`.
  const idBytes = tryUuidToBuffer(documentId);
  if (idBytes === undefined) throw new NotFoundError(kind);

  const orgId = toOrgId(ctx.orgId);
  const db = tenantDb(orgId);

  const row = assertFound(await select(db, idBytes), kind);

  // `sequence_number IS NULL` is a draft (D-M6): it holds no number, so there is
  // nothing numbered to send. `chk_*_approved` ties the number to `approved_at`.
  if (row.sequenceNumber === null) {
    throw new PreconditionFailedError(
      `${kind}_not_approved`,
      `A ${label.toLowerCase()} must be approved before it can be sent.`,
    );
  }

  // The override goes to a named inbox for this one send; absent (or explicitly
  // null), the document's own contact — the vendor on a PO, the customer on an
  // estimate. A document whose contact has no email and no override has nowhere
  // to go — a precondition on sending, not a validation of the request body.
  const recipient = input.recipientEmail ?? row.contactEmail;
  if (recipient === null || recipient === undefined) {
    throw new PreconditionFailedError(
      'no_recipient',
      `This ${label.toLowerCase()} has no recipient: its contact has no email on file and none ` +
        'was supplied.',
    );
  }

  const author = requireAuthor(ctx);

  const { provider, logger } = outboundEmail();
  const status = await deliver(provider, {
    to: recipient,
    label,
    documentNumber: row.sequenceNumber.toString(),
    contactName: row.contactDisplayName,
    reference: row.reference,
  }).catch((error: unknown) => {
    logger.error(
      { err: error, documentId, documentKind: kind },
      'Predocument delivery email was rejected by the provider.',
    );
    return 'failed' as const;
  });

  const deliveryUuid = newUuid();
  const deliveryId = uuidToBuffer(deliveryUuid);

  const { sentAt } = await insertPredocumentDelivery(db, {
    id: deliveryId,
    documentKind: kind,
    documentId: idBytes,
    recipientEmail: recipient,
    status,
    providerMessageId: null,
    createdByUserId: author,
  });

  return {
    id: deliveryUuid,
    documentKind: kind,
    documentId,
    recipientEmail: recipient,
    status,
    providerMessageId: null,
    sentAt: sentAt.toISOString(),
  };
}

/** Sends an approved purchase order to its vendor. Requires `purchase_orders.write`. */
export async function sendPurchaseOrder(
  purchaseOrderId: string,
  input: SendPredocumentRequest,
  ctx: RequestContext = getContext('sendPurchaseOrder()'),
): Promise<PredocumentDelivery> {
  await requirePermission(ctx, 'purchase_orders.write');
  return sendPredocument('purchase_order', selectPurchaseOrderForSend, purchaseOrderId, input, ctx);
}

/** Sends an approved estimate to its customer. Requires `estimates.write`. */
export async function sendEstimate(
  estimateId: string,
  input: SendPredocumentRequest,
  ctx: RequestContext = getContext('sendEstimate()'),
): Promise<PredocumentDelivery> {
  await requirePermission(ctx, 'estimates.write');
  return sendPredocument('estimate', selectEstimateForSend, estimateId, input, ctx);
}

interface PredocumentEmail {
  readonly to: string;
  readonly label: string;
  readonly documentNumber: string;
  readonly contactName: string;
  readonly reference: string | null;
}

/**
 * Hands the message to the provider and reports whether it took it. A thrown
 * rejection is turned into `'failed'` by the caller; a clean return is `'sent'`.
 * Mirrors `send-invoice.service.ts`'s own `deliver`, minus the public link — there
 * is nothing hosted to point at (D-M5).
 */
async function deliver(
  provider: ReturnType<typeof outboundEmail>['provider'],
  email: PredocumentEmail,
): Promise<'sent'> {
  const subject = `${email.label} ${email.documentNumber}`;
  const referenceLine =
    email.reference === null ? '' : ` Your reference on file: ${email.reference}.`;
  const text =
    `${email.label} ${email.documentNumber}, addressed to ${email.contactName}.` +
    `${referenceLine}\n`;
  const html =
    `<p>${email.label} ${email.documentNumber}, addressed to ${email.contactName}.` +
    `${referenceLine}</p>`;

  await provider.send({ to: email.to, subject, text, html });
  return 'sent';
}

/**
 * The user who authored this send, for `predocument_deliveries.created_by_user_id`
 * (NOT NULL, `0015_procure_to_pay`). Mirrors `ap-documents.service.ts`'s own
 * `requireAuthor` rather than importing it — that function lives in the bills
 * module's internal file, not its barrel, and this module does not reach into
 * another module's internals for one three-line check.
 */
function requireAuthor(ctx: RequestContext): Buffer {
  const userId =
    ctx.userId === null || ctx.userId === undefined ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A predocument delivery is authored by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot send a purchase order or estimate.',
      },
    ]);
  }
  return userId;
}
