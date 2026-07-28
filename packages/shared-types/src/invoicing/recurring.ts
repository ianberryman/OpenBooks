import { z } from 'zod';

import {
  DOCUMENT_LINE_DESCRIPTION_MAX_LENGTH,
  documentMemoSchema,
  quantitySchema,
  taxModeSchema,
} from '../subledger/documents';
import { calendarDateSchema, minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

/**
 * Recurring invoice templates (OB-128; ROADMAP D-75, D-76, for `0008_recurring_dunning`).
 *
 * A template is not a document — it is the input to `createInvoice`, run again each
 * cycle. `recurring.repository.ts` mirrors `ar_document_lines`' input columns for the
 * reason the migration's header gives: storing the computed amounts here would be a
 * second pricing that the first edit of a tax rate would falsify. `recurringInvoiceLineSchema`
 * therefore restates `documentLineInputSchema`'s inputs and nothing it computes.
 *
 * `startDate` is create-only: it seeds `next_run_date` and is not itself a column, so it
 * does not reappear on the response. What a client reads back instead is `nextRunDate` —
 * the schedule's live pointer — and `lastRunDate`, the once-per-cycle guard (D-76).
 */

export const RECURRING_MATERIALIZATION_MODES = ['draft', 'approved'] as const;
export type RecurringMaterializationMode = (typeof RECURRING_MATERIALIZATION_MODES)[number];

export const recurringMaterializationModeSchema = z.enum(RECURRING_MATERIALIZATION_MODES).meta({
  description:
    'What a cycle does with the invoice it materialises (D-76). `approved` posts the journal ' +
    'and allocates the number through the same `approveInvoice` path a human uses, unattended, ' +
    'via a system/automation actor so provenance still lands on the journal. `draft` lands an ' +
    'editable draft for a human to review.',
});

export const RECURRING_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const recurringFrequencySchema = z.enum(RECURRING_FREQUENCIES).meta({
  description:
    'How often the template cycles. Combined with `intervalCount` — `frequency: "monthly", ' +
    'intervalCount: 3` is quarterly by another name, spelled the way the template’s author ' +
    'meant it.',
});

const recurringTemplateNameSchema = z.string().trim().min(1).max(255);

const recurringLineDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(DOCUMENT_LINE_DESCRIPTION_MAX_LENGTH)
  .nullish()
  .meta({
    description:
      'What the line is for. Nullable, unlike an invoice line’s own (`documentLineInputSchema` ' +
      'requires one): a template line is not yet a document line, and a template author may ' +
      'leave this for the cycle to fall back on.',
  });

/**
 * One line of a template — the input columns `ar_document_lines` and
 * `recurring_invoice_template_lines` share, and nothing either of them computes.
 */
export const recurringInvoiceLineSchema = z
  .strictObject({
    description: recurringLineDescriptionSchema,
    quantity: quantitySchema,
    unitAmount: minorUnitsSchema.meta({
      description:
        'The price of one unit, in minor units. Tax-inclusive exactly when the template’s ' +
        '`taxMode` is `inclusive`, restated each cycle against the lines it prices.',
    }),
    accountId: z.uuid().meta({
      description: 'The income account this line credits on the invoice each cycle materialises.',
    }),
    taxRateId: z.uuid().nullish().meta({
      description: 'The single rate this line is taxed at. Absent or null means no tax.',
    }),
  })
  .meta({
    id: 'RecurringInvoiceLine',
    description:
      'One line of a recurring template: the inputs `createInvoice` reprices each cycle, and ' +
      'none of what it computes — a template is not a posted document (D-35).',
  });

export type RecurringInvoiceLine = z.infer<typeof recurringInvoiceLineSchema>;

const recurringTemplateCreateShape = {
  contactId: z.uuid().meta({ description: 'The customer each cycle’s invoice is raised to.' }),
  name: recurringTemplateNameSchema.meta({
    description: 'The template’s own label — what an operator picks it out by, not a line.',
  }),
  materializationMode: recurringMaterializationModeSchema,
  taxMode: taxModeSchema,
  frequency: recurringFrequencySchema,
  intervalCount: z.int().min(1).default(1).meta({
    description:
      'How many `frequency` units between cycles. `1` is every cycle; `3` is every third.',
  }),
  dueDays: z.int().min(0).default(0).meta({
    description:
      'The net term each cycle applies: `dueDate = issueDate + dueDays`. There is no ' +
      'payment-terms model yet (ROADMAP), so the template names the offset itself.',
  }),
  memo: documentMemoSchema.nullish(),
  endDate: calendarDateSchema.nullish().meta({
    description: 'The last date a cycle may fire. Null is open-ended.',
  }),
  lines: z.array(recurringInvoiceLineSchema).min(1),
};

export const createRecurringInvoiceTemplateRequestSchema = z
  .strictObject({
    ...recurringTemplateCreateShape,
    startDate: calendarDateSchema.meta({
      description:
        'The first run date. Seeds `nextRunDate`; not itself a stored field, so it never appears ' +
        'on the response — `nextRunDate` is the schedule’s live pointer from here on.',
    }),
  })
  .meta({
    id: 'CreateRecurringInvoiceTemplateRequest',
    description:
      'Creates a recurring invoice template: a customer, a schedule, and how to raise the ' +
      'invoice each cycle (D-75, D-76). `startDate` seeds `nextRunDate` and is not stored as ' +
      'its own field.',
  });

export type CreateRecurringInvoiceTemplateRequest = z.infer<
  typeof createRecurringInvoiceTemplateRequestSchema
>;

/**
 * Partial update; `lines`, when present, replaces the whole set — `updateInvoiceRequestSchema`'s
 * reason applied to a template: the client holds the current state of every line, and patching
 * would need stable line identities across an edit that inserts one in the middle.
 *
 * `isActive` lives only here. A template starts active by construction (there being no reason
 * to create an inactive one), and the engine itself clears it when a cycle finds `next_run_date`
 * past `endDate` — so the only way a client sets it is to retire or reinstate a template by hand.
 */
export const updateRecurringInvoiceTemplateRequestSchema = z
  .strictObject({
    contactId: recurringTemplateCreateShape.contactId.optional(),
    name: recurringTemplateNameSchema.optional(),
    materializationMode: recurringMaterializationModeSchema.optional(),
    taxMode: taxModeSchema.optional(),
    frequency: recurringFrequencySchema.optional(),
    intervalCount: z.int().min(1).optional(),
    dueDays: z.int().min(0).optional(),
    memo: documentMemoSchema.nullish(),
    endDate: calendarDateSchema.nullish(),
    lines: z.array(recurringInvoiceLineSchema).min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateRecurringInvoiceTemplateRequest',
    description:
      'Partial update of a template. An absent field is unchanged, `null` clears a nullable ' +
      'one, and `lines` replaces the whole set. Changing the schedule reaches only the *next* ' +
      'cycle — a cycle already materialised is an ordinary invoice from here on.',
  });

export type UpdateRecurringInvoiceTemplateRequest = z.infer<
  typeof updateRecurringInvoiceTemplateRequestSchema
>;

export const recurringInvoiceTemplateSchema = z
  .strictObject({
    id: z.uuid(),
    contactId: recurringTemplateCreateShape.contactId,
    name: recurringTemplateNameSchema,
    materializationMode: recurringMaterializationModeSchema,
    taxMode: taxModeSchema,
    frequency: recurringFrequencySchema,
    intervalCount: z.int().min(1),
    dueDays: z.int().min(0),
    memo: z.string().nullable(),
    nextRunDate: calendarDateSchema.meta({
      description:
        'The next date a cycle fires. Each cycle materialises the invoice and advances this by ' +
        '`frequency` × `intervalCount` (D-75’s daily tick is what notices it has arrived).',
    }),
    lastRunDate: calendarDateSchema.nullable().meta({
      description:
        'The date of the most recently materialised cycle, or null before the first one. The ' +
        'once-per-cycle guard (D-76): a template already run for a date is not run again, so a ' +
        'restart mid-tick cannot double-raise.',
    }),
    endDate: calendarDateSchema.nullable(),
    isActive: z.boolean().meta({
      description:
        'Whether the engine still runs this template. Cleared automatically once `nextRunDate` ' +
        'would fall after `endDate`, and settable by hand through the update request.',
    }),
    lines: z.array(recurringInvoiceLineSchema),
  })
  .meta({
    id: 'RecurringInvoiceTemplate',
    description:
      'A recurring invoice template: a customer, a schedule, and how to raise the invoice each ' +
      'cycle (D-75, D-76). `nextRunDate` and `lastRunDate` are the schedule state the engine ' +
      'reads and advances; `startDate` from the create request is not a field here — it seeded ' +
      '`nextRunDate` once and is gone.',
  });

export type RecurringInvoiceTemplate = z.infer<typeof recurringInvoiceTemplateSchema>;

export const listRecurringInvoiceTemplatesQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListRecurringInvoiceTemplatesQuery = z.input<
  typeof listRecurringInvoiceTemplatesQuerySchema
>;

/**
 * Ordered `(created_at, id)`, `contactPageSchema`'s reasoning: a template's mutable
 * fields (`name`, `nextRunDate`) are exactly the ones a keyset must not sort on, on
 * pain of a page silently dropping a row that moved behind the cursor.
 */
export const recurringInvoiceTemplatePageSchema = pageSchema(recurringInvoiceTemplateSchema, {
  id: 'RecurringInvoiceTemplatePage',
  description: 'One page of recurring invoice templates, oldest first by creation.',
});

export type RecurringInvoiceTemplatePage = z.infer<typeof recurringInvoiceTemplatePageSchema>;
