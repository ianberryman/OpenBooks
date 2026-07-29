import { z } from 'zod';

import { calendarDateSchema } from '../wire';

/**
 * Payment terms (initiative I, Cash application; ROADMAP D-79, D-107).
 *
 * A term computes a document's due date from `netDays`, and — when it carries a
 * discount — the early-pay amount and its deadline from `discountRatePpm` and
 * `discountWindowDays`. **Simple** (net only, both discount fields null) and
 * **rich** (with a discount) are both supported; a term is never partially rich
 * (`chk_payment_terms_discount`, `0012_cash_application`).
 *
 * ## No `.meta({ id })` yet
 *
 * OB-135's own instruction, following every earlier module's rule
 * (`tax.ts`'s file header explains it at length): a `.meta({ id })` publishes a
 * `components.schemas` entry, and A10 fails the build on one nothing references.
 * The routes arrive with OB-139; the ids arrive in that diff.
 *
 * ## What is not here
 *
 * The service (OB-136: compute a due date and a discount window from a term, with
 * the contact-default-then-document-override resolution) and the routes (OB-139)
 * are later leaves. This file is the shape they will share, shipped now so those
 * leaves compose against a pinned contract rather than each inventing one.
 */

/**
 * Restated from `0002_ledger`'s convention for names: MySQL's `VARCHAR(n)` counts
 * characters and `String.length` counts UTF-16 code units, so the inequality runs
 * the safe way and a value this schema accepts cannot be truncated by the column.
 */
export const PAYMENT_TERM_NAME_MAX_LENGTH = 120;

const paymentTermNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PAYMENT_TERM_NAME_MAX_LENGTH)
  .meta({
    description:
      'What this term is called in the picker, e.g. "Net 30" or "2/10 Net 30". Unique within the ' +
      'org.',
  });

/**
 * Days from issue to due, the one figure a simple term needs.
 *
 * `INT UNSIGNED` in `payment_terms.net_days`, so zero (due on receipt) is
 * representable and a negative count is not — the schema mirrors that rather than
 * re-deriving a narrower bound nothing in the ledger asks for.
 */
const netDaysSchema = z.number().int().min(0).meta({
  description: 'Days from issue to due. Zero is "due on receipt".',
});

/**
 * `discountRatePpm`/`discountWindowDays` follow `tax_rates.rate_ppm`'s own
 * convention: an integer scaled by 1,000,000 rather than a percentage string, and
 * unlike `taxPercentageSchema` it is exposed as the raw ppm integer rather than
 * converted to a decimal percentage — there is no per-jurisdiction display rule for
 * a discount the way there is for a published tax rate, so the wire value is the
 * same integer the row stores.
 *
 * Nullable **together** (`.nullish()` on both, paired by the request/response
 * shapes below rather than by a cross-field refinement here): both null is a
 * simple term, and the database's own `chk_payment_terms_discount` is the
 * authority on "both or neither" — this file states the shape, not a second copy
 * of that rule.
 */
const discountRatePpmSchema = z
  .number()
  .int()
  .min(0)
  .meta({
    description:
      'The early-pay discount, in parts per million of the amount — 20000 is 2%. Null on a simple ' +
      'term. Paired with `discountWindowDays`: both null, or both set.',
  });

const discountWindowDaysSchema = z
  .number()
  .int()
  .min(0)
  .meta({
    description:
      'Days from issue in which the discount may be taken. Null on a simple term. Paired with ' +
      '`discountRatePpm`.',
  });

/**
 * A term as the API returns it.
 */
export const paymentTermSchema = z.strictObject({
  id: z.uuid(),
  name: paymentTermNameSchema,
  netDays: netDaysSchema,
  discountRatePpm: discountRatePpmSchema.nullable(),
  discountWindowDays: discountWindowDaysSchema.nullable(),
  isActive: z.boolean().meta({
    description:
      'An archived term stays on every document that used it and cannot be chosen for a new one ' +
      '— the only form of removal available to a term a contact or a document names.',
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type PaymentTerm = z.infer<typeof paymentTermSchema>;

/**
 * Creates a term. `discountRatePpm`/`discountWindowDays` are both supplied or both
 * omitted — a half-specified discount does not parse, the wire's own statement of
 * `chk_payment_terms_discount`.
 */
export const createPaymentTermRequestSchema = z
  .strictObject({
    name: paymentTermNameSchema,
    netDays: netDaysSchema,
    discountRatePpm: discountRatePpmSchema.optional(),
    discountWindowDays: discountWindowDaysSchema.optional(),
  })
  .refine(
    (input) => (input.discountRatePpm === undefined) === (input.discountWindowDays === undefined),
    {
      message: 'discountRatePpm and discountWindowDays are supplied together, or not at all.',
      path: ['discountWindowDays'],
    },
  );

export type CreatePaymentTermRequest = z.infer<typeof createPaymentTermRequestSchema>;

/**
 * A term computes: the due date, and — when it carries a discount — the amount
 * available within the window and the deadline to take it by.
 *
 * `discountAmountMinor`/`discountDeadline` are nullable together, on a simple
 * term or once a rich term's window has passed relative to the date the
 * computation was asked for. This is the shape OB-136's service returns and
 * OB-138's suggestion reads from — not a route response of its own.
 */
export const computedPaymentTermSchema = z.strictObject({
  dueDate: calendarDateSchema.meta({
    description: 'issueDate + netDays.',
  }),
  discountAmountMinor: z
    .string()
    .nullable()
    .meta({
      description:
        'The early-pay discount, in minor units, computed from discountRatePpm against the ' +
        'document total. Null on a simple term.',
    }),
  discountDeadline: calendarDateSchema.nullable().meta({
    description:
      'issueDate + discountWindowDays — the last day the discount may be taken. Null on a simple ' +
      'term.',
  }),
});

export type ComputedPaymentTerm = z.infer<typeof computedPaymentTermSchema>;

/**
 * A discount suggestion for one document within its window (D-79; for OB-138).
 *
 * A read/preview shape a workbench or money-in screen calls before the human
 * confirms it as a `discount` clearing entry (`clearing.ts`) — never written by
 * this file, never auto-posted (D-43).
 */
export const discountSuggestionSchema = z.strictObject({
  targetId: z.uuid(),
  discountAmountMinor: z.string(),
  deadline: calendarDateSchema,
  accountId: z.uuid().meta({
    description: "The org's nominated discount-given/received account this would post to.",
  }),
});

export type DiscountSuggestion = z.infer<typeof discountSuggestionSchema>;
