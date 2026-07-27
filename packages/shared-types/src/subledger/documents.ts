import { z } from 'zod';

import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { MoneyParseError } from '../money';
import { QUANTITY_DECIMALS, TAX_MODES, quantityFromString } from '../tax';
import { calendarDateSchema, minorUnitsSchema, pageCursorSchema } from '../wire';

/**
 * The vocabulary every M3 document shares (OB-061; ROADMAP D-34, D-35, D-36, D-38).
 *
 * Four documents arrive in M3 — invoice, credit note, bill, vendor credit — and
 * they are the same shape pointed in different directions. This file holds the
 * pieces they share, for the reason `pagination.ts` holds one page envelope: five
 * services fan out in wave 1, and a line, a total and a settlement that meant
 * subtly different things per document would give the generated client four
 * unrelated types for one idea and give a screen four ways to be wrong.
 *
 * ## Nothing here carries `.meta({ id })`
 *
 * The transform lifts every schema carrying an `id` out of zod's global registry
 * into `components.schemas` whether or not a route references it, and A10 makes
 * drift in `openapi.json` a build failure. OB-067 builds `/v1` and adds the ids in
 * the same diff as the routes — the sequence OB-018/OB-023 established. The list
 * queries must never gain one: a querystring is emitted as individual `parameters`.
 *
 * ## Nothing here is a balance, and nothing here is a stored status
 *
 * D-34: a subledger holds no balance. What is outstanding on a document is its
 * total minus the allocations applied to it, computed on read, exactly as the trial
 * balance is computed from journal lines rather than from a cache. D-38 applies the
 * same rule to status: part-paid and paid are derived from allocations.
 * `documentSettlementSchema` and `documentStatusSchema` are therefore *computed*
 * fields, and their descriptions say so — a client reading them as columns would
 * eventually build a screen that writes one back.
 */

/**
 * Column widths, restated in the register `accounts.ts` set: MySQL's `VARCHAR(n)`
 * counts characters and `String.length` counts UTF-16 code units, so the inequality
 * runs the safe way and a value these schemas accept cannot be truncated by the
 * column that stores it.
 */
export const DOCUMENT_REFERENCE_MAX_LENGTH = 120;
export const DOCUMENT_MEMO_MAX_LENGTH = 512;
export const DOCUMENT_LINE_DESCRIPTION_MAX_LENGTH = 512;

/**
 * The upper bound on lines in one document, from a `SMALLINT UNSIGNED` line number.
 *
 * The column's own limit rather than a smaller "reasonable" number, following
 * `DRAFT_MAX_LINES` and the argument at `MAX_LINES` in `posting.service.ts`: the
 * column bound is a correctness constraint, and a lower business limit would be
 * product policy invented in a schema file.
 */
export const DOCUMENT_MAX_LINES = 65_535;

/**
 * The four documents M3 adds, each with its own gapless per-org sequence (D-36).
 *
 * One list rather than an AR list and an AP list, because allocation is a single
 * mechanism across all of them (D-39) and a report that names a document has to be
 * able to name any of them.
 */
export const SUBLEDGER_DOCUMENT_TYPES = [
  'invoice',
  'credit_note',
  'bill',
  'vendor_credit',
] as const;

export type SubledgerDocumentType = (typeof SUBLEDGER_DOCUMENT_TYPES)[number];

export const subledgerDocumentTypeSchema = z.enum(SUBLEDGER_DOCUMENT_TYPES);

/**
 * D-35's declaration, and the field that decides what `unitAmount` *means*.
 *
 * On the wire this is the only thing distinguishing `unitAmount: "10000"` at 20%
 * meaning "$100.00 plus $20.00 of tax" from "$100.00 of which $16.67 is tax". It
 * lives on the document and never on a line: a document whose lines disagreed about
 * whether prices include tax is a document nobody can total, and C5 — both entry
 * modes of the same economic invoice posting identical journals — is a statement
 * about one flag per document.
 */
export const taxModeSchema = z.enum(TAX_MODES).meta({
  description:
    'Whether `unitAmount` on every line already includes tax. `exclusive` adds the line’s tax ' +
    'to its extended amount; `inclusive` extracts it from within. Both produce the same journal ' +
    'for the same economic document — see the tax module for the arithmetic and for the one ' +
    'case (a fractional quantity whose inclusive unit price is not a whole number of cents) ' +
    'where the two entries are not the same document.',
});

