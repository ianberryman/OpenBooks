import { z } from 'zod';

import { calendarDateSchema } from '../wire';

/**
 * The customer statement-of-account wire contract (OB-220, ROADMAP part 1).
 *
 * A per-customer, branded **open-item** statement — the invoices still owing as at a
 * date, aged — rendered to one PDF, stored behind the `StorageProvider` (the INV
 * foundation) and recorded in `customer_statements` (append-only) so it is
 * re-downloadable and, when emailed, reachable from a public hosted link. The data
 * is the AR aging report scoped to one contact (D-40's "what does this customer owe
 * and since when" is aging with `contactId`, not a second definition of
 * outstanding), so this is assembly, not a new subledger. Gated by `reports.read` —
 * it renders a report the holder can already run, the same gate the statement
 * package takes.
 */

/** A statement is generated (downloaded), emailed (sent), or a send that failed. */
export const CUSTOMER_STATEMENT_STATUSES = ['generated', 'sent', 'failed'] as const;

export const customerStatementStatusSchema = z.enum(CUSTOMER_STATEMENT_STATUSES).meta({
  description:
    '`generated` when rendered for download only; `sent` when emailed to the customer; `failed` ' +
    'when an email send threw — its own row, never an overwrite of a prior try.',
});

export type CustomerStatementStatus = (typeof CUSTOMER_STATEMENT_STATUSES)[number];

/**
 * The generate request: a customer and the date the open-item balance is computed as
 * at. `delivery` present emails the statement to the customer (the split-credential
 * hosted link, as a sent invoice) and records `status='sent'`; absent renders for
 * download only and records `status='generated'`. `asOf` is required for aging's
 * reason (D-40): a statement that defaulted to today would answer differently
 * tomorrow, and the request that produced a figure a customer filed must reproduce it.
 */
export const createCustomerStatementRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    asOf: calendarDateSchema.meta({
      description: 'The date the open-item balance is computed as at. Required (D-40).',
    }),
    delivery: z
      .strictObject({
        recipientEmail: z
          .email()
          .max(320)
          .meta({ description: 'Where to email the statement. Absent renders for download only.' }),
      })
      .optional()
      .meta({
        description: 'Present emails the statement to the customer; absent is download-only.',
      }),
  })
  .meta({
    id: 'CreateCustomerStatementRequest',
    description: 'Renders a branded open-item statement of account for one customer to a PDF.',
  });

export type CreateCustomerStatementRequest = z.infer<typeof createCustomerStatementRequestSchema>;

/**
 * One rendered statement. `downloadUrl` is a freshly-minted `StorageProvider` signed
 * URL — signed at read time and short-lived, so the create response and every list
 * row carry one and there is no separate id-addressed download route (the statement
 * package's convention). `publicUrl` is the hosted-page link, present only when the
 * statement was emailed (a token was minted). `closingBalanceMinor` is the customer's
 * total owed as at `asOf`, the figure the statement totals to — a cents-only string
 * (D-13), the money convention everywhere on the wire.
 */
export const customerStatementSchema = z
  .strictObject({
    id: z.uuid(),
    contactId: z.uuid(),
    contactName: z.string(),
    asOf: calendarDateSchema,
    status: customerStatementStatusSchema,
    recipientEmail: z.email().nullable().meta({
      description: 'The address it was emailed to, or null when generated for download only.',
    }),
    closingBalanceMinor: z.string().meta({
      description:
        'The customer’s total owed as at `asOf`, cents-only (D-13). Ties to the PDF total.',
    }),
    downloadUrl: z.string().meta({
      description: 'A short-lived signed URL to the stored PDF, minted on read.',
    }),
    publicUrl: z.string().nullable().meta({
      description:
        'The customer-facing hosted-page link, present only when the statement was sent.',
    }),
    generatedByUserId: z.uuid(),
    generatedByName: z.string().nullable().meta({
      description: 'The author’s display name, or null if the user no longer resolves.',
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'CustomerStatement',
    description: 'A rendered customer statement and its artifact.',
  });

export type CustomerStatement = z.infer<typeof customerStatementSchema>;

/** The envelope convention: newest first, unpaginated in v1. Optionally one customer. */
export const customerStatementListSchema = z
  .strictObject({
    statements: z.array(customerStatementSchema),
  })
  .meta({
    id: 'CustomerStatementList',
    description: 'The org’s rendered customer statements, newest first.',
  });

export type CustomerStatementList = z.infer<typeof customerStatementListSchema>;
