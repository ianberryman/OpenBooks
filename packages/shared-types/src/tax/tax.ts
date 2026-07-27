import { z } from 'zod';

import { MoneyParseError } from '../money';
import { pageCursorSchema, pageQueryShape } from '../wire';

import { TAX_RATE_PERCENT_DECIMALS, taxRateFromPercentString } from './rate';

/**
 * The tax-rate wire contract (OB-061, for OB-066; ROADMAP D-35).
 *
 * A rate is a named percentage posting to a nominated liability account, an org
 * holds a list of them, and a document line carries at most one. `rate.ts` next
 * door argues the representation; this file is the API shape.
 *
 * ## No `.meta({ id })` anywhere in M3's contracts, yet
 *
 * `jsonSchemaTransformObject` copies *every* schema carrying an `id` out of zod's
 * global registry into `components.schemas` whether or not a route references it,
 * and A10 makes drift in `openapi.json` a build failure. OB-067 builds the `/v1`
 * surface and adds the ids in the same diff as the routes that reference them —
 * the sequence OB-018/OB-023 established and OB-036/OB-045 repeated. Until then an
 * id here would publish a component nothing can reach.
 *
 * The list queries must never gain one even after OB-067: a querystring is emitted
 * as individual `parameters`, so a component for one would be referenced by nothing.
 */

/**
 * Restated from `0002_ledger`'s convention for names: MySQL's `VARCHAR(n)` counts
 * characters and `String.length` counts UTF-16 code units, so the inequality runs
 * the safe way and a value this schema accepts cannot be truncated by the column.
 */
export const TAX_RATE_NAME_MAX_LENGTH = 120;

/**
 * D-35's rate list, as a rate's own answer to "where may I be used".
 *
 * The field exists because a rate names *one* liability account, and an org that
 * reclaims input VAT posts sales tax and purchase tax to different accounts — so
 * "VAT 20%" is two rows for that org, and a bill's rate picker showing the sales
 * one is how a filing goes wrong. `both` is the ordinary case for a sales-tax
 * regime where nothing is reclaimed.
 */
export const TAX_RATE_APPLICABILITIES = ['sales', 'purchases', 'both'] as const;

export type TaxRateApplicability = (typeof TAX_RATE_APPLICABILITIES)[number];

/**
 * D-35's percentage as a JSON Schema `pattern`, so the published artifact states
 * the rule machine-readably. A *restatement* in the sense `MINOR_UNITS_WIRE_PATTERN`
 * uses: the authority is `taxRateFromPercentString`, which the refinement below
 * calls, so if the two ever disagree the artifact is imprecise rather than wrong.
 */
export const TAX_RATE_PERCENT_WIRE_PATTERN = '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,4})?$';

/**
 * A rate on the wire: a decimal percentage string, `"20"` or `"8.875"`.
 *
 * A string and not a JSON number for D-13's reason: a JSON number is an IEEE-754
 * double in every mainstream parser, so `7.1` arrives as 7.0999999999999996 and a
 * client that round-trips a rate reformats it. A *percentage* and not the internal
 * parts-per-million integer because a percentage is what the tax authority
 * publishes and what the user types — the coupling D-13 avoids for money (the
 * currency's exponent) has no analogue here.
 *
 * Validated by handing the value to the parser rather than by re-deriving its
 * rules, which is what makes `"08"`, `"20%"`, `"-5"`, `"0.00001"` and `"101"` all
 * refused with the parser's own message naming which of those they hit.
 *
 * No transform to `TaxRate`: the parsed value stays the string it was on the wire,
 * so the schema means the same thing in both io directions and the conversion is a
 * visible step in the service's argument mapping.
 */
export const taxPercentageSchema = z
  .string()
  .superRefine((value, ctx) => {
    try {
      taxRateFromPercentString(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message:
          error instanceof MoneyParseError
            ? error.message
            : 'Expected a percentage between 0 and 100.',
      });
    }
  })
  .meta({
    description:
      'A tax rate as a decimal percentage string: `"20"` is twenty percent. Between 0 and 100, ' +
      `with at most ${String(TAX_RATE_PERCENT_DECIMALS)} fraction digits — enough for every ` +
      'combined rate we know of, including `"8.875"`, which basis points cannot express. Never ' +
      'a JSON number, and never a fraction: `"0.2"` is a fifth of one percent.',
    pattern: TAX_RATE_PERCENT_WIRE_PATTERN,
    examples: ['20', '8.875', '0'],
  });

const taxRateNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TAX_RATE_NAME_MAX_LENGTH)
  .meta({
    description:
      'What this rate is called on a document and in the rate picker, e.g. `VAT 20%` or ' +
      '`NY Sales Tax`. Unique within the org, compared case- and accent-insensitively, so an ' +
      'org cannot hold two rates a user reads as the same one.',
  });

