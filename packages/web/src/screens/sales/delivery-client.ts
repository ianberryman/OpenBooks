import { thinRequest } from '../../lib/thin-client';

/**
 * Sending an invoice (OB-131, Phase 1, S4) — `POST /v1/invoices/{invoiceId}/send`.
 *
 * **Mocked**, for the reason `../settings/branding-client.ts` gives: this route is
 * authored in the S5 stream in parallel with this one and is not in `schema.d.ts` yet.
 * `SendInvoiceRequest` and `InvoiceDelivery` are hand-mirrored from
 * `packages/shared-types/src/delivery/delivery.ts`'s `sendInvoiceRequestSchema` and
 * `invoiceDeliverySchema`. **The one-line swap once F2/S5 land:** delete this file,
 * replace `sendInvoice`'s call site in `document-view.tsx` with
 * `unwrap(await api.POST('/v1/invoices/{invoiceId}/send', ...))`, and import the two
 * types from `../../api` instead of from here.
 */

export const INVOICE_DELIVERY_STATUSES = ['sent', 'failed'] as const;
export type InvoiceDeliveryStatus = (typeof INVOICE_DELIVERY_STATUSES)[number];

export interface InvoiceDelivery {
  readonly id: string;
  readonly invoiceId: string;
  readonly recipientEmail: string;
  readonly sentAt: string;
  readonly artifactStorageKey: string;
  readonly providerMessageId: string | null;
  readonly status: InvoiceDeliveryStatus;
  readonly publicUrl: string;
  readonly createdAt: string;
}

/**
 * `recipientEmail` absent means "send to the invoiced contact's own email" — the ordinary
 * case (`sendInvoiceRequestSchema`'s doc comment) — so an empty override typed and then
 * cleared must not become `recipientEmail: ''` on the wire.
 */
export interface SendInvoiceRequest {
  readonly recipientEmail?: string;
}

export async function sendInvoice(
  invoiceId: string,
  body: SendInvoiceRequest,
  idempotencyKey: string,
): Promise<InvoiceDelivery> {
  return thinRequest<InvoiceDelivery>(`/v1/invoices/${invoiceId}/send`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}
