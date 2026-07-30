import { z } from 'zod';

import { JOURNAL_SIDES } from '../journals';
import { calendarDateSchema, minorUnitsSchema, pageQueryShape } from '../wire';

/**
 * Recurring journal templates (initiative L, OB-162; ROADMAP D-90, D-113…D-117, for
 * `0014_fixed_assets`).
 *
 * A GL template is `recurringInvoiceTemplateSchema`'s sibling with the pricing removed:
 * a journal line is already a posting instruction (`{ accountId, side, amount }` — what
 * `JournalLineInput` takes), so it is stored and posted verbatim, never re-priced. The
 * two rules a template must satisfy are checked here so an unusable one cannot save: at
 * least two lines, and debits equal credits exactly — the same balance the ledger kernel
 * would refuse each cycle, refused once at authoring instead.
 *
 * `startDate` is create-only, `recurring.ts`'s reasoning exactly: it seeds `nextRunDate`
 * and is not itself a column, so it never reappears on the response.
 */

export const RECURRING_JOURNAL_MATERIALIZATION_MODES = ['draft', 'posted'] as const;
export type RecurringJournalMaterializationMode =
  (typeof RECURRING_JOURNAL_MATERIALIZATION_MODES)[number];

export const recurringJournalMaterializationModeSchema = z
  .enum(RECURRING_JOURNAL_MATERIALIZATION_MODES)
  .meta({
    description:
      'What a cycle does with the journal it materialises (D-76). `posted` posts it directly ' +
      'under the org’s automation actor, so provenance lands on the journal. `draft` lands an ' +
      'editable journal draft (M2) for a human to post.',
  });

export const RECURRING_JOURNAL_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type RecurringJournalFrequency = (typeof RECURRING_JOURNAL_FREQUENCIES)[number];

export const recurringJournalFrequencySchema = z.enum(RECURRING_JOURNAL_FREQUENCIES).meta({
  description:
    'How often the template cycles, combined with `intervalCount` — the same vocabulary a ' +
    'recurring invoice uses, so a business reads one cadence across both.',
});

const recurringJournalNameSchema = z.string().trim().min(1).max(255);
const recurringJournalMemoSchema = z.string().trim().max(512);
const recurringJournalLineDescriptionSchema = z.string().trim().min(1).max(512);

const recurringJournalSideSchema = z.enum(JOURNAL_SIDES).meta({
  description:
    'Which side of the ledger this line moves. The side carries the sign, so `amount` is always ' +
    'positive — a negative credit is a caller that has confused the two models.',
});

/**
 * One line of a template — a posting instruction, stored and posted verbatim.
 *
 * Dimensions are deliberately absent (D-90's fixed-line scope): a recurring GL template
 * is fixed accounts and fixed amounts. `contactId` is the counterparty a line may name,
 * a `journal_lines` column, so it belongs on the line rather than as a later annotation.
 */
export const recurringJournalLineSchema = z
  .strictObject({
    accountId: z.uuid().meta({ description: 'The account this line posts to each cycle.' }),
    side: recurringJournalSideSchema,
    amount: minorUnitsSchema.meta({
      description: 'The line’s amount in minor units, always positive — `side` carries the sign.',
    }),
    contactId: z.uuid().nullish().meta({
      description: 'The counterparty this line is with, or null. A `journal_lines` column (OB-059).',
    }),
    description: recurringJournalLineDescriptionSchema.nullish().meta({
      description: 'What the line is for, carried onto the journal line’s memo each cycle.',
    }),
  })
  .meta({
    description:
      'One posting instruction of a recurring journal template: an account, a side, and a ' +
      'positive amount, posted verbatim each cycle (D-90).',
  });

export type RecurringJournalLine = z.infer<typeof recurringJournalLineSchema>;

/**
 * Debits equal credits, and at least two lines — the ledger kernel's own two rules,
 * checked here so a template that could never post cannot be saved. Summed as `bigint`
 * over the cents strings, because `minorUnitsSchema` is a minor-units string and adding
 * them as numbers is the float this whole system exists to keep out (D-13).
 */
