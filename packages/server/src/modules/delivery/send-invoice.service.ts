import type { InvoiceDelivery, SendInvoiceRequest } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { newUuid, orgScope as toOrgId, tenantDb, uuidToBuffer } from '../../db';
import { assertFound, InternalError, NotFoundError, PreconditionFailedError } from '../../errors';
import { outboundEmail, storageProvider } from '../../providers';
import { selectContactById } from '../contacts/contacts.repository';
import { documentIdBytes, selectDocumentById } from '../invoices/ar-documents.repository';
import { INVOICE_KIND } from '../invoices/kinds';
import { requirePermission } from '../permissions';

import { insertDelivery } from './delivery.repository';
import { buildInvoiceView, selectLogoStorageKey } from './public-invoice.service';
import { createInvoiceRenderer } from './renderer';
import { mintDeliveryToken } from './token';

/**
 * `sendInvoice` (OB-126, Phase 1) — the convergence of the delivery streams.
 *
 * It renders an approved invoice to a themed PDF (S2), retains that PDF in the
 * object store (F3), mints a capability token (S3), records the send as an immutable
 * `invoice_deliveries` row (F2), and emails the customer a link to the hosted page.
 * Everything above it — the letterhead, the customer-safe projection, the token — is
 * assembled from the pieces those streams built; this is the one place they meet.
 *
 * ## The order, and why the failure of the send is a row rather than a throw
 *
 * A delivery attests that an artifact went to an address at a time. So the artifact
 * is rendered and stored, and the token minted, *before* the mail is attempted; then
 * whether the provider accepts the message decides only the `status` the row is
 * written with. A provider rejection is a `status = 'failed'` row and a 200 whose
 * body says `failed` — not a 5xx — because the send genuinely happened and its
 * outcome is data the caller asked for (`invoiceDeliverySchema` carries `status`).
 * A retry is a new send: a new token, a new artifact, a new row (the table is
 * append-only, `0007_invoice_delivery`). Idempotency of the *HTTP* call is the
 * transport's key, not this row's.
 *
 * The provider gives us no message id (`EmailProvider.send` returns `void`), so
 * `providerMessageId` is `null` until a later provider-webhook surface fills it —
 * exactly what `invoiceDeliverySchema` documents.
 */
export async function sendInvoice(
  invoiceId: string,
  request: SendInvoiceRequest,
  ctx: RequestContext = getContext('sendInvoice()'),
): Promise<InvoiceDelivery> {
  await requirePermission(ctx, 'invoices.send');

  const idBytes = documentIdBytes(invoiceId);
  // A malformed id, a cross-org one, and a nonexistent one are one indistinguishable
  // miss (A7): the shape check here and the zero-row check below both raise the single
  // `NotFoundError('invoice')`.
  if (idBytes === undefined) throw new NotFoundError(INVOICE_KIND.resource);

  const orgId = toOrgId(ctx.orgId);
  const db = tenantDb(orgId);

  const invoice = assertFound(
    await selectDocumentById(db, INVOICE_KIND, idBytes),
    INVOICE_KIND.resource,
  );

  // `sequence_number IS NULL` is a draft (D-38): it holds no number, so there is
  // nothing numbered to send, and `chk_ar_documents_approved` ties the number to the
  // journal. A voided invoice is settled history a customer should not be re-sent.
  if (invoice.sequence_number === null) {
    throw new PreconditionFailedError(
      'invoice.not_approved',
      'An invoice must be approved before it can be sent.',
    );
  }
  if (invoice.void_journal_id !== null) {
    throw new PreconditionFailedError('invoice.voided', 'A voided invoice cannot be sent.');
  }

  const contact = await selectContactById(db, invoice.contact_id);
  if (contact === undefined) {
    throw new InternalError(
      'An invoice names a contact that could not be read; fk_ar_documents_contact should make ' +
        'that impossible.',
    );
  }

  // The override goes to a named inbox for this one send; absent, the invoiced
  // contact's own address. An invoice whose contact has no email and no override has
  // nowhere to go — a precondition on sending, not a validation of the request body.
  const recipient = request.recipientEmail ?? contact.email;
  if (recipient === null) {
    throw new PreconditionFailedError(
      'invoice.no_recipient',
      'This invoice has no recipient: its customer has no email on file and none was supplied.',
    );
  }

  const deliveryUuid = newUuid();
  const deliveryId = uuidToBuffer(deliveryUuid);
  const minted = mintDeliveryToken();

  // The same customer-safe view the hosted page will serve for this token, rendered
  // to the PDF now so the two are one document. Non-null: the invoice was just loaded.
  const view = await buildInvoiceView(db, orgId, idBytes, minted.token);
  if (view === null) {
    throw new InternalError('The invoice vanished between validation and render.');
  }

  const logoKey = await selectLogoStorageKey(db);
  const logo = logoKey === null ? undefined : await storageProvider().get(logoKey);
  const pdf = await createInvoiceRenderer().render(logo === undefined ? { view } : { view, logo });

  const artifactStorageKey = `org/${ctx.orgId}/deliveries/${deliveryUuid}.pdf`;
  await storageProvider().put(artifactStorageKey, pdf, 'application/pdf');

  const { provider, logger, appBaseUrl } = outboundEmail();
  // `APP_BASE_URL` absent → a path, per `providers/index.ts`: the server cannot infer
  // its own public origin, and a path is still a working link once one is configured.
  const publicUrl = `${appBaseUrl ?? ''}/i/${minted.token}`;

  const status = await deliver(provider, {
    to: recipient,
    documentNumber: view.documentNumber,
    from: view.branding.displayName,
    publicUrl,
  }).catch((error: unknown) => {
    logger.error(
      { err: error, invoiceId, deliveryId: deliveryUuid },
      'Invoice delivery email was rejected by the provider.',
    );
    return 'failed' as const;
  });

  const { sentAt, createdAt } = await insertDelivery(db, {
    id: deliveryId,
    invoiceId: idBytes,
    recipientEmail: recipient,
    artifactStorageKey,
    keyPrefix: minted.keyPrefix,
    tokenHash: minted.tokenHash,
    providerMessageId: null,
    status,
  });

  return {
    id: deliveryUuid,
    invoiceId,
    recipientEmail: recipient,
    sentAt: sentAt.toISOString(),
    artifactStorageKey,
    providerMessageId: null,
    status,
    publicUrl,
    createdAt: createdAt.toISOString(),
  };
}

interface DeliveryEmail {
  readonly to: string;
  readonly documentNumber: string;
  readonly from: string;
  readonly publicUrl: string;
}

/**
 * Hands the message to the provider and reports whether it took it. A thrown
 * rejection is turned into `'failed'` by the caller; a clean return is `'sent'`.
 */
async function deliver(
  provider: ReturnType<typeof outboundEmail>['provider'],
  email: DeliveryEmail,
): Promise<'sent'> {
  const subject = `Invoice ${email.documentNumber} from ${email.from}`;
  const text =
    `${email.from} has sent you invoice ${email.documentNumber}.\n\n` +
    `View and download it here: ${email.publicUrl}\n`;
  const html =
    `<p>${email.from} has sent you invoice ${email.documentNumber}.</p>` +
    `<p><a href="${email.publicUrl}">View and download your invoice</a></p>`;

  await provider.send({ to: email.to, subject, text, html });
  return 'sent';
}
