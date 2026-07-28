import { z } from 'zod';

import { documentTotalsSchema, quantitySchema } from '../subledger';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

import {
  ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH,
  ORG_BRANDING_CITY_MAX_LENGTH,
  ORG_BRANDING_COUNTRY_MAX_LENGTH,
  ORG_BRANDING_DISPLAY_NAME_MAX_LENGTH,
  ORG_BRANDING_EMAIL_MAX_LENGTH,
  ORG_BRANDING_FOOTER_MAX_LENGTH,
  ORG_BRANDING_POSTAL_CODE_MAX_LENGTH,
  ORG_BRANDING_REGION_MAX_LENGTH,
} from './branding';

/**
 * Invoice delivery — sending an invoice, and the page a customer opens (OB-123,
 * Phase 1). `branding.ts` holds the letterhead these are dressed with.
 *
 * Two audiences, and the split between them is the whole point of this file:
 *
 *  - **`sendInvoiceRequestSchema` / `invoiceDeliverySchema`** are the authenticated
 *    side — the org asks to send an invoice, and gets back a record of the send.
 *  - **`publicInvoiceViewSchema`** is what the hosted page renders to a customer who
 *    is *not* logged in, reached by a capability token in the URL. It therefore
 *    carries no internal identifiers — no `journalId`, no `contactId`, no `orgId` —
 *    because anything in it is readable by anyone holding the link.
 *
 * ## The capability-token format, and why the delivery row stores a hash
 *
 * The hosted page and its PDF are reached by an unguessable token embedded in the
 * URL — `/i/{token}` for the page, `/public/invoices/{token}/pdf` for the PDF. The
 * token is two parts joined by a dot:
 *
 * ```
 * {prefix}.{secret}
 * ```
 *
 * `prefix` is ~8 url-safe characters that identify the delivery row cheaply, and
 * `secret` is 32 random bytes encoded base64url. The server stores `key_prefix`
 * (the lookup handle) and `SHA-256(token)` (the verifier) on the delivery row, and
 * **never the token itself** — the same hashed-token pattern `sessions` and
 * `api_keys` use, so a database read cannot reconstruct a working link. The lookup
 * finds the row by prefix, then compares the SHA-256 of the presented token in
 * constant time. None of that surface — not the secret, not the hash, not the
 * prefix — appears on any schema here: `invoiceDeliverySchema` exposes the finished
 * `publicUrl` and nothing a holder of the database could replay.
 *
 * This documents the seam for the F2 (schema) and S3 (hosted page) streams: F2
 * provisions `key_prefix` and the token hash on the delivery row; S3 mints the token
 * and renders `publicInvoiceViewSchema`.
 *
 * ## No `.meta({ id })` yet
 *
 * The routes arrive later, and an id with no route publishes an unreachable
 * component — the sequence `documents.ts` describes. Ids land with the routes.
 */

/**
 * Trimmed before the format check — `emailSchema` in `contacts.ts` argues the pipe
 * order: the check registers first, so a pasted `' bob@acme.com '` is refused rather
 * than silently cleaned.
 */
const recipientEmailSchema = z.string().trim().pipe(z.email().max(ORG_BRANDING_EMAIL_MAX_LENGTH));

/**
 * Asks to send an invoice to its customer.
 *
 * `recipientEmail` is optional and overrides nothing when absent: the server sends
 * to the invoiced contact's own email, which is the ordinary case. The override
 * exists for the invoice that must go to an accounts-payable inbox rather than to
 * the contact on file, without editing the contact.
 */
export const sendInvoiceRequestSchema = z
  .strictObject({
    recipientEmail: recipientEmailSchema.optional(),
  })
  .meta({
    description:
      'Sends an invoice to its customer. `recipientEmail` overrides the destination for this one ' +
      'send; absent, the server uses the invoiced contact’s email.',
  });

export type SendInvoiceRequest = z.infer<typeof sendInvoiceRequestSchema>;

/**
 * Whether the send reached the provider.
 *
 * `sent` means the provider accepted it; `failed` means it did not. There is no
 * `delivered`/`opened` here — those are provider webhooks that arrive later and
 * belong on their own surface, not on the record of the send attempt.
 */
export const INVOICE_DELIVERY_STATUSES = ['sent', 'failed'] as const;

export type InvoiceDeliveryStatus = (typeof INVOICE_DELIVERY_STATUSES)[number];

export const invoiceDeliveryStatusSchema = z.enum(INVOICE_DELIVERY_STATUSES).meta({
  description:
    'Whether the provider accepted the send. `sent` on acceptance, `failed` otherwise. Not ' +
    'delivery confirmation — that is a later provider signal on its own surface.',
});

/**
 * The record of one send, as the API returns it.
 *
 * It names the invoice and where the mail went, and it carries the `publicUrl` the
 * customer was given — but **never the token secret or its hash**. The row the
 * server persists holds `key_prefix` and `SHA-256(token)` (see this file's header);
 * exposing either here would hand back the very thing the hash exists to keep out of
 * a database read.
 *
 * `artifactStorageKey` is the object-store key of the PDF snapshot taken at send
 * time — the invoice as it was sent, frozen, so a later edit to branding or a reissue
 * cannot rewrite history a customer already holds.
 */