/**
 * Quantity on the wire: a decimal string, `"1"`, `"0.25"`, `"-3.5"`.
 *
 * A string rather than a JSON number for D-13's reason applied to a multiplier
 * instead of to an amount, and the case for it is stronger than for money: a
 * quantity is *multiplied* by a price, so a parser that turns `0.1` into
 * 0.1000000000000000055 scales its error by the price before anyone sees it.
 *
 * Validated by handing the value to `quantityFromString`, which is the authority,
 * so `"01"`, `"1."`, `"1e3"` and a fifth decimal are refused with its own message.
 * Negative is accepted here because a negative line is how a discount or a returned
 * item is written; whether the *document* may total negative is a service question
 * with a different answer (D-39: a negative invoice is a credit note).
 */
export const quantitySchema = z
  .string()
  .superRefine((value, ctx) => {
    try {
      quantityFromString(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message:
          error instanceof MoneyParseError
            ? error.message
            : 'Expected a decimal quantity with at most four fraction digits.',
      });
    }
  })
  .meta({
    description:
      `How many units this line is for, with at most ${String(QUANTITY_DECIMALS)} fraction ` +
      'digits. A string and not a JSON number: a quantity multiplies a price, so a parser’s ' +
      'rounding error arrives scaled. Negative is allowed — that is a discount or a return line.',
    pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,4})?$',
    examples: ['1', '0.25', '-2'],
  });

/**
 * A document's state, **computed on read and never stored** (D-38).
 *
 * The transitions D-38 names, and where each one is read from:
 *
 * - `draft` — no journal has been posted. The document is editable and discardable
 *   exactly as a journal draft is (D-19).
 * - `approved` — the posting journal exists and nothing has been applied. This is
 *   the irreversible step: after it, the ledger has been told.
 * - `part_paid` / `paid` — derived by comparing the document's total against the
 *   allocations applied to it. Storing these is what D-38 refuses, because a stored
 *   status is a second source of truth that drifts the first time an allocation is
 *   voided.
 * - `void` — a reversing journal exists (D-16, D-38). The document stays visible
 *   with its number; a voided document that vanished would make the gapless
 *   sequence a lie.
 *
 * `paid` reads oddly on a credit note or a vendor credit, and it is the same fact:
 * the document has been fully applied and nothing of it remains available. One
 * enum rather than two is what lets a list screen sort a mixed page.
 */
export const DOCUMENT_STATUSES = ['draft', 'approved', 'part_paid', 'paid', 'void'] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documentStatusSchema = z.enum(DOCUMENT_STATUSES).meta({
  description:
    'Computed, never stored (D-38). `draft` until a journal is posted, `approved` once it is, ' +
    '`part_paid`/`paid` derived by comparing the total against the allocations applied, and ' +
    '`void` once a reversing journal exists. Not a field a client may write.',
});

/**
 * The org's own number for the document (D-36), or `null` while it is a draft.
 *
 * Null before approval and not "reserved at creation", for D-14's reason carried
 * over: a number handed to a draft that is then discarded leaves a gap, and a gap in
 * a document sequence is indistinguishable from a deleted document — precisely the
 * ambiguity an append-only system must never be ambiguous about.
 *
 * A string rather than a JSON number because it is allocated from a `BIGINT` counter
 * row, and because a document number is a *label*: an org that prefixes its
 * invoices reads `INV-000124`, not 124.
 */
export const documentNumberSchema = z.string().meta({
  description:
    'The org’s own gapless number for this document, unique per org and per document type ' +
    '(D-36). Null until the document is approved — a number reserved by a draft that was then ' +
    'discarded would leave a gap, and a gap is indistinguishable from a deletion.',
});

/**
 * The free-text reference, which is a different field for a different job (D-36).
 *
 * On an invoice it holds the customer's purchase-order number. On a **bill it holds
 * the vendor's own invoice number**, which is the number that matters on an AP
 * document — we did not issue it, and our sequence number is only our internal
 * handle. Each document's own schema restates which of the two it means.
 */
export const documentReferenceSchema = z.string().trim().min(1).max(DOCUMENT_REFERENCE_MAX_LENGTH);

export const documentMemoSchema = z.string().trim().max(DOCUMENT_MEMO_MAX_LENGTH).meta({
  description: 'Free text carried on the document and onto its journal. Send `null` to clear it.',
});

const lineDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(DOCUMENT_LINE_DESCRIPTION_MAX_LENGTH)
  .meta({ description: 'What the line is for. This is what prints on the document.' });

/**
 * The tags a document line carries, named by value and never by axis — the shape
 * `setJournalLineDimensionsRequestSchema` and `draftLineInputSchema` both use, for
 * the reason stated there: a value belongs to exactly one axis, so naming the pair
 * would make a mismatched `(axis, value)` expressible rather than unrepresentable.
 *
 * Present on a document line because the line becomes a journal line at approval,
 * and a document that dropped its tags would report under "unassigned" on every
 * sliced report (D-18) with no way to fix it — the journal is immutable, and
 * retagging is a separate surface (D-32).
 */
