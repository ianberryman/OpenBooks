import { z } from 'zod';

import { CONTACT_EMAIL_MAX_LENGTH } from '../contacts';

/**
 * Predocument delivery — sending a purchase order to its vendor, or an estimate to
 * its customer (initiative M, OB-177; ROADMAP D-M5).
 *
 * **D-M5: v1 send is lean, by decision.** It emails the counterparty an HTML
 * summary through the same `outboundEmail()` seam `sendInvoice` uses
 * (`delivery/delivery.ts`) and records an append-only `predocument_deliveries` row
 * — nothing else. The token-gated hosted page and the themed PDF snapshot
 * `invoiceDeliverySchema` carries (`publicUrl`, `artifactStorageKey`) are DEFERRED
 * follow-ups, flagged in ROADMAP: there is no rendered artifact and no capability
 * token here, which is why this schema is shorter than its AR cousin rather than
 * an oversight against it.
 *
 * `documentKind` is what tells the two pre-documents apart on one shared table
 * (`predocument_deliveries`, `0015_procure_to_pay`) — the polymorphic mirror of
 * `document_type` on `ar_documents`/`ap_documents`, except `document_id` carries no
 * foreign key (D-M3's header on the migration explains why MySQL cannot enforce
 * one across two possible parent tables).
 */

/**
 * Trimmed before the format check, `invoiceDeliverySchema`'s own
 * `recipientEmailSchema`'s reason: the check registers first, so a pasted
 * `' bob@acme.com '` is refused rather than silently cleaned. The max length
 * matches `contacts.email` (`CONTACT_EMAIL_MAX_LENGTH`) and `recipient_email
 * VARCHAR(320)` on `predocument_deliveries` alike.
 */
const recipientEmailSchema = z.string().trim().pipe(z.email().max(CONTACT_EMAIL_MAX_LENGTH));

/**
 * Asks to send a purchase order to its vendor, or an estimate to its customer.
 *
 * `recipientEmail` is optional (and nullable, so an explicit `null` reads the same
 * as omitting it) and overrides nothing when absent: the server sends to the
 * document's own contact — the vendor on a PO, the customer on an estimate — which
 * is the ordinary case. The override exists for the one send that must go
 * somewhere else without editing the contact.
 */
export const sendPredocumentRequestSchema = z
  .strictObject({
    recipientEmail: recipientEmailSchema.nullish(),
  })
  .meta({
    id: 'SendPredocumentRequest',
    description:
      'Sends a purchase order to its vendor, or an estimate to its customer. `recipientEmail` ' +
      'overrides the destination for this one send; absent or null, the server uses the ' +
      'document’s own contact email.',
  });

export type SendPredocumentRequest = z.infer<typeof sendPredocumentRequestSchema>;

/** Which pre-document a delivery row describes (`predocument_deliveries.document_kind`). */
export const PREDOCUMENT_KINDS = ['purchase_order', 'estimate'] as const;

export type PredocumentKind = (typeof PREDOCUMENT_KINDS)[number];

const predocumentKindSchema = z.enum(PREDOCUMENT_KINDS).meta({
  description: 'Which pre-document this delivery is for: a purchase order or an estimate.',
});

/**
 * Whether the send reached the provider. The same two states
 * `invoiceDeliveryStatusSchema` carries, for the same reason: `sent` means the
 * provider accepted it, `failed` means it did not, and there is no
 * `delivered`/`opened` here — that would be a provider webhook on its own surface,
 * not this record of the attempt.
 */
export const PREDOCUMENT_DELIVERY_STATUSES = ['sent', 'failed'] as const;

export type PredocumentDeliveryStatus = (typeof PREDOCUMENT_DELIVERY_STATUSES)[number];

const predocumentDeliveryStatusSchema = z.enum(PREDOCUMENT_DELIVERY_STATUSES).meta({
  description:
    'Whether the provider accepted the send. `sent` on acceptance, `failed` otherwise. Not ' +
    'delivery confirmation.',
});

/**
 * The record of one send, as the API returns it.
 *
 * Deliberately narrower than `invoiceDeliverySchema` (D-M5): no `artifactStorageKey`
 * — nothing was rendered or retained — and no `publicUrl` — nothing was minted for
 * a customer to open. What is left is exactly what a lean send attests to: which
 * document, where it went, and whether the provider took it.
 */
export const predocumentDeliverySchema = z
  .strictObject({
    id: z.uuid(),
    documentKind: predocumentKindSchema,
    documentId: z.uuid().meta({
      description: 'The purchase order or estimate that was sent.',
    }),
    recipientEmail: recipientEmailSchema.meta({
      description:
        'Where this send went — the override if one was given, else the document’s own ' +
        'contact email.',
    }),
    status: predocumentDeliveryStatusSchema,
    providerMessageId: z
      .string()
      .nullable()
      .meta({
        description:
          'The email provider’s own id for this message, when it accepted one. Null on a ' +
          '`failed` send, or when the provider returns none.',
      }),
    sentAt: z.iso.datetime().meta({
      description: 'When the send was attempted.',
    }),
  })
  .meta({
    id: 'PredocumentDelivery',
    description:
      'The record of one predocument send: which purchase order or estimate, where it went, and ' +
      'whether the provider took it. No rendered artifact and no hosted-page link (D-M5, lean ' +
      'v1) — those are deferred follow-ups.',
  });

export type PredocumentDelivery = z.infer<typeof predocumentDeliverySchema>;