const taxRateApplicabilitySchema = z.enum(TAX_RATE_APPLICABILITIES).meta({
  description:
    'Which documents may use this rate. A rate posts to one account, so an org reclaiming input ' +
    'tax holds a sales rate and a purchases rate rather than one rate with two accounts.',
});

/**
 * A rate as the API returns it.
 *
 * `orgId` is absent for the reason `accountSchema` gives: every rate the caller can
 * reach belongs to the context's org, so the field would carry no information and
 * would be one more place a cross-org id could appear in a response.
 */
export const taxRateSchema = z.strictObject({
  id: z.uuid(),
  name: taxRateNameSchema,
  percentage: taxPercentageSchema,
  accountId: z.uuid().meta({
    description:
      'The liability account the tax posts to. Nominated per rate (D-35) rather than derived ' +
      'from a single org-wide tax account, because sales tax collected and purchase tax ' +
      'reclaimable are different balances that a return reports separately.',
  }),
  appliesTo: taxRateApplicabilitySchema,
  isActive: z.boolean().meta({
    description:
      'An archived rate stays on every document that used it and cannot be chosen for a new ' +
      'line. This is the only form of removal available to a rate a posted document names.',
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type TaxRateResponse = z.infer<typeof taxRateSchema>;

export const createTaxRateRequestSchema = z.strictObject({
  name: taxRateNameSchema,
  percentage: taxPercentageSchema,
  accountId: z.uuid(),
  appliesTo: taxRateApplicabilitySchema.optional(),
});

export type CreateTaxRateRequest = z.infer<typeof createTaxRateRequestSchema>;

/**
 * `percentage` is create-only, and that is the decision in this file worth arguing.
 *
 * The mechanical reason is reproducibility. A document's tax is computed per line
 * and rounded per line (D-35), the resulting journal is immutable (spec §2.2), and
 * the document keeps a pointer to the rate it used. Edit the percentage afterwards
 * and recomputing any historical document from its own lines yields a tax that
 * disagrees with the journal that was posted — the subledger and the ledger giving
 * two answers, which is exactly the divergence D-34 refuses to make possible.
 *
 * The accounting reason is that a rate change is not a correction. When a
 * jurisdiction moves VAT from 17.5% to 20%, both rates are true — of different
 * dates — and an org needs to issue a credit note against a 17.5% invoice long
 * after the change. One row that silently became 20% cannot express that; two rows
 * can, and "which rate was this invoiced at" stays answerable. Xero reaches the
 * same conclusion by locking a rate once it is used; locking it from the start is
 * the same rule without a state to check.
 *
 * `accountId` and `appliesTo` *are* mutable, and the contrast is the test of the
 * argument: neither restates a posted journal. Repointing a rate at a different
 * liability account changes where future tax posts and leaves every past posting
 * exactly where it was.
 */
export const updateTaxRateRequestSchema = z
  .strictObject({
    name: taxRateNameSchema.optional(),
    accountId: z.uuid().optional(),
    appliesTo: taxRateApplicabilitySchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    description:
      'Partial update. `percentage` is immutable — a rate that changed would restate the tax on ' +
      'documents already posted at the old one, so a new percentage is a new rate. `isActive` ' +
      'is not here either: archiving is its own operation.',
  });

export type UpdateTaxRateRequest = z.infer<typeof updateTaxRateRequestSchema>;

/**
 * `isActive` and `appliesTo` are real values and not query-string flags, for the
 * reason `listAccountsQuerySchema` gives: a shared schema that accepted `'false'`
 * would accept it from a JSON body too, and `'false'` is truthy in every language
 * an integrator might use. Coercing a querystring is the route's job (OB-067).
 */
export const listTaxRatesQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
  appliesTo: taxRateApplicabilitySchema.optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListTaxRatesQuery = z.input<typeof listTaxRatesQuerySchema>;

/**
 * Ordered by `(created_at, id)`, not by name.
 *
 * The contact list's argument, and it applies with less debate here: `name` is
 * mutable, a keyset over a mutable column silently drops the rows that moved behind
 * the cursor, and a rate list is short enough that a client sorts what it holds. The
 * immutable alternative D-27 used for account codes is not available — a rate has no
 * code, and giving it one to make paging convenient would be inventing a reference
 * nothing cites.
 */
export const taxRatePageSchema = z.strictObject({
  items: z.array(taxRateSchema),
  nextCursor: pageCursorSchema.nullable(),
});

export type TaxRatePage = z.infer<typeof taxRatePageSchema>;
