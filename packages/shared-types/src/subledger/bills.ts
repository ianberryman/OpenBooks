import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

import { allocationSchema } from './allocations';
import {
  DOCUMENT_MAX_LINES,
  documentDateRangeShape,
  documentLineInputSchema,
  documentLineSchema,
  documentMemoSchema,
  documentNumberSchema,
  documentReferenceSchema,
  documentSettlementSchema,
  documentStatusSchema,
  documentTaxSummaryRowSchema,
  documentTotalsSchema,
  isOrderedRange,
  taxModeSchema,
} from './documents';

/**
 * The accounts-payable documents: bills and vendor credits (OB-061, for OB-063;
 * ROADMAP D-34, D-35, D-36, D-38, D-39).
 *
 * Structurally the mirror of `invoices.ts`, and spelled out rather than generated
 * from it, for the reason the P&L and the balance sheet each spell out their own
 * sections: a factory would save forty lines and cost the ability to say what is
 * different about being the party who owes.
 *
 * Two things are genuinely different, and both are about `reference`:
 *
 *  - On a bill it holds **the vendor's own invoice number** (D-36). That is the
 *    number that matters on an AP document — we did not issue it, our sequence
 *    number is only our internal handle, and it is what a supplier quotes when they
 *    chase payment. It is the field a duplicate-bill check would key on.
 *  - It is therefore the field most likely to be *present*, where an invoice's
 *    reference is often empty.
 *
 * The line's `accountId` also points the other way: an expense or asset account
 * that this bill debits, rather than the income account an invoice credits.
 */

/**
 * A bill from a vendor.
 *
 * No balance, no stored status, no period — `invoiceSchema` states why for all
 * three, and the reasons are the same document-shaped ones (D-34, D-38, D-17).
 */
export const billSchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: z
      .string()
      .nullable()
      .meta({
        description:
          'The vendor’s own invoice number (D-36). Distinct from `documentNumber`, which is our ' +
          'internal handle: this is the number the vendor prints, quotes when chasing, and expects ' +
          'on a remittance.',
      }),
    contactId: z.uuid().meta({ description: 'The vendor who billed us.' }),
    issueDate: calendarDateSchema.meta({
      description:
        'The date the vendor issued the bill, and the entry date of the journal it posts. It must ' +
        'fall inside an open fiscal period at approval (D-17).',
    }),
    dueDate: calendarDateSchema.meta({
      description: 'When payment is due. Aging measures from here, not from `issueDate` (D-40).',
    }),
    taxMode: taxModeSchema,
    status: documentStatusSchema,
    memo: z.string().nullable(),
    lines: z.array(documentLineSchema),
    totals: documentTotalsSchema,
    taxSummary: z.array(documentTaxSummaryRowSchema),
    settlement: documentSettlementSchema,
    committed: minorUnitsSchema.meta({
      description:
        'The amount reserved by open, not-yet-issued pending payments targeting this bill ' +
        "(D-68). Computed on read, never stored — `'0'` when there are none.",
    }),
    allocations: z.array(allocationSchema).meta({
      description:
        'What has been applied against this bill — payments made and vendor credits alike, through ' +
        'the same mechanism (D-39).',
    }),
    journalId: z.uuid().nullable(),
    voidJournalId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'Bill',
    description:
      'A bill from a vendor, with its lines. `reference` is the vendor’s own invoice number (D-36) ' +
      'and a duplicate is refused at approval. `status` and `settlement` are computed on read ' +
      '(D-34, D-38).',
  });

export type Bill = z.infer<typeof billSchema>;

export const billSummarySchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: z.string().nullable(),
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema,
    status: documentStatusSchema,
    totals: documentTotalsSchema,
    settlement: documentSettlementSchema,
    committed: minorUnitsSchema.meta({
      description:
        'The amount reserved by open, not-yet-issued pending payments targeting this bill ' +
        "(D-68). Computed on read, never stored — `'0'` when there are none.",
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'BillSummary', description: 'A bill in a list, without its lines.' });

