import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageQueryShape } from '../wire';

import { allocationInputSchema, allocationSchema } from './allocations';
import {
  documentDateRangeShape,
  documentMemoSchema,
  documentReferenceSchema,
  documentSettlementSchema,
  isOrderedRange,
  unpublishedPageSchema,
} from './documents';

/**
 * Payments (OB-061, for OB-064; ROADMAP D-37).
 *
 * ## A payment is an amount that moved, and nothing about which document it settles
 *
 * D-37 is the decision this whole file is shaped by: "a payment records money
 * moving; allocations record which documents it settles. Nothing requires them to
 * be equal at the moment the payment is recorded." So `amount` is required,
 * `allocations` is optional, and an unallocated remainder is a **credit balance on
 * the contact** that can be applied later.
 *
 * This models what happens rather than what would be tidy: a deposit arrives before
 * anyone has decided what it settles, a customer rounds up, one transfer pays three
 * invoices. Requiring a payment to apply in full would make all three unrecordable,
 * and the workaround people reach for — a suspense journal posted by hand — is
 * exactly the un-auditable move a subledger exists to replace.
 *
 * The asymmetry that follows, and it is deliberate: **over-allocating a document is
 * refused** (C3) while **over-paying is fine**. Allocations against one invoice may
 * not exceed it; a payment larger than everything it settles simply leaves credit.
 *
 * ## A payment is not a numbered document
 *
 * D-36 gives gapless sequences to the four document types and to nothing else. A
 * payment carries a free-text `reference` — the bank's transaction reference, the
 * cheque number — and no sequence, because nobody cites a payment by our number and
 * a gap in a series nobody reads is a constraint bought for nothing.
 */

/**
 * Which way the money went.
 *
 * One resource with a direction rather than "receipts" and "disbursements",
 * because everything else about them is identical — the same allocation mechanism,
 * the same void, the same credit-on-the-contact behaviour — and two resources would
 * duplicate all of it to express one bit. The direction decides which control
 * account the journal touches and which documents the payment may settle: a
 * `received` payment settles invoices, a `made` payment settles bills.
 */
export const PAYMENT_DIRECTIONS = ['received', 'made'] as const;

export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const paymentDirectionSchema = z.enum(PAYMENT_DIRECTIONS).meta({
  description:
    'Whether the money came in or went out. `received` settles invoices and credits the ' +
    'receivables control account; `made` settles bills.',
});

/**
 * A payment's state, computed rather than stored, like a document's (D-38).
 *
 * Only two values, and the absence of the middle ones is the point: how much of a
 * payment has been applied is `settlement`, which is a pair of amounts rather than
 * a label. A `part_allocated` status would be a second, lossier encoding of the
 * same fact, and the first thing to disagree with it would be the number beside it.
 */
export const PAYMENT_STATUSES = ['recorded', 'void'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES).meta({
  description:
    'Computed, never stored: `void` once a reversing journal exists, `recorded` otherwise. How ' +
    'much has been applied is `settlement`, not a status.',
});

const paymentAmountSchema = minorUnitsSchema.meta({
  description:
    'How much money moved, in minor units. Positive — the direction carries the sign, exactly as ' +
    'a journal line’s side does. Refunding a payment is a payment in the other direction, not a ' +
    'negative one.',
});

/**
 * A payment as the API returns it.
 *
 * `settlement.outstanding` here reads as "unallocated credit still available",
 * which is the same arithmetic as an invoice's "still owed" (D-34,
 * `documentSettlementSchema`) — one definition, four readings.
 */