export const invoiceDeliverySchema = z
  .strictObject({
    id: z.uuid(),
    invoiceId: z.uuid().meta({ description: 'The invoice that was sent.' }),
    recipientEmail: recipientEmailSchema.meta({
      description: 'Where this send went — the override if one was given, else the contact’s email.',
    }),
    sentAt: z.iso.datetime().meta({
      description: 'When the send was attempted.',
    }),
    artifactStorageKey: z.string().meta({
      description:
        'The object-store key of the PDF snapshot taken at send time — the invoice frozen as it ' +
        'was sent, so a later edit cannot rewrite what the customer received.',
    }),
    providerMessageId: z
      .string()
      .nullable()
      .meta({
        description:
          'The email provider’s own id for this message, when it accepted one. Null on a `failed` ' +
          'send, or before the provider has answered.',
      }),
    status: invoiceDeliveryStatusSchema,
    publicUrl: z.string().meta({
      description:
        'The `/i/{token}` link the customer was given, carrying the capability token. The token ' +
        'itself is stored only as a prefix and a hash (see the file header); this is the whole ' +
        'link as it was sent.',
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({
    description:
      'The record of one invoice send: which invoice, where it went, whether the provider took ' +
      'it, and the public link the customer received. Never the token secret or its hash.',
  });

export type InvoiceDelivery = z.infer<typeof invoiceDeliverySchema>;

/**
 * One invoice line as the hosted page renders it — the customer-safe subset.
 *
 * It is `documentLineSchema` with everything internal stripped: no `lineId`, no
 * `accountId`, no `taxRateId`, no `dimensionValueIds`. What is left is what prints on
 * an invoice — a description, how many, the unit price, and the three amounts the
 * arithmetic made of them, `netAmount + taxAmount === grossAmount` per line as
 * `documents.ts` guarantees.
 */
const publicInvoiceLineSchema = z
  .strictObject({
    description: z.string(),
    quantity: quantitySchema,
    unitAmount: minorUnitsSchema,
    netAmount: minorUnitsSchema,
    taxAmount: minorUnitsSchema,
    grossAmount: minorUnitsSchema,
  })
  .meta({ description: 'One invoice line, customer-safe: what it is, how many, and the money.' });

/**
 * One rate's share of the invoice, customer-safe — no `taxRateId`.
 *
 * `documentTaxSummaryRowSchema` groups by rate id because a filing needs it; the
 * customer reading a printed invoice needs the name, the percentage and the two
 * amounts, and the id is an internal handle a public page has no reason to leak.
 */
const publicTaxSummaryRowSchema = z
  .strictObject({
    taxRateName: z.string().nullable(),
    percentage: z.string().nullable(),
    net: minorUnitsSchema,
    tax: minorUnitsSchema,
  })
  .meta({ description: 'One tax rate’s net and tax on this invoice, as printed.' });

/**
 * The branding block the hosted page renders — the letterhead, customer-safe.
 *
 * It is `orgBrandingSchema` minus everything a public page should not carry: no
 * `logoStorageKey` (a `logoUrl` derived from it instead), no `createdAt`/`updatedAt`,
 * and only the fields that print at the head of an invoice. `displayName` is the one
 * field that is never null.
 */
const publicBrandingSchema = z
  .strictObject({
    displayName: z.string().max(ORG_BRANDING_DISPLAY_NAME_MAX_LENGTH),
    addressLine1: z.string().max(ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH).nullable(),
    addressLine2: z.string().max(ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH).nullable(),
    city: z.string().max(ORG_BRANDING_CITY_MAX_LENGTH).nullable(),
    region: z.string().max(ORG_BRANDING_REGION_MAX_LENGTH).nullable(),
    postalCode: z.string().max(ORG_BRANDING_POSTAL_CODE_MAX_LENGTH).nullable(),
    country: z.string().max(ORG_BRANDING_COUNTRY_MAX_LENGTH).nullable(),
    logoUrl: z
      .string()
      .nullable()
      .meta({
        description:
          'A URL for the org’s logo, derived from its stored key — never the key itself. Null when ' +
          'the org has uploaded no logo.',
      }),
    brandColor: z.string().nullable(),
    invoiceFooter: z.string().max(ORG_BRANDING_FOOTER_MAX_LENGTH).nullable(),
  })
  .meta({ description: 'The sender’s letterhead as the hosted page shows it, customer-safe.' });

/**
 * What the hosted invoice page renders, served **unauthenticated** to whoever holds
 * the link.
 *
 * Every internal identifier is absent by construction — no `journalId`, no
 * `contactId`, no `orgId`, no line or rate ids. `customerName` is a printed string,
 * not a reference to the contact row. This is the invoice a customer sees, and
 * nothing more: the amounts, who it is from, who it is to, and the two links (this
 * page, and `pdfUrl`) they can act on.
 */
export const publicInvoiceViewSchema = z
  .strictObject({
    documentNumber: z.string().meta({
      description: 'The org’s number for this invoice, as printed. A sent invoice is always numbered.',
    }),
    reference: z.string().nullable().meta({
      description: 'The customer’s own reference — their purchase-order number, when they gave one.',
    }),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema,
    lines: z.array(publicInvoiceLineSchema),
    totals: documentTotalsSchema,
    taxSummary: z.array(publicTaxSummaryRowSchema),
    memo: z.string().nullable(),
    customerName: z.string().meta({
      description: 'Who the invoice is addressed to, as a printed name — not a reference to a row.',
    }),
    branding: publicBrandingSchema,
    pdfUrl: z.string().meta({
      description:
        'The `/public/invoices/{token}/pdf` link, carrying the same capability token as this page.',
    }),
  })
  .meta({
    description:
      'The customer-safe invoice the hosted page renders, served unauthenticated to whoever holds ' +
      'the link. Carries no internal identifiers — no journal, contact or org id — only what ' +
      'prints on an invoice and the two links to act on it.',
  });

export type PublicInvoiceView = z.infer<typeof publicInvoiceViewSchema>;
