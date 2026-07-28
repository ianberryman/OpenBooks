import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';

/**
 * The forward cash-flow projection (OB-158; ROADMAP D-88, K6).
 *
 * Where the aging report looks backward from a date at what is already outstanding,
 * this looks forward from one: opening cash, plus the outstanding AR and AP the org
 * is already carrying, bucketed by **when it falls due** rather than by how overdue
 * it is. It answers "how much cash will this org be sitting on in three weeks", not
 * "who owes us and since when" — the same subledger reading (D-34: outstanding is a
 * document's total minus its allocations, computed on read, never stored), pointed
 * at the future instead of the past.
 *
 * ## What this ships, and what it honestly does not
 *
 * K6 names two forecast inputs: AR/AP due dates and **recurring commitments**. The
 * second does not exist yet — recurring journals are milestone L — so this response
 * carries `includesRecurringCommitments: false` unconditionally rather than
 * inventing a projection for money that has no source to read. A field that is
 * sometimes present and sometimes absent would be worse than one that is always
 * there and always says no: a client that checks the flag once and stops checking
 * is exactly the failure mode a silently-added feature invites. When milestone L
 * lands, this becomes a real toggle rather than a schema change.
 *
 * ## Why there is no reconciliation figure, unlike aging's C8
 *
 * Aging's buckets must sum to a control account's balance at a past date, and that
 * is checkable because the past does not change. A forward projection has nothing
 * to check itself against: `projectedClosingCash` is an estimate built from money
 * not yet received or paid, and no ledger balance exists yet to agree or disagree
 * with it. The absence of a tie-out here is not an omission of the aging report's
 * discipline — it is what forecasting a future is a different kind of claim.
 */

/**
 * The width of one bucket, measured forward from `asOf`.
 *
 * Two members rather than an arbitrary day count, matching `AGING_BUCKETS`'
 * reasoning in reverse: a small, named set is what a screen can put headings on and
 * a test can assert bucket boundaries against, where an arbitrary "every N days"
 * would have to be reinvented at each call site.
 */
export const CASH_FLOW_BUCKET_GRANULARITIES = ['weekly', 'monthly'] as const;

export type CashFlowBucketGranularity = (typeof CASH_FLOW_BUCKET_GRANULARITIES)[number];

export const cashFlowBucketGranularitySchema = z.enum(CASH_FLOW_BUCKET_GRANULARITIES).meta({
  description:
    'The width of one projection bucket, measured forward from `asOf`. `weekly` is seven days; ' +
    '`monthly` is one calendar month (the same day-of-month next month, clamped to that ' +
    'month’s last day where it does not exist — 31 January projects to 28 or 29 February).',
});

/**
 * The most buckets a single request may ask for.
 *
 * Bounded for `REPORT_FILTER_VALUES_MAX`'s reason: an unbounded horizon is a
 * request whose cost is set by the caller rather than by the org's data, and a
 * projection that runs to a hundred years out is not a forecast anyone reads. A
 * year of weekly buckets is 52; two years of monthly is 24. 52 covers the wider of
 * the two comfortably without inviting an unbounded one.
 */
export const CASH_FLOW_PROJECTION_HORIZON_MAX = 52;

/** A quarter of monthly buckets, or three months of weekly ones — a screenful either way. */
export const CASH_FLOW_PROJECTION_HORIZON_DEFAULT = 12;

export const CASH_FLOW_PROJECTION_GRANULARITY_DEFAULT: CashFlowBucketGranularity = 'monthly';

/**
 * `asOf` is optional, unlike the aging report's — and that is a deliberate
 * departure from D-40's rule, not an oversight. Aging requires the date because it
 * is a claim about the past, and the past does not move: the same request must
 * answer the same way tomorrow, so a default of "today" would make the report
 * silently disagree with itself. A forward projection has no such property to
 * protect — it re-answers differently every time regardless of what `asOf` is
 * pinned to, because the outstanding AR and AP behind it are themselves moving.
 * Defaulting it to today is therefore not hiding a reproducibility gap; there
 * isn't one to hide.
 */