export const paymentSchema = z.strictObject({
  id: z.uuid(),
  direction: paymentDirectionSchema,
  contactId: z.uuid().meta({
    description:
      'Whose payment this is. Required even when nothing is allocated, because an unapplied ' +
      'payment is a credit balance *on a contact* (D-37) — a payment belonging to nobody could ' +
      'never be found again.',
  }),
  date: calendarDateSchema.meta({
    description:
      'The date the money moved, and the entry date of the journal it posts. It must fall in an ' +
      'open fiscal period (D-17).',
  }),
  amount: paymentAmountSchema,
  accountId: z.uuid().meta({
    description:
      'The bank or cash account the money moved through. Named per payment rather than taken ' +
      'from an org default, because a business with two accounts needs to say which one, and a ' +
      'default that is silently wrong is a reconciliation nobody can close.',
  }),
  reference: z
    .string()
    .nullable()
    .meta({
      description:
        'The bank’s reference, the cheque number, whatever identifies this movement on a ' +
        'statement. A payment has no gapless sequence of its own (D-36 numbers documents).',
    }),
  memo: z.string().nullable(),
  status: paymentStatusSchema,
  settlement: documentSettlementSchema.meta({
    description:
      'How much of this payment has been applied, and how much is still available as credit on ' +
      'the contact. Computed from the allocations, never stored (D-34, D-37).',
  }),
  allocations: z.array(allocationSchema),
  journalId: z.uuid().meta({
    description:
      'The journal this payment posted. Unlike a document, a payment has no draft state — money ' +
      'either moved or it did not — so this is never null.',
  }),
  voidJournalId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Payment = z.infer<typeof paymentSchema>;

export const paymentSummarySchema = z.strictObject({
  id: z.uuid(),
  direction: paymentDirectionSchema,
  contactId: z.uuid(),
  date: calendarDateSchema,
  amount: paymentAmountSchema,
  accountId: z.uuid(),
  reference: z.string().nullable(),
  status: paymentStatusSchema,
  settlement: documentSettlementSchema,
  createdAt: z.iso.datetime(),
});

export type PaymentSummary = z.infer<typeof paymentSummarySchema>;

/**
 * Records a payment, optionally applying it in the same call.
 *
 * `allocations` is optional and may be short of the amount, which is D-37 in the
 * request shape. Allowing it here rather than forcing a second call is what makes
 * the ordinary case — one payment settling one invoice — a single idempotent write:
 * two calls would leave a window in which the money is recorded and unapplied, and
 * a client that failed between them would have created the very orphan credit that
 * makes people distrust the feature.
 *
 * There is no `journal` field and no actor. Provenance comes from the resolved
 * session (`journals.ts` argues why at length), and the journal is the service's to
 * post.
 */
export const createPaymentRequestSchema = z.strictObject({
  direction: paymentDirectionSchema,
  contactId: z.uuid(),
  date: calendarDateSchema,
  amount: paymentAmountSchema,
  accountId: z.uuid(),
  reference: documentReferenceSchema.nullish(),
  memo: documentMemoSchema.nullish(),
  allocations: z.array(allocationInputSchema).optional(),
});

export type CreatePaymentRequest = z.infer<typeof createPaymentRequestSchema>;

/**
 * The header fields, and nothing that would restate the ledger.
 *
 * `amount`, `date`, `accountId` and `direction` are all absent: each of them is a
 * fact the posted journal carries, and a journal is never edited (spec §2.2, D-16).
 * A payment recorded for the wrong amount is voided and recorded again, which is
 * the same answer D-38 gives for a document approved in error. What is left is the
 * text a human wrote about it.
 */
export const updatePaymentRequestSchema = z
  .strictObject({
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    description:
      'Reference and memo only. Amount, date, account and direction are in the posted journal ' +
      'and a journal is never edited — a payment recorded wrongly is voided and recorded again.',
  });

export type UpdatePaymentRequest = z.infer<typeof updatePaymentRequestSchema>;

/**
 * `unallocatedOnly` is what the "apply a credit" screen lists: the payments with
 * something still available on them (D-37's credit balance). Computed from the
 * allocations, like everything else about settlement (D-34).
 */
export const listPaymentsQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...documentDateRangeShape,
    direction: paymentDirectionSchema.optional(),
    contactId: z.uuid().optional(),
    status: paymentStatusSchema.optional(),
    unallocatedOnly: z.boolean().optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

export type ListPaymentsQuery = z.input<typeof listPaymentsQuerySchema>;

/**
 * Ordered by `(created_at, id)`.
 *
 * `date` is the column a user would sort on and it is the wrong keyset for the
 * usual reason (D-21): payments are recorded in whatever order the paperwork
 * surfaces, so back-dated ones land behind a cursor that has already passed their
 * date and appear on no page at all. `created_at` cannot move under a cursor.
 */
export const paymentPageSchema = unpublishedPageSchema(paymentSummarySchema);

export type PaymentPage = z.infer<typeof paymentPageSchema>;
