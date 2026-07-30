import { z } from 'zod';

import { calendarDateSchema, pageQueryShape } from '../wire';

import {
  DOCUMENT_MAX_LINES,
  documentDateRangeShape,
  documentLineInputSchema,
  documentMemoSchema,
  documentReferenceSchema,
  documentStatusSchema,
  isOrderedRange,
  taxModeSchema,
} from '../subledger/documents';
import type { Bill, BillPage, BillSummary } from '../subledger/bills';

/**
 * Expenses (initiative M, OB-177; ROADMAP D-M2).
 *
 * An employee expense **is** an `ap_documents` bill whose contact carries
 * `isEmployee` (D-M2) — not a fourth document type, and not a new table. The
 * service that creates one clones `bills.service.ts` with two swaps only
 * (`requireVendor` → `requireEmployee`, `bills.*` → `expenses.*` permissions),
 * and the entire posting path — `approveDocument`, `journalSides`,
 * `toPostJournalInput` — is `createBill`'s own, reused verbatim.
 *
 * Because the resource is a bill, the *responses* are `Bill`/`BillSummary`/
 * `BillPage` under different names rather than under different shapes: an
 * `expenseSchema` that duplicated `billSchema`'s body field for field would be
 * a second definition of the same document, and the first one to drift would
 * be the one nobody remembers to update. Only the *requests* get their own
 * schema, because `CreateExpenseRequest` and `CreateBillRequest` are two
 * routes that must be free to diverge later (an expense growing a
 * receipt-attachment field the vendor side never needs, say) even though they
 * are identical today.
 */

export type Expense = Bill;
export type ExpenseSummary = BillSummary;
export type ExpensePage = BillPage;

/**
 * Creates a draft expense. The same shape as `createBillRequestSchema`,
 * because entering an employee's expense is entering a bill (D-M2) — the
 * contact is simply one the service requires to carry `isEmployee` rather than
 * `isVendor` (`requireEmployee`, the mirror of `requireVendor`).
 */
export const createExpenseRequestSchema = z
  .strictObject({
    contactId: z.uuid().meta({ description: 'The employee this expense reimburses.' }),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema.optional(),
    paymentTermId: z
      .uuid()
      .optional()
      .meta({
        description:
          'Overrides the employee’s default payment term for this expense, exactly as ' +
          '`CreateBillRequest.paymentTermId` does for a vendor. Create-only.',
      }),
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateExpenseRequest',
    description:
      'Creates a **draft** expense — a bill whose contact is an employee (D-M2). Reimbursement ' +
      'is Pay Bills settling this same document once approved; there is no separate ' +
      'reimbursement request.',
  });

export type CreateExpenseRequest = z.infer<typeof createExpenseRequestSchema>;

/**
 * Partial update of a **draft** expense, mirroring `updateBillRequestSchema`
 * field for field.
 */
export const updateExpenseRequestSchema = z
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
    id: 'UpdateExpenseRequest',
    description:
      'Partial update of a draft. `lines` replaces the whole set. An approved expense accepts ' +
      'none of this, for the reason `UpdateBillRequest` gives: the correction is a vendor credit ' +
      'or a void, never an edit (D-38).',
  });

export type UpdateExpenseRequest = z.infer<typeof updateExpenseRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 *
 * `listBillsQuerySchema`'s shape without `reference`: chasing "have we already
 * entered this one" by the vendor's own invoice number is D-36's argument for
 * keeping that filter on the bill list, and it does not carry over to an
 * expense, which has no third party issuing a number to key on.
 */
export const listExpensesQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...documentDateRangeShape,
    contactId: z.uuid().optional(),
    status: documentStatusSchema.optional(),
    dueBefore: calendarDateSchema.optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

export type ListExpensesQuery = z.input<typeof listExpensesQuerySchema>;
