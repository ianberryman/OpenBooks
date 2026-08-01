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
 * The accounts-receivable documents: invoices and credit notes (OB-061, for
 * OB-062; ROADMAP D-34, D-35, D-36, D-38, D-39).
 *
 * `documents.ts` holds everything these share with the AP side. What is here is the
 * part that is specific to being owed money: a due date, a customer's purchase-order
 * reference, and a credit note that is a document in its own right rather than an
 * invoice with a minus sign.
 *
 * ## The ids arrived with OB-067's routes
 *
 * For the reason stated at the top of `documents.ts` and argued in full in
 * `accounts/accounts.ts`. The two list queries still carry none and must not: a
 * querystring is emitted as individual `parameters`, so a component for one would be
 * referenced by nothing.
 *
 * ## There is no "approve" request schema, and that is deliberate
 *
 * Approving takes no fields. The entry date is the document's own `issueDate`, the
 * actor comes from the session (never from the request — `journals.ts` argues why),
 * and the amounts come from the lines the document already holds. A body with
 * nothing in it would invite a field to be added, and the first field anyone would
 * add is the one that lets a client name a different date for the journal than the
 * one printed on the invoice it is posting.
 */

/**
 * A customer invoice.
 *
 * Three absences are the decisions worth reading, and all three are D-34 and D-38
 * applied to a shape:
 *
 *  - **No balance.** `settlement` is computed on read.
 *  - **No stored status.** `status` is derived from the journals and allocations.
 *  - **No period.** Which fiscal period the posting lands in is resolved from
 *    `issueDate` at approval, so a draft written in an open period and approved
 *    after it closed cannot carry a stale answer (`journalDraftSchema`'s reason).
 */
export const invoiceSchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: z
      .string()
      .nullable()
      .meta({
        description:
          'The customer’s own reference for this invoice — their purchase-order number, in practice. ' +
          'Free text we do not issue and do not check (D-36).',
      }),
    contactId: z.uuid().meta({ description: 'The customer being invoiced.' }),
    issueDate: calendarDateSchema.meta({
      description:
        'The date the invoice is issued, and the entry date of the journal it posts. It must fall ' +
        'inside an open fiscal period at approval — periods are never created as a side effect ' +
        '(D-17).',
    }),
    dueDate: calendarDateSchema.meta({
      description:
        'When payment is due. Aging measures from here rather than from `issueDate`, because that ' +
        'is what "overdue" means to the person chasing it (D-40).',
    }),
    taxMode: taxModeSchema,
    status: documentStatusSchema,
    memo: z.string().nullable(),
    lines: z.array(documentLineSchema),
    totals: documentTotalsSchema,
    taxSummary: z.array(documentTaxSummaryRowSchema),
    settlement: documentSettlementSchema,
    allocations: z.array(allocationSchema).meta({
      description:
        'What has been applied against this invoice — payments and credit notes alike, through ' +
        'one mechanism (D-39). These are what `settlement` is computed from.',
    }),
    journalId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The journal this invoice posted at approval, or null while it is a draft. Approval is the ' +
          'only thing that writes to the ledger (C1).',
      }),
    voidJournalId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The reversing journal, once voided (D-38). The invoice, its number and its original ' +
          'journal all remain visible — nothing is deleted (D-16, C7).',
      }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'Invoice',
    description:
      'A customer invoice, with its lines. `status` and `settlement` are computed on read and ' +
      'stored nowhere (D-34, D-38) — a client that wrote either back would be writing a field the ' +
      'server derives.',
  });

export type Invoice = z.infer<typeof invoiceSchema>;

/**
 * An invoice in a list: the header, the totals, and no lines.
 *
 * `journalSummarySchema`'s argument — embedding lines would make the size of one
 * page depend on how many lines an org's invoices happen to carry, which is the
 * property the page-size bound exists to remove. `totals` and `settlement` stay,
 * because an invoice list that could not show what is outstanding would be a list
 * nobody could use for the one job it has.
 */
export const invoiceSummarySchema = z
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
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'InvoiceSummary',
    description:
      'An invoice in a list: the header, the totals and the settlement, and no lines — embedding ' +
      'them would make one page’s size depend on how many lines an org’s invoices happen to carry.',
  });

export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

/**
 * Creates a draft invoice.
 *
 * Unlike a journal draft, where every field is optional (D-19), the header identity
 * is required here: a customer, an issue date, and the declaration of what the
 * prices mean. The reason is that those three decide what the document *is* — a
 * draft with no customer is not an unfinished invoice, it is an unfinished thought,
 * and `taxMode` in particular cannot be filled in later without repricing every
 * line that was entered under the other reading.
 *
 * `lines` is optional, because "New invoice" produces an empty one and the arity
 * and account checks belong at approval, where their failure is a message to the
 * person approving.
 *
 * `dueDate` is optional and defaults to `issueDate` — due on receipt. Defaulted
 * rather than nullable because aging measures from the due date (D-40), and a null
 * due date would make a document that ages from nothing.
 *
 * `paymentTermId` is create-only (OB-136, D-108): it overrides the customer's
 * default term for this one invoice, resolved by `resolveDocumentTerm`
 * (contact-default-then-document-override) and recorded whenever a term is
 * resolved, independent of whether `dueDate` was also given explicitly. There is
 * no way to change it after creation — a term already governing a document must
 * not have its due-date or discount arithmetic move under it once entered.
 */
