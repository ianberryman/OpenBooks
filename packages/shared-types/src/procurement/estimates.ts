import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

import {
  DOCUMENT_MAX_LINES,
  documentLineSchema,
  documentMemoSchema,
  documentNumberSchema,
  documentReferenceSchema,
  documentTotalsSchema,
  taxModeSchema,
} from '../subledger/documents';

import { predocumentLineInputSchema } from './purchase-orders';

/**
 * Estimates (initiative M, OB-175…176; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * The AR mirror of `purchase-orders.ts`, structurally identical for the same
 * reason `invoices.ts` and `bills.ts` are spelled out separately rather than
 * generated from one another: a factory would save a few dozen lines and cost
 * the ability to say what is different about being the party who will be paid.
 * Read `purchase-orders.ts` for the reasoning behind every shared piece —
 * the non-posting pre-document lifecycle (D-M3), the stored (not computed)
 * status (D-M6), and `predocumentLineInputSchema`'s omission of
 * `dimensionValueIds` (D-M7), which this file reuses rather than redefines.
 *
 * Two fields are named differently from the PO side, both because the estimate
 * points the other way: `expiryDate` instead of `expectedDate` — an estimate
 * lapses rather than arrives — and `convertedInvoiceId` instead of
 * `convertedBillId`, since converting an estimate produces a draft invoice
 * (`convertEstimateToInvoice` → `createInvoice`), never a bill.
 */

/**
 * The three states an estimate moves through, in order (D-M6): `draft` →
 * `approved` → `converted`. Stored, not computed, for `purchaseOrderSchema`'s
 * reason: an estimate posts no journal and has no allocations to derive a
 * status from.
 */
export const ESTIMATE_STATUSES = ['draft', 'approved', 'converted'] as const;

export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

const estimateStatusSchema = z.enum(ESTIMATE_STATUSES).meta({
  description:
    'Stored, not computed: `draft` until approved, `approved` once a gapless number is ' +
    'allocated, `converted` once it has produced an invoice. An estimate posts no journal, so ' +
    'there is nothing here for D-38’s derivation to apply to.',
});

/**
 * An estimate, with its lines.
 *
 * `convertedInvoiceId` is null until `convertEstimateToInvoice` runs and is
 * permanent once set — convert-once is enforced by a `FOR UPDATE` guard at the
 * service, not by this schema (D-M4). "Customer acceptance" of an estimate is
 * not separately modelled in v1: converting it *is* accepting it (D-M6,
 * flagged as a v1 simplification).
 */
export const estimateSchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: documentReferenceSchema.nullable(),
    contactId: z.uuid().meta({ description: 'The customer this estimate is issued to.' }),
    issueDate: calendarDateSchema,
    expiryDate: calendarDateSchema.nullable().meta({
      description: 'When this estimate lapses, if given. Purely informational.',
    }),
    taxMode: taxModeSchema,
    status: estimateStatusSchema,
    memo: documentMemoSchema.nullable(),
    lines: z.array(documentLineSchema),
    totals: documentTotalsSchema,
    convertedInvoiceId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The invoice this estimate produced, once converted (D-M4). Null until then, and ' +
          'permanent after — an estimate converts at most once.',
      }),
    approvedAt: z.iso.datetime().nullable().meta({
      description:
        'When the estimate was approved and its gapless number allocated. Null while draft.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'Estimate',
    description:
      'An estimate: a non-posting pre-document (D-M3) that moves draft → approved → ' +
      'converted. `convertEstimateToInvoice` builds a draft invoice from its header and lines; ' +
      'nothing here ever posts a journal directly. Converting is the only form of acceptance ' +
      'modelled in v1.',
  });

export type Estimate = z.infer<typeof estimateSchema>;

/**
 * An estimate in a list: the header and the totals, no lines —
 * `invoiceSummarySchema`'s reason applies unchanged.
 */
export const estimateSummarySchema = estimateSchema.omit({ lines: true }).meta({
  id: 'EstimateSummary',
  description: 'An estimate in a list, without its lines.',
});

export type EstimateSummary = z.infer<typeof estimateSummarySchema>;