const lineDimensionValueIdsSchema = z
  .array(z.uuid())
  .max(MAX_DIMENSIONS_PER_ORG)
  .meta({
    description:
      'Every dimension value this line carries. A value names its own axis; an omitted axis is ' +
      'untagged. Carried onto the journal line the document posts.',
  });

/**
 * One line as a client sends it.
 *
 * `taxRateId` is optional and its absence means *no tax*, not a default rate. A
 * default would be a rate nobody chose appearing on a filing, and D-35 gives a line
 * at most one rate — so "which one" has to be answered by the caller or not at all.
 *
 * There is no `amount`: the line's money is `quantity × unitAmount`, computed by the
 * service through the shared primitive. Accepting a total alongside its factors
 * would make a line that contradicts itself expressible, and then the service would
 * have to decide which of the three numbers the client meant.
 */
export const documentLineInputSchema = z.strictObject({
  description: lineDescriptionSchema,
  quantity: quantitySchema,
  unitAmount: minorUnitsSchema.meta({
    description:
      'The price of one unit, in minor units. Tax-inclusive exactly when the document’s ' +
      '`taxMode` is `inclusive`; that flag is what gives this field its meaning.',
  }),
  accountId: z.uuid().meta({
    description:
      'The income account this line credits on an invoice, or the expense or asset account it ' +
      'debits on a bill. The tax, if any, posts to the rate’s own account instead.',
  }),
  taxRateId: z
    .uuid()
    .nullish()
    .meta({
      description:
        'The single rate this line is taxed at (D-35). Absent or null means no tax — there is no ' +
        'default rate, because a rate nobody chose is a rate that ends up on a filing.',
    }),
  dimensionValueIds: lineDimensionValueIdsSchema.optional(),
});

export type DocumentLineInput = z.infer<typeof documentLineInputSchema>;

/**
 * A percentage on a *line* is nullable, unlike a rate's own, so it is spelled here
 * rather than imported from the tax module: an untaxed line has no rate and
 * therefore no percentage, and `"0"` would say something different — that a
 * zero-rated rate was chosen, which a VAT return reports separately from a line
 * that is out of scope entirely.
 */
const linePercentageSchema = z
  .string()
  .nullable()
  .meta({
    description:
      'The percentage the line was taxed at, as it stood when the document was priced. Null ' +
      'when the line carries no rate, which is not the same as a zero-rated one.',
  });

/**
 * One line as the API returns it: what was entered, and what the arithmetic made
 * of it.
 *
 * The three amounts are **computed per line and rounded per line** (D-35), by the
 * one implementation in `tax/compute.ts`, and they are returned rather than left to
 * the client because a client that recomputed them would be a fourth implementation
 * of the rounding rule — and the first one to disagree would disagree on a printed
 * invoice.
 *
 * `netAmount + taxAmount === grossAmount` holds exactly on every line, and the
 * document's totals are the sums of these, never the rate applied to a sum.
 *
 * `taxRatePercentage` rides along beside `taxRateId` because a document has to be
 * printable as it stood: a rate is archived rather than deleted, so the id always
 * resolves, but printing "20%" from the rate list would print today's list against
 * a document posted under a different one (see `updateTaxRateRequestSchema` for why
 * a percentage never changes under a document).
 */
export const documentLineSchema = z.strictObject({
  lineId: z.string().meta({
    description:
      'A `BIGINT` line identifier, stringified for the reason money is: a JSON number cannot ' +
      'carry one past 2^53 (D-13’s argument applied to an identifier).',
  }),
  lineNumber: z.int(),
  description: z.string(),
  quantity: quantitySchema,
  unitAmount: minorUnitsSchema,
  accountId: z.uuid(),
  taxRateId: z.uuid().nullable(),
  taxRatePercentage: linePercentageSchema,
  netAmount: minorUnitsSchema.meta({
    description:
      'What posts to `accountId`. The extended amount, less tax when the mode is inclusive.',
  }),
  taxAmount: minorUnitsSchema.meta({
    description:
      'What posts to the rate’s liability account. Rounded once, here, at the line — the ' +
      'document’s tax is the sum of these and never the rate applied to the document total.',
  }),
  grossAmount: minorUnitsSchema.meta({
    description: '`netAmount + taxAmount`, exactly. What this line adds to what is owed.',
  }),
  dimensionValueIds: z.array(z.uuid()),
});