export const createInvoiceRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema.optional(),
    paymentTermId: z
      .uuid()
      .optional()
      .meta({
        description:
          'Overrides the customer’s default payment term for this invoice. Absent falls back to ' +
          'the contact’s own default, if any; there is no term at all if neither names one. ' +
          'Create-only — a term already resolved onto a document is not reachable through ' +
          '`UpdateInvoiceRequest`.',
      }),
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateInvoiceRequest',
    description:
      'Creates a **draft** invoice. `dueDate` defaults to `issueDate` — due on receipt — and ' +
      '`lines` is optional, because “New invoice” produces an empty one and the arity and account ' +
      'checks belong at approval. `paymentTermId` overrides the contact’s default term and is ' +
      'create-only.',
  });

export type CreateInvoiceRequest = z.infer<typeof createInvoiceRequestSchema>;

/**
 * Partial update of a **draft** invoice; `lines`, when present, replaces the whole
 * set.
 *
 * Replacement rather than per-line patching, for `updateDraftRequestSchema`'s
 * reason: the client is a form holding the current state of every line, and
 * patching would need stable line identities across an edit that inserts a line in
 * the middle.
 *
 * An approved invoice accepts none of this. Not because the schema forbids it —
 * this shape has no idea what state the document is in — but because the service
 * does: after approval the ledger has been told (D-38), and the correction is a
 * credit note or a void, never an edit.
 */
export const updateInvoiceRequestSchema = z
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
    id: 'UpdateInvoiceRequest',
    description:
      'Partial update of a draft. An absent field is unchanged, `null` clears a nullable one, ' +
      'and `lines` replaces the whole set — send every line the invoice should have, including ' +
      'the unchanged ones. Changing `taxMode` reprices the lines rather than converting them.',
  });

export type UpdateInvoiceRequest = z.infer<typeof updateInvoiceRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 *
 * `status` filters on a value that is *computed* (D-38), which is worth naming
 * because it is the one place the derived-status decision costs something: the
 * service resolves it in the query that lists, not by reading a column, so
 * "unpaid invoices" is a join against allocations rather than an index lookup.
 * That is D-34's accepted cost, and the alternative — a status column kept in step
 * by the application — is the drift D-38 refuses.
 *
 * `from`/`to` bound the issue date. `dueBefore` is separate rather than a second
 * range because the question it answers is "what is late", which needs one bound
 * and reads worse as a half-open range.
 */
export const listInvoicesQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...documentDateRangeShape,
    contactId: z.uuid().optional(),
    status: documentStatusSchema.optional(),
    dueBefore: calendarDateSchema.optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListInvoicesQuery = z.input<typeof listInvoicesQuerySchema>;

/**
 * Ordered by `(created_at, id)`, and not by document number.
 *
 * The number is the ordering a person would ask for, and it is unavailable as a
 * keyset: a draft has none until approval (D-36 through D-14's gapless argument),
 * so the column is null for exactly the rows a drafts-included list has to page.
 * `issueDate` is editable while a document is a draft, and a keyset over a mutable
 * column silently drops the rows that moved behind the cursor — the failure D-21
 * chose keyset to eliminate, reached through a mutable sort key instead of through
 * `OFFSET`. `created_at` is neither null nor editable, and `id` makes it total.
 */
export const invoicePageSchema = pageSchema(invoiceSummarySchema, {
  id: 'InvoicePage',
  description: 'One page of invoices, oldest first by creation.',
});

export type InvoicePage = z.infer<typeof invoicePageSchema>;

/**
 * The invoices-list headline figures, as at a date (OB-069 UI) — the AR mirror of
 * `BillsSummary`.
 *
 * A **live snapshot**, not a report, which is the whole reason `asOf` is optional
 * here and required on the aging report: D-40 makes an aging report reproducible, so
 * it refuses to default to a moving target. These three numbers are what the sales
 * screen shows *right now*, so "today" is the only sensible default and a caller
 * that omits the date gets it.
 *
 * The figures tie to the aging report by construction — they are computed from the
 * same per-document outstanding (total minus allocations as at the date, D-34) the
 * receivable aging sums, so `totalUnpaid` equals the receivable aging's invoice
 * total and `totalOverdue` its non-`current` buckets. Nothing here is a stored
 * balance.
 */
export const invoicesSummaryQuerySchema = z.strictObject({
  asOf: calendarDateSchema.optional().meta({
    description:
      'The date the figures are computed as at. Defaults to today: this is a live snapshot, not ' +
      'a reproducible report, so unlike the aging report it does not require the date.',
  }),
});

