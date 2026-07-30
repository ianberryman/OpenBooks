import { z } from 'zod';

import { calendarDateSchema, pageQueryShape, pageSchema } from '../wire';

import {
  DOCUMENT_MAX_LINES,
  documentLineInputSchema,
  documentLineSchema,
  documentMemoSchema,
  documentNumberSchema,
  documentReferenceSchema,
  documentTotalsSchema,
  taxModeSchema,
} from '../subledger/documents';

/**
 * Purchase orders (initiative M, OB-170…174; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * A purchase order is a **non-posting pre-document** (D-M3): it never touches a
 * journal, and its own lifecycle — `draft` → `approved` → `converted` — is
 * therefore *not* `documentStatusSchema`, which is computed from journals and
 * allocations that a PO never has. `status` here is a plain stored enum, and
 * `approvedAt`/`convertedAt`-style timestamps are stored columns rather than
 * derived ones for the same reason.
 *
 * Everything else about a PO is the subledger document shape restated: the line
 * carries priced amounts through the same `documentLineSchema`/`documentLineInputSchema`
 * pair invoices and bills use, and `totals` is the same three-number sum
 * (D-35). The one deliberate difference is `predocumentLineInputSchema` below,
 * which is `documentLineInputSchema` **without** `dimensionValueIds` (D-M7):
 * a PO or an estimate carries no dimension tags in v1, and a converted draft
 * bill or invoice can have them added before it is approved.
 */

/**
 * One line as a purchase order or an estimate accepts it: `documentLineInputSchema`
 * minus `dimensionValueIds` (D-M7).
 *
 * `.omit` rather than a second hand-written object, for `reconciliationSessionSummarySchema`'s
 * reason: the fields that remain — `description`, `quantity`, `unitAmount`,
 * `accountId`, `taxRateId` — must stay identical to the document line's own, and
 * omission is what keeps them from drifting apart the first time either one
 * gains a constraint.
 *
 * Shared by both `purchase-orders.ts` and `estimates.ts`, which is why it lives
 * in this file rather than being defined twice: POs and estimates are the same
 * decision (D-M7) made once, not two coincidentally identical ones.
 */
export const predocumentLineInputSchema = documentLineInputSchema
  .omit({ dimensionValueIds: true })
  .meta({
    id: 'PredocumentLineRequest',
    description:
      'One line on a purchase order or an estimate. The same shape as a document line request ' +
      'minus `dimensionValueIds` (D-M7) — POs and estimates carry no dimension tags in v1; a ' +
      'converted draft bill or invoice can have them added before it is approved.',
  });

export type PredocumentLineInput = z.infer<typeof predocumentLineInputSchema>;

/**
 * The three states a purchase order moves through, in order (D-M6): `draft` →
 * `approved` → `converted`. Unlike `documentStatusSchema` this is stored, not
 * computed — a PO posts no journal and has no allocations to derive a status
 * from.
 *
 * No `.meta({ id })`: following `documentStatusSchema`'s own neighbours, an
 * inline enum costs no component and reads the same in a generated client.
 */
export const PURCHASE_ORDER_STATUSES = ['draft', 'approved', 'converted'] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

const purchaseOrderStatusSchema = z.enum(PURCHASE_ORDER_STATUSES).meta({
  description:
    'Stored, not computed (unlike a document’s own `status`): `draft` until approved, ' +
    '`approved` once a gapless number is allocated, `converted` once it has produced a bill. A ' +
    'PO posts no journal, so there is nothing here for D-38’s derivation to apply to.',
});

/**
 * A purchase order, with its lines.
 *
 * `convertedBillId` is null until `convertPurchaseOrderToBill` runs, and once
 * set it is permanent — convert-once is enforced by a `FOR UPDATE` guard at the
 * service, not by this schema (D-M4). `approvedAt` is null exactly when
 * `documentNumber` is (`chk_purchase_orders_approved`), restated here as two
 * fields rather than one for the same reason a document keeps `journalId` and
 * `documentNumber` separate: one names *when*, the other names *what*.
 */