export type BillSummary = z.infer<typeof billSummarySchema>;

/**
 * Creates a draft bill. `createInvoiceRequestSchema`'s argument for what is
 * required and what is not, with one addition: a bill's `issueDate` is the
 * vendor's date and is routinely in the past, which is what makes the open-period
 * check at approval the interesting one rather than a formality.
 *
 * `paymentTermId` is `createInvoiceRequestSchema`'s own field, the AP mirror
 * (OB-136, D-108): it overrides the vendor's default term for this one bill and
 * is create-only for the same reason.
 */
export const createBillRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema.optional(),
    paymentTermId: z
      .uuid()
      .optional()
      .meta({
        description:
          'Overrides the vendor’s default payment term for this bill. Absent falls back to the ' +
          'contact’s own default, if any. Create-only — not reachable through ' +
          '`UpdateBillRequest`.',
      }),
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateBillRequest',
    description:
      'Creates a **draft** bill. A bill’s `issueDate` is the vendor’s date and is routinely in the ' +
      'past, which is what makes the open-period check at approval the interesting one. ' +
      '`paymentTermId` overrides the vendor’s default term and is create-only.',
  });

export type CreateBillRequest = z.infer<typeof createBillRequestSchema>;

export const updateBillRequestSchema = z
  .strictObject({
    contactId: z.uuid().optional(),
    issueDate: calendarDateSchema.optional(),
    dueDate: calendarDateSchema.optional(),
    taxMode: taxModeSchema.optional(),
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateBillRequest',
    description:
      'Partial update of a draft. `lines` replaces the whole set. An approved bill accepts none ' +
      'of this — the correction is a vendor credit or a void, never an edit (D-38).',
  });

export type UpdateBillRequest = z.infer<typeof updateBillRequestSchema>;

/**
 * `reference` is a filter here and not on the invoice list, and the asymmetry is
 * the whole of D-36's point about this field: "have we already entered this bill"
 * is a question someone asks with the vendor's number in their hand, several times
 * a week. Nobody looks an invoice up by the customer's purchase-order number.
 */
export const listBillsQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...documentDateRangeShape,
    contactId: z.uuid().optional(),
    status: documentStatusSchema.optional(),
    dueBefore: calendarDateSchema.optional(),
    reference: documentReferenceSchema.optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

export type ListBillsQuery = z.input<typeof listBillsQuerySchema>;

/** Ordered by `(created_at, id)`, for `invoicePageSchema`'s reasons exactly. */
export const billPageSchema = pageSchema(billSummarySchema, {
  id: 'BillPage',
  description: 'One page of bills, oldest first by creation.',
});

export type BillPage = z.infer<typeof billPageSchema>;

/**
 * The bills-list headline figures, as at a date (OB-069 UI).
 *
 * A **live snapshot**, not a report, which is the whole reason `asOf` is optional
 * here and required on the aging report: D-40 makes an aging report reproducible, so
 * it refuses to default to a moving target. These three numbers are what the
 * purchases screen shows *right now*, so "today" is the only sensible default and a
 * caller that omits the date gets it.
 *
 * The figures tie to the aging report by construction — they are computed from the
 * same per-document outstanding (total minus allocations as at the date, D-34) the
 * payable aging sums, so `totalUnpaid` equals the payable aging's bill total and
 * `totalOverdue` its non-`current` buckets. Nothing here is a stored balance.
 */
export const billsSummaryQuerySchema = z.strictObject({
  asOf: calendarDateSchema.optional().meta({
    description:
      'The date the figures are computed as at. Defaults to today: this is a live snapshot, not ' +
      'a reproducible report, so unlike the aging report it does not require the date.',
  }),
});

export type BillsSummaryQuery = z.input<typeof billsSummaryQuerySchema>;