export type InvoicesSummaryQuery = z.input<typeof invoicesSummaryQuerySchema>;

export const invoicesSummarySchema = z
  .strictObject({
    asOf: calendarDateSchema.meta({
      description:
        'The date the figures were computed as at — echoed so a client knows what it got.',
    }),
    totalUnpaid: minorUnitsSchema.meta({
      description:
        'What is still owed across all open invoices (approved and part-paid), as at `asOf`. ' +
        'Outstanding is total minus allocations, computed on read (D-34) — never a stored balance.',
    }),
    openCount: z.int().nonnegative().meta({
      description: 'How many invoices still have something owed on them.',
    }),
    totalOverdue: minorUnitsSchema.meta({
      description:
        'The part of `totalUnpaid` whose due date falls before `asOf`. Due today is not yet ' +
        'overdue, matching the aging report’s `current` bucket.',
    }),
    overdueCount: z.int().nonnegative().meta({
      description: 'How many of the open invoices are overdue.',
    }),
    paidLast30Days: minorUnitsSchema.meta({
      description:
        'Payments received from customers dated within the 30 days ending on `asOf` — money in, ' +
        'whatever it was applied to.',
    }),
  })
  .meta({
    id: 'InvoicesSummary',
    description:
      'The headline figures the invoices list shows: total still owed, total overdue, and paid ' +
      'in the last 30 days, as at a date (defaulting to today).',
  });

export type InvoicesSummary = z.infer<typeof invoicesSummarySchema>;

/**
 * A credit note: a document, not a negative invoice (D-39).
 *
 * It has its own gapless sequence, posts its own journal, and reduces what a
 * customer owes by *allocating* against invoices — the same mechanism payments use,
 * so "what is outstanding" has one definition regardless of what reduced it.
 *
 * Modelling it as an invoice with negative lines would be less code and worse
 * books: aging would need to special-case the sign, a credit note could accidentally
 * be paid, and the document the customer receives would be an invoice claiming they
 * owe minus two hundred.
 *
 * Its lines are positive, like an invoice's, and the *direction* is what the
 * document type carries. `settlement.outstanding` therefore reads as "credit still
 * available to apply" rather than "still owed" — one arithmetic, two readings, as
 * `documentSettlementSchema` says.
 *
 * There is no `dueDate`: nothing about a credit note falls due, and aging never
 * ages one. It reduces the invoices it is applied to, on the date of the allocation.
 */
export const creditNoteSchema = z
  .strictObject({
    id: z.uuid(),
    documentNumber: documentNumberSchema.nullable(),
    reference: z.string().nullable().meta({
      description: 'Free text — commonly the customer’s claim or return reference (D-36).',
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
      description: 'The invoices this credit note has been applied to, and for how much.',
    }),
    journalId: z.uuid().nullable(),
    voidJournalId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'CreditNote',
    description:
      'A credit note: a document, not a negative invoice (D-39). Its lines are positive and the ' +
      'direction is what the document type carries, so `settlement.outstanding` reads as “credit ' +
      'still available to apply”. There is no `dueDate` — nothing about a credit note falls due.',
  });

export type CreditNote = z.infer<typeof creditNoteSchema>;

export const creditNoteSummarySchema = z
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
  .meta({ id: 'CreditNoteSummary', description: 'A credit note in a list, without its lines.' });

export type CreditNoteSummary = z.infer<typeof creditNoteSummarySchema>;

export const createCreditNoteRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateCreditNoteRequest',
    description:
      'Creates a **draft** credit note. No `dueDate`, for the reason `CreditNote` gives: nothing ' +
      'about a credit note falls due.',
  });

export type CreateCreditNoteRequest = z.infer<typeof createCreditNoteRequestSchema>;

export const updateCreditNoteRequestSchema = z
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
    id: 'UpdateCreditNoteRequest',
    description:
      'Partial update of a draft. `lines` replaces the whole set. An approved credit note ' +
      'accepts none of this — the correction is a void, never an edit (D-38).',
  });

export type UpdateCreditNoteRequest = z.infer<typeof updateCreditNoteRequestSchema>;

/**
 * `unappliedOnly` is the filter the "apply a credit" screen is built from: it lists
 * the credit notes with something left on them, which is `settlement.outstanding`
 * being non-zero — computed, like everything else about settlement (D-34).
 */
export const listCreditNotesQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...documentDateRangeShape,
    contactId: z.uuid().optional(),
    status: documentStatusSchema.optional(),
    unappliedOnly: z.boolean().optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

export type ListCreditNotesQuery = z.input<typeof listCreditNotesQuerySchema>;

export const creditNotePageSchema = pageSchema(creditNoteSummarySchema, {
  id: 'CreditNotePage',
  description: 'One page of credit notes, oldest first by creation.',
});

export type CreditNotePage = z.infer<typeof creditNotePageSchema>;
