import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';
import { documentMemoSchema, documentReferenceSchema } from '../subledger/documents';

/**
 * Pay Bills (initiative G, OB-109…118; ROADMAP D-63…D-69, D-109…D-112).
 *
 * The wire shapes for the pending-payment queue and its issue: the queued state
 * that posts no journal (D-64), the batch request that fans out one payment per
 * vendor (D-63), the rail classification (D-110), and the Pay Bills window's
 * per-bill payability — `outstanding`, `committed`, and `availableToPay`, all three
 * computed on read and stored nowhere (D-34, D-68).
 *
 * ## No `.meta({ id })` here yet
 *
 * Following every earlier module's rule (`payment-terms.ts`'s header states it): an
 * `.meta({ id })` publishes a `components.schemas` entry and A10 fails the build on
 * one nothing references. These schemas gain their ids in OB-115 when `/v1` routes
 * reference them; until then a description-only `.meta` is safe (it inlines rather
 * than registering a component).
 */

/**
 * How a disbursement will be executed. `check` is handled in-app (a number drawn
 * from the per-bank-account register, a printable check + stub); `ach` and `wire`
 * are classification tags for an external system that performs the movement and
 * returns its trace/confirmation onto the payment's `reference` — OpenBooks writes
 * no NACHA file and no wire artifact (D-110/D-111).
 */
export const PAYMENT_RAILS = ['check', 'ach', 'wire'] as const;

export type PaymentRail = (typeof PAYMENT_RAILS)[number];

export const railSchema = z.enum(PAYMENT_RAILS).meta({
  description:
    'How the disbursement is executed. `check` is handled in-app (a number and a printable ' +
    'check); `ach`/`wire` are tags for an external system, which returns the trace onto the ' +
    'payment reference — no NACHA or wire file is generated (D-110).',
});

/**
 * A pending payment's lifecycle, all pencil until issue (D-64). `open` while it is
 * built and edited, `issued` once released into a real `Payment`, `cancelled` if
 * abandoned. Only `open` counts toward a bill's `committed`.
 */
export const PENDING_PAYMENT_STATUSES = ['open', 'issued', 'cancelled'] as const;

export type PendingPaymentStatus = (typeof PENDING_PAYMENT_STATUSES)[number];

export const pendingPaymentStatusSchema = z.enum(PENDING_PAYMENT_STATUSES).meta({
  description:
    'Pencil lifecycle: `open` while built and edited, `issued` once released into a real ' +
    'Payment, `cancelled` if abandoned. Only `open` intents count toward a bill’s `committed`.',
});

/** Restated from `0002_ledger`'s VARCHAR-width convention (chars ≥ code units). */
export const ACH_NUMBER_MAX_LENGTH = 34;
export const WIRE_INSTRUCTIONS_MAX_LENGTH = 1024;

const achNumberSchema = z.string().trim().min(1).max(ACH_NUMBER_MAX_LENGTH);
const wireInstructionsSchema = z.string().trim().min(1).max(WIRE_INSTRUCTIONS_MAX_LENGTH);

/**
 * One bill a pending payment will settle: how much of it to pay, an optional
 * settlement discount (amount + the account it credits, user-selected — D-66/D-112),
 * and an optional vendor credit to apply. The discount amount and its account are
 * supplied together or not at all — a discount amount with no account to credit
 * settles nothing, and the queue service is the sole writer, so the pairing is
 * stated here rather than as a database CHECK.
 */
export const pendingPaymentIntentInputSchema = z
  .strictObject({
    billId: z.uuid(),
    payAmount: minorUnitsSchema.meta({
      description: 'How much of this bill this payment covers, in minor units.',
    }),
    discountAmount: minorUnitsSchema.optional(),
    discountAccountId: z.uuid().optional(),
    appliedVendorCreditId: z.uuid().optional(),
  })
  .refine(
    (input) => (input.discountAmount === undefined) === (input.discountAccountId === undefined),
    {
      message: 'discountAmount and discountAccountId are supplied together, or not at all.',
      path: ['discountAccountId'],
    },
  );

export type PendingPaymentIntentInput = z.infer<typeof pendingPaymentIntentInputSchema>;

/** An intent as the API returns it. */
export const pendingPaymentIntentSchema = z.strictObject({
  id: z.uuid(),
  billId: z.uuid(),
  payAmount: minorUnitsSchema,
  discountAmount: minorUnitsSchema.nullable(),
  discountAccountId: z.uuid().nullable(),
  appliedVendorCreditId: z.uuid().nullable(),
});