export const billsSummarySchema = z
  .strictObject({
    asOf: calendarDateSchema.meta({
      description:
        'The date the figures were computed as at — echoed so a client knows what it got.',
    }),
    totalUnpaid: minorUnitsSchema.meta({
      description:
        'What is still owed across all open bills (approved and part-paid), as at `asOf`. ' +
        'Outstanding is total minus allocations, computed on read (D-34) — never a stored balance.',
    }),
    openCount: z.int().nonnegative().meta({
      description: 'How many bills still have something owed on them.',
    }),
    totalOverdue: minorUnitsSchema.meta({
      description:
        'The part of `totalUnpaid` whose due date falls before `asOf`. Due today is not yet ' +
        'overdue, matching the aging report’s `current` bucket.',
    }),
    overdueCount: z.int().nonnegative().meta({
      description: 'How many of the open bills are overdue.',
    }),
    paidLast30Days: minorUnitsSchema.meta({
      description:
        'Payments made to vendors dated within the 30 days ending on `asOf` — money out, ' +
        'whatever it was applied to.',
    }),
  })
  .meta({
    id: 'BillsSummary',
    description:
      'The headline figures the bills list shows: total still owed, total overdue, and paid in ' +
      'the last 30 days, as at a date (defaulting to today).',
  });

export type BillsSummary = z.infer<typeof billsSummarySchema>;

/**
 * A vendor credit: the AP mirror of a credit note, and a document in its own right
 * for D-39's reasons.
 *
 * It reduces what we owe a vendor by allocating against bills. No `dueDate`, for
 * the same reason a credit note has none: nothing about it falls due.
 */
export const vendorCreditSchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: z.string().nullable().meta({
      description: 'The vendor’s own credit-note number, where they issued one (D-36).',
    }),
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    taxMode: taxModeSchema,
    status: documentStatusSchema,
    memo: z.string().nullable(),
    lines: z.array(documentLineSchema),
    totals: documentTotalsSchema,
    taxSummary: z.array(documentTaxSummaryRowSchema),
    settlement: documentSettlementSchema,
    allocations: z.array(allocationSchema).meta({
      description: 'The bills this credit has been applied to, and for how much.',
    }),
    journalId: z.uuid().nullable(),
    voidJournalId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'VendorCredit',
    description:
      'A vendor credit: the AP mirror of a credit note, and a document in its own right (D-39). It ' +
      'reduces what we owe by allocating against bills, and has no `dueDate` because nothing about ' +
      'it falls due.',
  });

export type VendorCredit = z.infer<typeof vendorCreditSchema>;

export const vendorCreditSummarySchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: z.string().nullable(),
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    status: documentStatusSchema,
    totals: documentTotalsSchema,
    settlement: documentSettlementSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'VendorCreditSummary',
    description: 'A vendor credit in a list, without its lines.',
  });

export type VendorCreditSummary = z.infer<typeof vendorCreditSummarySchema>;

export const createVendorCreditRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateVendorCreditRequest',
    description: 'Creates a **draft** vendor credit. No `dueDate`: nothing about one falls due.',
  });

export type CreateVendorCreditRequest = z.infer<typeof createVendorCreditRequestSchema>;

export const updateVendorCreditRequestSchema = z
  .strictObject({
    contactId: z.uuid().optional(),
    issueDate: calendarDateSchema.optional(),
    taxMode: taxModeSchema.optional(),
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateVendorCreditRequest',
    description:
      'Partial update of a draft. `lines` replaces the whole set. An approved vendor credit ' +
      'accepts none of this — the correction is a void, never an edit (D-38).',
  });

export type UpdateVendorCreditRequest = z.infer<typeof updateVendorCreditRequestSchema>;

export const listVendorCreditsQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...documentDateRangeShape,
    contactId: z.uuid().optional(),
    status: documentStatusSchema.optional(),
    unappliedOnly: z.boolean().optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

export type ListVendorCreditsQuery = z.input<typeof listVendorCreditsQuerySchema>;

export const vendorCreditPageSchema = pageSchema(vendorCreditSummarySchema, {
  id: 'VendorCreditPage',
  description: 'One page of vendor credits, oldest first by creation.',
});

export type VendorCreditPage = z.infer<typeof vendorCreditPageSchema>;
