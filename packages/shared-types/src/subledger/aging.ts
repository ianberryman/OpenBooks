import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { ALLOCATION_SOURCE_TYPES, ALLOCATION_TARGET_TYPES } from './allocations';

/**
 * The aging report (OB-061, for OB-065; ROADMAP D-40, acceptance C8).
 *
 * What a business is owed and what it owes, split by how late it is, **as at a
 * date**. Buckets are current / 1–30 / 31–60 / 61–90 / 90+ days past due, measured
 * from the *due* date rather than the issue date, because that is what "overdue"
 * means to the person chasing it.
 *
 * ## Why it lives here and not in `reports/`
 *
 * Every report in `reports/` is an aggregation over journal lines. This one is an
 * aggregation over documents and allocations (D-40), which is a different source
 * and — precisely because it is a different source — the reason C8 is worth
 * asserting: the buckets must sum to the control account's balance at that date,
 * and an aging report that does not tie to the ledger is a list of hopes.
 *
 * ## Why the report does not state the control-account balance itself
 *
 * It would make C8 visible to a user rather than only to a test. The setting this
 * originally waited on now exists — an org nominates its control accounts, see
 * `orgs/settings.ts` — and the field is still left out, because the remaining half
 * of the argument survives the setting arriving: an org that has nominated nothing
 * has no balance to compare against, so the field would be nullable, and a
 * reconciliation that is sometimes reported is one nobody trusts. OB-071 asserts C8
 * against the trial balance, which is the oracle the whole milestone is built to
 * agree with.
 */

/**
 * Which side is being aged. The same shape answers both, because "what we are owed"
 * and "what we owe" are one aggregation over documents pointed in two directions —
 * the `ALLOCATION_TARGET_TYPES` are exactly the two documents that carry an amount
 * outstanding, so aging and allocation agree on what a target is by construction.
 */
export const AGING_LEDGERS = ['receivable', 'payable'] as const;

export type AgingLedger = (typeof AGING_LEDGERS)[number];

export const agingLedgerSchema = z.enum(AGING_LEDGERS).meta({
  description:
    '`receivable` ages invoices against what customers owe; `payable` ages bills against what ' +
    'is owed to vendors. Each ties to its own control account (C8).',
});

/**
 * The bucket boundaries, in days past due, as data rather than as five field names
 * only — a screen prints the headings from this and a test asserts the arithmetic
 * against it, so "31–60" cannot mean one thing in the report and another on the
 * page.
 */
export const AGING_BUCKET_UPPER_BOUNDS = [0, 30, 60, 90] as const;