export const cashFlowProjectionQuerySchema = z
  .strictObject({
    asOf: calendarDateSchema.optional().meta({
      description:
        'The date the projection starts from — opening cash is this org’s cash/bank balance at ' +
        'the close of this date, and the first bucket begins the day after. Defaults to today.',
    }),
    granularity: cashFlowBucketGranularitySchema.optional(),
    horizon: z
      .int()
      .min(1)
      .max(CASH_FLOW_PROJECTION_HORIZON_MAX)
      .optional()
      .meta({
        description:
          `How many buckets to project forward, at most ${String(CASH_FLOW_PROJECTION_HORIZON_MAX)}` +
          '. Over the maximum is refused rather than clamped, so a shorter response always means ' +
          'a shorter horizon was asked for.',
      }),
  })
  .meta({
    description:
      'Forecasts cash forward from `asOf` across `horizon` buckets of `granularity` width, from ' +
      'opening cash plus the AR and AP already outstanding, bucketed by due date. Recurring ' +
      'commitments are not yet included (`includesRecurringCommitments` says so on every response).',
  });

export type CashFlowProjectionQueryParams = z.infer<typeof cashFlowProjectionQuerySchema>;

/**
 * One bucket: the window, what is expected to move in it, and where cash stands
 * after it.
 *
 * `expectedInflows` and `expectedOutflows` are both non-negative — a bucket with
 * nothing due in it is zero, never negative — and `netChange` is the two combined
 * (`inflows - outflows`), signed. `projectedClosingCash` is cumulative: opening
 * cash plus every bucket's `netChange` up to and including this one, so a reader
 * can take any single row and know the org's projected position at the end of it
 * without summing the ones before it by hand.
 */
export const cashFlowProjectionBucketSchema = z
  .strictObject({
    /** Inclusive. The day after the previous bucket's `periodEnd`, or `asOf` itself for the first. */
    periodStart: calendarDateSchema,
    /** Inclusive. */
    periodEnd: calendarDateSchema,
    expectedInflows: minorUnitsSchema.meta({
      description:
        'Outstanding invoice balances due in this window (total minus allocations, computed on ' +
        'read — D-34). A due date on or before `periodEnd` that has already passed lands in the ' +
        'earliest bucket rather than being dropped: money already overdue is money expected now, ' +
        'not money excluded from the forecast.',
    }),
    expectedOutflows: minorUnitsSchema.meta({
      description: 'The same reading over outstanding bill balances due in this window.',
    }),
    netChange: minorUnitsSchema.meta({
      description: '`expectedInflows - expectedOutflows`.',
    }),
    projectedClosingCash: minorUnitsSchema.meta({
      description:
        'Opening cash plus every bucket’s `netChange` through this one, inclusive. An estimate, ' +
        'not a ledger balance: nothing here has been received or paid yet.',
    }),
  })
  .meta({
    id: 'CashFlowProjectionBucket',
    description:
      'One forward-looking window: what is expected to move in it and the running cash position ' +
      'after it, both derived from AR/AP due dates rather than posted.',
  });

export type CashFlowProjectionBucket = z.infer<typeof cashFlowProjectionBucketSchema>;

export const cashFlowProjectionSchema = z
  .strictObject({
    asOf: calendarDateSchema.meta({
      description: 'The date actually used — the request’s, or today when it was omitted.',
    }),
    granularity: cashFlowBucketGranularitySchema,
    openingCash: minorUnitsSchema.meta({
      description:
        'This org’s cash/bank balance at the close of `asOf` — the accounts registered in ' +
        '`bank_accounts`, plus any account an org has marked with the `cash` basis role that is ' +
        'not separately registered. Read from the same ledger every other report reads (D-13); ' +
        'there is no separate stored balance to drift from it (D-46).',
    }),
    /** Ordered earliest first. Length is the request’s `horizon`, or the default. */
    buckets: z.array(cashFlowProjectionBucketSchema),
    includesRecurringCommitments: z.boolean().meta({
      description:
        'Always `false` today. Recurring journals (milestone L) do not exist yet, so this ' +
        'forecast is AR/AP due dates only — it does not know about a rent payment or a payroll ' +
        'run that has no invoice or bill behind it. Present unconditionally, and not merely ' +
        'documented, so a client cannot miss the day it becomes true.',
    }),
  })
  .meta({
    id: 'CashFlowProjection',
    description:
      'A forward cash-flow forecast from `asOf`: opening cash plus outstanding AR (money in) and ' +
      'AP (money out) bucketed by due date, projected across `buckets`. Overdue amounts land in ' +
      'the earliest bucket rather than being excluded. Recurring commitments are not yet included ' +
      '— see `includesRecurringCommitments`. There is no reconciliation figure the way aging’s ' +
      'C8 exists: the future has no ledger balance yet to check this against.',
  });

export type CashFlowProjection = z.infer<typeof cashFlowProjectionSchema>;