export type PendingPaymentIntent = z.infer<typeof pendingPaymentIntentSchema>;

/**
 * Builds one pending payment — one vendor, because a `Payment` carries one contact
 * and allocations refuse to cross contacts (D-63). Posts no journal (D-64); the rail
 * defaults from the vendor's `preferredPaymentRail` at the call site but is explicit
 * on the wire and changeable in the queue.
 */
export const createPendingPaymentRequestSchema = z.strictObject({
  contactId: z.uuid(),
  bankAccountId: z.uuid(),
  rail: railSchema,
  memo: documentMemoSchema.nullish(),
  intents: z.array(pendingPaymentIntentInputSchema).min(1),
});

export type CreatePendingPaymentRequest = z.infer<typeof createPendingPaymentRequestSchema>;

/**
 * Edits an `open` pending payment. Every field is optional — an omitted one is left
 * alone — but `intents`, when supplied, replaces the set wholesale rather than
 * patching individual lines: the queue is pencil, and rebuilding the line set is how
 * it is edited. An `issued` or `cancelled` pending payment is not editable (the
 * service refuses it), so this shape never has to express a partial ledger unwind.
 */
export const updatePendingPaymentRequestSchema = z
  .strictObject({
    bankAccountId: z.uuid().optional(),
    rail: railSchema.optional(),
    memo: documentMemoSchema.nullish(),
    intents: z.array(pendingPaymentIntentInputSchema).min(1).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  });

export type UpdatePendingPaymentRequest = z.infer<typeof updatePendingPaymentRequestSchema>;