export const AGING_BUCKETS = [
  'current',
  'days1To30',
  'days31To60',
  'days61To90',
  'days90Plus',
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const agingBucketSchema = z.enum(AGING_BUCKETS).meta({
  description:
    'How far past its due date a document is, as at the report’s `asOf`. `current` is not yet ' +
    'due, including due exactly today.',
});

/**
 * The five buckets and their total, the shape used for a contact's row and for the
 * report's own totals — one component, for `glAmountsSchema`'s reason: three
 * windows of the same shape are one type, not three.
 */
export const agingAmountsSchema = z
  .strictObject({
    current: minorUnitsSchema,
    days1To30: minorUnitsSchema,
    days31To60: minorUnitsSchema,
    days61To90: minorUnitsSchema,
    days90Plus: minorUnitsSchema,
    total: minorUnitsSchema.meta({
      description: 'The five buckets summed. This is what must tie to the control account (C8).',
    }),
  })
  .meta({
    id: 'AgingAmounts',
    description:
      'The five buckets and their total — one component for a contact’s row and for the report’s ' +
      'own totals, because three windows of the same shape are one type.',
  });

export type AgingAmounts = z.infer<typeof agingAmountsSchema>;

/**
 * Everything a detail row can be: the two documents that carry an amount owed, and
 * the three things that carry credit against them.
 *
 * The credit half is [OB-066a]'s correction to this contract, and the bug it fixes
 * was arithmetic rather than cosmetic. `agingAmounts.total` has to equal the control
 * account (C8), which means it nets the unapplied credit a contact is holding —
 * D-37's payment on account and D-39's unallocated credit note are money already
 * sitting in the control account. While this enum was the two target types only,
 * that credit had no representable row, so on any contact holding one the
 * `documents` array summed to *more* than the `amounts.total` printed above it.
 *
 * Netting the credit across the open invoices was the alternative and is refused:
 * it would invent an allocation nobody made, move money between buckets, and make
 * this report disagree with the invoice's own outstanding amount everywhere else in
 * the system — outstanding has exactly one definition, total minus allocations
 * (D-34). Showing the credit as its own row states what the data actually says.
 */
export const AGING_DETAIL_TYPES = [...ALLOCATION_TARGET_TYPES, ...ALLOCATION_SOURCE_TYPES] as const;

export type AgingDetailType = (typeof AGING_DETAIL_TYPES)[number];

export const agingDetailTypeSchema = z.enum(AGING_DETAIL_TYPES).meta({
  description:
    'What the row is. `invoice` and `bill` carry an amount owed and are positive; `payment`, ' +
    '`credit_note` and `vendor_credit` carry unapplied credit and are negative.',
});

/**
 * One open item, for the drill-through.
 *
 * `outstanding` is **as at the report's date**, not as at now: it is the document's
 * total less the allocations dated on or before `asOf` (D-40). Using today's
 * allocations against a past date's documents would produce a report that cannot be
 * reproduced tomorrow, which D-40 explicitly refuses — and a detail row showing a
 * figure the buckets above it were not computed from is how that mistake gets
 * shipped without anyone noticing.
 *
 * On a credit row `total` and `outstanding` are **negative**, matching the sign the
 * credit contributes to the buckets. The alternative — a positive amount plus a
 * type the reader must consult to know the sign — makes summing the array a
 * conditional, and the one property this array now has is that it sums to
 * `amounts.total`.
 *
 * `dueDate` and `daysPastDue` are nullable together and are null on exactly the
 * credit rows. A credit is allocated, not chased: `0005_subledger` makes `due_date`
 * NULL on a credit note for that reason, and a payment has no due date to have. A
 * zero would read as "due today", which is a different and false statement.
 */
export const agingDocumentSchema = z
  .strictObject({
    documentType: agingDetailTypeSchema,
    documentId: z.uuid(),
    documentNumber: z.string(),
    reference: z.string().nullable(),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema.nullable(),
    total: minorUnitsSchema,
    outstanding: minorUnitsSchema.meta({
      description:
        'Total less the allocations dated on or before `asOf`. Computed, never stored (D-34). ' +
        'Negative on a credit row.',
    }),
    daysPastDue: z
      .int()
      .nullable()
      .meta({
        description:
          'Negative when the document is not yet due. Measured from `dueDate` to `asOf`, and null ' +
          'wherever `dueDate` is — a credit is allocated rather than chased.',
      }),
    bucket: agingBucketSchema,
  })
  .meta({
    id: 'AgingDocument',
    description:
      'One open item, for the drill-through. `outstanding` is as at the report’s date, not as at ' +
      'now (D-40). On a credit row `total` and `outstanding` are negative, and `dueDate` and ' +
      '`daysPastDue` are both null — a credit is allocated, not chased.',
  });

export type AgingDocument = z.infer<typeof agingDocumentSchema>;

/**
 * One contact's aging.
 *
 * `contactName` rides along because an aging report is read, printed and posted —
 * resolving a hundred contact ids from a second endpoint to print one page is a
 * client that will get it wrong once and cache it forever.
 *
 * `documents` is null rather than absent when the caller did not ask for detail,
 * matching the convention every response schema here follows: a field that is
 * sometimes missing and sometimes present is two shapes, and under
 * `exactOptionalPropertyTypes` they are two types.
 *
 * When it is present, its `outstanding` values sum to `amounts.total` — the credit
 * rows carry their own sign, which is what `AGING_DETAIL_TYPES` was widened for.
 * A row is present only while something is outstanding on it, so a settled invoice
 * and a fully applied payment are both absent and both contribute zero.
 */
export const agingRowSchema = z
  .strictObject({
    contactId: z.uuid(),
    contactName: z.string(),
    amounts: agingAmountsSchema,
    documents: z.array(agingDocumentSchema).nullable(),
  })
  .meta({
    id: 'AgingRow',
    description:
      'One contact’s aging. `documents` is null rather than absent when `detail` was not asked ' +
      'for; when it is present its `outstanding` values sum to `amounts.total`.',
  });

export type AgingRow = z.infer<typeof agingRowSchema>;

/**
 * `asOf` is **required**, and that is the one argument in this file.
 *
 * Every other report in this API defaults an omitted bound to "every posting to
 * date" (`trialBalanceQuerySchema`, `reportRangeShape`), which is a defensible
 * default because it names the whole ledger rather than a moment. An aging report
 * has no such reading: omitting the date would mean "today", the answer would
 * change overnight, and the request that produced a figure someone filed would no
 * longer reproduce it. D-40 makes reproducibility the point of the report, so the
 * date is the caller's to state.
 *
 * `detail` is opt-in because the detail is unbounded — an org with two thousand
 * open invoices would otherwise get all of them on every summary — and there is no
 * pagination here on purpose: aging is a whole-report aggregation whose buckets
 * must sum to a control account, and a page of it sums to nothing in particular.
 */
export const agingQuerySchema = z.strictObject({
  asOf: calendarDateSchema.meta({
    description:
      'The date the report is computed as at. Required: an aging report that defaulted to today ' +
      'would answer differently tomorrow, and D-40 makes reproducibility its point.',
  }),
  ledger: agingLedgerSchema,
  contactId: z.uuid().optional(),
  detail: z
    .boolean()
    .optional()
    .meta({
      description:
        'Include the outstanding documents behind each row. Off by default — the list is bounded ' +
        'only by how many documents are open.',
    }),
  includeZero: z
    .boolean()
    .optional()
    .meta({
      description:
        'Include contacts whose total is zero as at the date. Off by default: unlike a trial ' +
        'balance, where a zero row is how someone notices a posting went astray, a contact with ' +
        'nothing outstanding is simply a contact who has paid.',
    }),
});

export type AgingQueryParams = z.infer<typeof agingQuerySchema>;

/**
 * `totals` is the sum of the rows, bucket by bucket, and it is what C8 checks
 * against the control account at `asOf`.
 *
 * Reported rather than asserted, in `trialBalanceSchema`'s sense: this endpoint says
 * what the subledger contains. A discrepancy between it and the ledger is a fact an
 * operator needs to see, and turning it into an error here would hide it behind a
 * 500 exactly when someone is looking for it.
 */
export const agingSchema = z
  .strictObject({
    asOf: calendarDateSchema,
    ledger: agingLedgerSchema,
    rows: z.array(agingRowSchema),
    totals: agingAmountsSchema,
  })
  .meta({
    id: 'Aging',
    description:
      'What is owed, bucketed by how late it is, as at `asOf`. `totals` is the sum of the rows ' +
      'bucket by bucket and is what must tie to the control account at that date (C8). The report ' +
      'deliberately does not state that balance itself — an org that has nominated no control ' +
      'account has none to state, and a reconciliation that is sometimes reported is one nobody ' +
      'trusts.',
  });

export type Aging = z.infer<typeof agingSchema>;