function assertBalancedLines(lines: readonly RecurringJournalLine[], ctx: z.RefinementCtx): void {
  if (lines.length < 2) {
    ctx.addIssue({
      code: 'custom',
      message: 'A journal needs at least two lines.',
      path: ['lines'],
    });
    return;
  }
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    if (line.side === 'debit') debit += BigInt(line.amount);
    else credit += BigInt(line.amount);
  }
  if (debit !== credit) {
    ctx.addIssue({
      code: 'custom',
      message: 'Debits must equal credits exactly.',
      path: ['lines'],
    });
  }
}

const recurringJournalCreateShape = {
  name: recurringJournalNameSchema.meta({
    description: 'The template’s own label — what an operator picks it out by.',
  }),
  memo: recurringJournalMemoSchema.nullish().meta({
    description: 'A memo carried onto each cycle’s journal header. Null or absent for none.',
  }),
  materializationMode: recurringJournalMaterializationModeSchema,
  frequency: recurringJournalFrequencySchema,
  intervalCount: z.int().min(1).default(1).meta({
    description: 'How many `frequency` units between cycles. `1` is every cycle; `3` is every third.',
  }),
  endDate: calendarDateSchema.nullish().meta({
    description: 'The last date a cycle may fire. Null is open-ended.',
  }),
  lines: z.array(recurringJournalLineSchema),
};

export const createRecurringJournalTemplateRequestSchema = z
  .strictObject({
    ...recurringJournalCreateShape,
    startDate: calendarDateSchema.meta({
      description:
        'The first run date. Seeds `nextRunDate`; not itself a stored field, so it never appears ' +
        'on the response.',
    }),
  })
  .superRefine((value, ctx) => assertBalancedLines(value.lines, ctx));

export type CreateRecurringJournalTemplateRequest = z.infer<
  typeof createRecurringJournalTemplateRequestSchema
>;

/**
 * Partial update; `lines`, when present, replaces the whole set and must itself balance —
 * `updateRecurringInvoiceTemplateRequestSchema`'s reasoning. `isActive` is the by-hand
 * retire/reinstate; the engine clears it automatically once `nextRunDate` passes `endDate`.
 */
export const updateRecurringJournalTemplateRequestSchema = z
  .strictObject({
    name: recurringJournalNameSchema.optional(),
    memo: recurringJournalMemoSchema.nullish(),
    materializationMode: recurringJournalMaterializationModeSchema.optional(),
    frequency: recurringJournalFrequencySchema.optional(),
    intervalCount: z.int().min(1).optional(),
    endDate: calendarDateSchema.nullish(),
    lines: z.array(recurringJournalLineSchema).optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.lines !== undefined) assertBalancedLines(value.lines, ctx);
    if (!Object.values(value).some((field) => field !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Supply at least one field to change.' });
    }
  });

export type UpdateRecurringJournalTemplateRequest = z.infer<
  typeof updateRecurringJournalTemplateRequestSchema
>;

export const recurringJournalTemplateSchema = z.strictObject({
  id: z.uuid(),
  name: recurringJournalNameSchema,
  memo: z.string().nullable(),
  materializationMode: recurringJournalMaterializationModeSchema,
  frequency: recurringJournalFrequencySchema,
  intervalCount: z.int().min(1),
  nextRunDate: calendarDateSchema.meta({
    description:
      'The next date a cycle fires. Each cycle materialises the journal and advances this by ' +
      '`frequency` × `intervalCount`.',
  }),
  lastRunDate: calendarDateSchema.nullable().meta({
    description:
      'The date of the most recently materialised cycle, or null before the first. The ' +
      'once-per-cycle guard (D-76).',
  }),
  endDate: calendarDateSchema.nullable(),
  isActive: z.boolean(),
  lines: z.array(recurringJournalLineSchema),
});

export type RecurringJournalTemplate = z.infer<typeof recurringJournalTemplateSchema>;

export const listRecurringJournalTemplatesQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
});

export type ListRecurringJournalTemplatesQuery = z.input<
  typeof listRecurringJournalTemplatesQuerySchema
>;

// The keyset page schema (`pageSchema(...)`) carries a `.meta({ id })` and so enters
// `components.schemas`; it is added with the `/v1` routes in OB-167 (Wave 2), when the
// OpenAPI artifact is regenerated in the same change — see this package's index header.