/** A pending payment as the API returns it, with its intents and computed total. */
export const pendingPaymentSchema = z.strictObject({
  id: z.uuid(),
  contactId: z.uuid(),
  vendorName: z.string().meta({
    description: 'The vendor’s display name, denormalized for the queue screen.',
  }),
  bankAccountId: z.uuid(),
  rail: railSchema,
  status: pendingPaymentStatusSchema,
  issuedPaymentId: z.uuid().nullable().meta({
    description: 'The real Payment this materialised into, once issued; null while open.',
  }),
  memo: z.string().nullable(),
  intents: z.array(pendingPaymentIntentSchema),
  totalAmount: minorUnitsSchema.meta({
    description: 'Σ of the intents’ payAmount — what the check or transfer is for. Computed.',
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type PendingPayment = z.infer<typeof pendingPaymentSchema>;

/** The queue as a list — bounded per org, so not paged (`paymentTermListSchema`'s reasoning). */
export const pendingPaymentListSchema = z.strictObject({
  pendingPayments: z.array(pendingPaymentSchema),
});

export type PendingPaymentList = z.infer<typeof pendingPaymentListSchema>;

/**
 * A batch Pay Bills request: a set of per-vendor pending payments built in one
 * gesture (D-63 — the fan-out is already expressed as one element per vendor). The
 * service builds each independently so one vendor's refusal does not lose the rest.
 */
export const payBillsRequestSchema = z.strictObject({
  payments: z.array(createPendingPaymentRequestSchema).min(1),
});

export type PayBillsRequest = z.infer<typeof payBillsRequestSchema>;

/** Re-routes an `open` pending payment to a different rail. */
export const routeToRailRequestSchema = z.strictObject({
  rail: railSchema,
});

export type RouteToRailRequest = z.infer<typeof routeToRailRequestSchema>;

/**
 * Issues one pending payment — materialises it into a real `Payment` (D-65). `date`
 * is the payment/journal date; `reference` is the rail identifier for an `ach`/`wire`
 * (the trace or confirmation, user- or integration-supplied — D-36), left null for a
 * `check`, which draws its number from the register instead.
 */
export const issuePendingPaymentRequestSchema = z.strictObject({
  date: calendarDateSchema,
  reference: documentReferenceSchema.nullish(),
});

export type IssuePendingPaymentRequest = z.infer<typeof issuePendingPaymentRequestSchema>;

/**
 * Issues several pending payments in one call. **Atomic per payment, not per run**
 * (G2/D-63): each vendor is materialised in its own transaction, so one bad ACH
 * detail leaves the others issued and that one `open`/flagged. The result reports
 * each outcome individually.
 */
export const issuePendingPaymentsRequestSchema = z.strictObject({
  pendingPaymentIds: z.array(z.uuid()).min(1),
  date: calendarDateSchema,
});

export type IssuePendingPaymentsRequest = z.infer<typeof issuePendingPaymentsRequestSchema>;

/** One pending payment's issue outcome — success carries the Payment (and, for a check, its number). */
export const issueOutcomeSchema = z.strictObject({
  pendingPaymentId: z.uuid(),
  status: z.enum(['issued', 'failed']),
  paymentId: z.uuid().nullable(),
  checkNumber: z.string().nullable().meta({
    description: 'The number drawn from the bank account’s register when the rail is `check`; null otherwise.',
  }),
  error: z.string().nullable().meta({
    description: 'The refusal token when `status` is `failed`; null on success.',
  }),
});

export type IssueOutcome = z.infer<typeof issueOutcomeSchema>;

export const issueResultSchema = z.strictObject({
  outcomes: z.array(issueOutcomeSchema),
});

export type IssueResult = z.infer<typeof issueResultSchema>;

/**
 * A bill on the Pay Bills window. `outstanding` is total minus allocations (D-34);
 * `committed` is the sum of open pending intents targeting it (D-68); and
 * `availableToPay = outstanding − committed` is what a new pending payment may still
 * queue against it. All three are computed on read and stored nowhere — a bill an
 * open pending payment already covers shows `availableToPay = 0` and cannot be
 * queued again (G4).
 */
export const payableBillSchema = z.strictObject({
  billId: z.uuid(),
  contactId: z.uuid(),
  vendorName: z.string(),
  reference: z.string().nullable(),
  issueDate: calendarDateSchema,
  dueDate: calendarDateSchema.nullable(),
  gross: minorUnitsSchema,
  outstanding: minorUnitsSchema,
  committed: minorUnitsSchema.meta({
    description: 'Σ payAmount over open pending intents targeting this bill (D-68). Computed.',
  }),
  availableToPay: minorUnitsSchema.meta({
    description: 'outstanding − committed — what a new pending payment may still queue. Computed.',
  }),
});

export type PayableBill = z.infer<typeof payableBillSchema>;

export const payableBillListSchema = z.strictObject({
  bills: z.array(payableBillSchema),
});

export type PayableBillList = z.infer<typeof payableBillListSchema>;

/**
 * A disbursement as an external ACH/wire processor pulls it (D-110). The vendor's
 * bank coordinates travel here because this is the surface whose whole job is to
 * hand them to the system that moves the money — a sensitive read, gated on the
 * issue permission, and the reason those columns are flagged for log redaction.
 */
export const railDisbursementSchema = z.strictObject({
  paymentId: z.uuid(),
  contactId: z.uuid(),
  vendorName: z.string(),
  rail: railSchema,
  amount: minorUnitsSchema,
  reference: z.string().nullable(),
  achRoutingNumber: z.string().nullable(),
  achAccountNumber: z.string().nullable(),
  wireInstructions: z.string().nullable(),
  issuedAt: z.iso.datetime(),
});

export type RailDisbursement = z.infer<typeof railDisbursementSchema>;

export const railDisbursementListSchema = z.strictObject({
  disbursements: z.array(railDisbursementSchema),
});

export type RailDisbursementList = z.infer<typeof railDisbursementListSchema>;

/**
 * A vendor's disbursement details, kept on the contact (D-67). Sensitive: the ACH
 * and wire coordinates are the vendor's real bank data, never seeded, redacted in
 * logs. `preferredPaymentRail` seeds a new pending payment's rail default.
 */
export const vendorDisbursementDetailsSchema = z.strictObject({
  preferredPaymentRail: railSchema.nullable(),
  achRoutingNumber: z.string().nullable(),
  achAccountNumber: z.string().nullable(),
  wireInstructions: z.string().nullable(),
});

export type VendorDisbursementDetails = z.infer<typeof vendorDisbursementDetailsSchema>;

/** Sets or clears a vendor's disbursement details. An omitted field is left alone. */
export const updateVendorDisbursementDetailsRequestSchema = z
  .strictObject({
    preferredPaymentRail: railSchema.nullish(),
    achRoutingNumber: achNumberSchema.nullish(),
    achAccountNumber: achNumberSchema.nullish(),
    wireInstructions: wireInstructionsSchema.nullish(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'Supply at least one field to change.',
  });

export type UpdateVendorDisbursementDetailsRequest = z.infer<
  typeof updateVendorDisbursementDetailsRequestSchema
>;