/**
 * Creates a draft estimate. `createInvoiceRequestSchema`'s argument for what is
 * required and what is not applies unchanged, with `expiryDate` playing the
 * informational role `dueDate` plays on an invoice's mirror.
 */
export const createEstimateRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    expiryDate: calendarDateSchema.nullish(),
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(predocumentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateEstimateRequest',
    description:
      'Creates a **draft** estimate. `lines` is optional — “New estimate” produces an ' +
      'empty one, and the arity and account checks belong at approval.',
  });

export type CreateEstimateRequest = z.infer<typeof createEstimateRequestSchema>;

/**
 * Partial update of a **draft** estimate; `lines`, when present, replaces the
 * whole set — `updateInvoiceRequestSchema`'s reason, restated: the client is a
 * form holding the current state of every line.
 */
export const updateEstimateRequestSchema = z
  .strictObject({
    contactId: z.uuid().optional(),
    issueDate: calendarDateSchema.optional(),
    expiryDate: calendarDateSchema.nullish(),
    taxMode: taxModeSchema.optional(),
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(predocumentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateEstimateRequest',
    description:
      'Partial update of a draft. `lines` replaces the whole set. An approved estimate accepts ' +
      'none of this — approve, send and convert are the only operations left to it.',
  });

export type UpdateEstimateRequest = z.infer<typeof updateEstimateRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 */
export const listEstimatesQuerySchema = z.strictObject({
  ...pageQueryShape,
  contactId: z.uuid().optional(),
  status: estimateStatusSchema.optional(),
});

export type ListEstimatesQuery = z.input<typeof listEstimatesQuerySchema>;

/** Ordered by `(created_at, id)`, for `invoicePageSchema`'s reasons exactly. */
export const estimatePageSchema = pageSchema(estimateSummarySchema, {
  id: 'EstimatePage',
  description: 'One page of estimates, oldest first by creation.',
});

export type EstimatePage = z.infer<typeof estimatePageSchema>;

/**
 * The estimates-list headline figures, as at a date — `invoicesSummaryQuerySchema`'s
 * reason applies unchanged: this is a live snapshot, not a reproducible report, so
 * `asOf` is optional and defaults to today.
 */
export const estimatesSummaryQuerySchema = z.strictObject({
  asOf: calendarDateSchema.optional().meta({
    description:
      'The date the figures are computed as at. Defaults to today: this is a live snapshot, not ' +
      'a reproducible report.',
  }),
});

export type EstimatesSummaryQuery = z.input<typeof estimatesSummaryQuerySchema>;

/**
 * The three headline figures the estimates list shows: what is still open (draft +
 * approved), what of the open amount has lapsed, and what has converted to an
 * invoice in the last 30 days. An estimate posts no journal (D-M3), so unlike
 * `InvoicesSummary`/`BillsSummary` these figures are stored-column predicates over
 * `estimates`, not a read against the aging repository.
 */
export const estimatesSummarySchema = z
  .strictObject({
    asOf: calendarDateSchema.meta({
      description:
        'The date the figures were computed as at — echoed so a client knows what it got.',
    }),
    openValue: minorUnitsSchema.meta({
      description: 'The gross value of every estimate not yet converted (draft + approved).',
    }),
    openCount: z.int().nonnegative().meta({
      description: 'How many estimates are still open.',
    }),
    expiredValue: minorUnitsSchema.meta({
      description:
        'The part of `openValue` that has lapsed: approved, unconverted, and `expiryDate` before ' +
        '`asOf`.',
    }),
    expiredCount: z.int().nonnegative().meta({
      description: 'How many open estimates have expired.',
    }),
    convertedValue: minorUnitsSchema.meta({
      description:
        'The gross value of estimates converted to an invoice within the 30 days ending on ' +
        '`asOf`.',
    }),
    convertedCount: z.int().nonnegative().meta({
      description: 'How many estimates converted within that window.',
    }),
  })
  .meta({
    id: 'EstimatesSummary',
    description:
      'The headline figures the estimates list shows: open value, expired value, and value ' +
      'converted in the last 30 days, as at a date (defaulting to today).',
  });

export type EstimatesSummary = z.infer<typeof estimatesSummarySchema>;