export type DocumentLine = z.infer<typeof documentLineSchema>;

/**
 * The three totals, each the sum of the corresponding rounded line (D-35).
 *
 * `net + tax === gross` survives the summation without being re-derived, because
 * summation is exact.
 */
export const documentTotalsSchema = z.strictObject({
  net: minorUnitsSchema.meta({ description: 'The sum of every line’s `netAmount`.' }),
  tax: minorUnitsSchema.meta({
    description:
      'The sum of every line’s `taxAmount` — the sum of rounded lines, never the rounded sum. ' +
      'A customer who adds the tax column must reach this number.',
  }),
  gross: minorUnitsSchema.meta({ description: '`net + tax`. What the document is for.' }),
});

export type DocumentTotalsResponse = z.infer<typeof documentTotalsSchema>;

/**
 * One rate's share of a document, which is what a tax return is filed from.
 *
 * Grouped by rate rather than flattened into one number because a document may
 * carry lines at two rates and a return reports them separately; grouped by rate
 * *id* rather than by percentage because two rates can share a percentage and post
 * to different accounts (see `appliesTo` in the tax module).
 */
export const documentTaxSummaryRowSchema = z.strictObject({
  taxRateId: z.uuid().nullable().meta({
    description: 'Null is the untaxed group — lines carrying no rate at all.',
  }),
  taxRateName: z.string().nullable(),
  percentage: z.string().nullable(),
  net: minorUnitsSchema,
  tax: minorUnitsSchema,
});

export type DocumentTaxSummaryRow = z.infer<typeof documentTaxSummaryRowSchema>;

/**
 * What is left on a document, **computed on read** (D-34).
 *
 * The same two numbers answer four questions, which is D-39's point restated as a
 * shape: on an invoice or a bill `outstanding` is what is still owed; on a credit
 * note, a vendor credit or a payment it is what is still *available* to apply. One
 * definition — total minus allocations — means a screen showing "what does this
 * customer owe" and a screen showing "what credit is available" are reading the
 * same arithmetic, and C2 has one thing to check rather than two.
 */
export const documentSettlementSchema = z.strictObject({
  allocated: minorUnitsSchema.meta({
    description: 'The sum of the allocations applied to or from this document, as at now.',
  }),
  outstanding: minorUnitsSchema.meta({
    description:
      'Total minus `allocated`, computed on read and stored nowhere (D-34). On an invoice or a ' +
      'bill this is what is still owed; on a credit note, a vendor credit or a payment it is ' +
      'what is still available to apply.',
  }),
});

export type DocumentSettlement = z.infer<typeof documentSettlementSchema>;

/**
 * Voiding takes its own date, for `reverseJournalRequestSchema`'s reason.
 *
 * The document's own period is usually closed by the time someone voids it, and the
 * reversal has to land somewhere postable. That is an accounting choice rather than
 * a convenience: reopening a closed period restates figures already reported, while
 * a reversal in the current period leaves the closed period's statements intact and
 * shows the correction where it happened.
 *
 * Shared by all four document types and by payments, because voiding is the same
 * act everywhere: a reversing journal, never a deletion (D-16, D-38).
 */
export const voidDocumentRequestSchema = z.strictObject({
  date: calendarDateSchema.meta({
    description: 'The reversal’s own entry date, which must itself fall in an open period.',
  }),
  memo: documentMemoSchema.nullish(),
});

export type VoidDocumentRequest = z.infer<typeof voidDocumentRequestSchema>;

/**
 * The date window every document list filters on, inclusive at both ends —
 * `reportRangeShape`'s shape, restated here because it filters an *issue date*
 * rather than bounding a report's postings, and the two would diverge the moment
 * either grew a field.
 */
export const documentDateRangeShape = {
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
};

export function isOrderedRange(range: {
  from?: string | undefined;
  to?: string | undefined;
}): boolean {
  return range.from === undefined || range.to === undefined || range.from <= range.to;
}

/**
 * A page envelope with no `id`, which is the only reason it is not `pageSchema`.
 *
 * `pageSchema` requires an `id` deliberately — "the only reason to have a response
 * *schema* rather than a response *type* is to publish it" — and M3 has no routes
 * until OB-067, so every page here would publish a component nothing could reach
 * (A10). The keys are the shared envelope's (D-21), so OB-067 replaces these calls
 * with `pageSchema` calls and nothing downstream moves; `contactPageSchema` was
 * written exactly this way at OB-036 and converted at OB-045.
 */
export function unpublishedPageSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: pageCursorSchema.nullable(),
  });
}