export const purchaseOrderSchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: documentReferenceSchema.nullable(),
    contactId: z.uuid().meta({ description: 'The vendor this purchase order is issued to.' }),
    issueDate: calendarDateSchema,
    expectedDate: calendarDateSchema.nullable().meta({
      description: 'When the vendor is expected to deliver, if known. Purely informational.',
    }),
    taxMode: taxModeSchema,
    status: purchaseOrderStatusSchema,
    memo: documentMemoSchema.nullable(),
    lines: z.array(documentLineSchema),
    totals: documentTotalsSchema,
    convertedBillId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The bill this purchase order produced, once converted (D-M4). Null until then, and ' +
          'permanent after — a PO converts at most once.',
      }),
    approvedAt: z.iso.datetime().nullable().meta({
      description: 'When the PO was approved and its gapless number allocated. Null while draft.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'PurchaseOrder',
    description:
      'A purchase order: a non-posting pre-document (D-M3) that moves draft → approved → ' +
      'converted. `convertPurchaseOrderToBill` builds a draft bill from its header and lines; ' +
      'nothing here ever posts a journal directly.',
  });

export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

/**
 * A purchase order in a list: the header and the totals, no lines —
 * `invoiceSummarySchema`'s reason applies unchanged.
 */
export const purchaseOrderSummarySchema = purchaseOrderSchema.omit({ lines: true }).meta({
  id: 'PurchaseOrderSummary',
  description: 'A purchase order in a list, without its lines.',
});

export type PurchaseOrderSummary = z.infer<typeof purchaseOrderSummarySchema>;

/**
 * Creates a draft purchase order. `createBillRequestSchema`'s argument for what
 * is required and what is not applies unchanged, with `expectedDate` playing
 * the informational role `dueDate` plays on a bill's mirror.
 */
export const createPurchaseOrderRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    expectedDate: calendarDateSchema.nullish(),
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(predocumentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreatePurchaseOrderRequest',
    description:
      'Creates a **draft** purchase order. `lines` is optional — “New purchase order” ' +
      'produces an empty one, and the arity and account checks belong at approval.',
  });

export type CreatePurchaseOrderRequest = z.infer<typeof createPurchaseOrderRequestSchema>;

/**
 * Partial update of a **draft** purchase order; `lines`, when present, replaces
 * the whole set — `updateBillRequestSchema`'s reason, restated: the client is a
 * form holding the current state of every line.
 */
export const updatePurchaseOrderRequestSchema = z
  .strictObject({
    contactId: z.uuid().optional(),
    issueDate: calendarDateSchema.optional(),
    expectedDate: calendarDateSchema.nullish(),
    taxMode: taxModeSchema.optional(),
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(predocumentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdatePurchaseOrderRequest',
    description:
      'Partial update of a draft. `lines` replaces the whole set. An approved purchase order ' +
      'accepts none of this — approve, send and convert are the only operations left to it.',
  });

export type UpdatePurchaseOrderRequest = z.infer<typeof updatePurchaseOrderRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 */
export const listPurchaseOrdersQuerySchema = z.strictObject({
  ...pageQueryShape,
  contactId: z.uuid().optional(),
  status: purchaseOrderStatusSchema.optional(),
});

export type ListPurchaseOrdersQuery = z.input<typeof listPurchaseOrdersQuerySchema>;

/** Ordered by `(created_at, id)`, for `invoicePageSchema`'s reasons exactly. */
export const purchaseOrderPageSchema = pageSchema(purchaseOrderSummarySchema, {
  id: 'PurchaseOrderPage',
  description: 'One page of purchase orders, oldest first by creation.',
});

export type PurchaseOrderPage = z.infer<typeof purchaseOrderPageSchema>;
