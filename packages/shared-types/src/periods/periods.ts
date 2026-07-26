import { z } from 'zod';

import { calendarDateSchema } from '../wire';

/**
 * The fiscal-period wire contract (OB-023; spec §7; ROADMAP D-08, D-17).
 *
 * ## Why these shapes and the service's are separate files
 *
 * `src/modules/periods/periods.schemas.ts` is the service's own boundary and stays
 * that way: it derives `PeriodStatus` from the `fiscal_periods.status` column, which
 * this package cannot see and should not. These are the *wire* shapes, and the two
 * are held together by the compiler rather than by a comment — the route handlers in
 * `src/transport/routes/periods.ts` return the service's values against these
 * schemas, so a status the column grew that the wire does not name fails to compile
 * there.
 *
 * ## A period is a calendar month, not a date range
 *
 * D-17 says so, and the request shapes below make it structural: a period is named
 * by its `year` and `month`, and its start and end dates are derived. Accepting an
 * arbitrary range would demote that from a fact to a convention, and the first
 * consequence would be periods of unequal length in a system whose reports assume
 * monthly comparability. It is also why no request can produce `end_date <
 * start_date` and trip `chk_fiscal_periods_range`.
 */

/**
 * ROADMAP D-08 fixes the M1 status set to these two: plain open/closed, with a
 * permission check on close and on reopen. The richer audited period-close workflow
 * arrives with M2/M3 and attaches to permissions that already exist.
 */
export const PERIOD_STATUSES = ['open', 'closed'] as const;

export type PeriodStatusWire = (typeof PERIOD_STATUSES)[number];

const periodStatusSchema = z.enum(PERIOD_STATUSES).meta({
  description:
    'A posting may only land in an `open` period (A4). Closing is the routine monthly soft ' +
    'close; reopening withdraws a statement that may already have been relied on, and needs a ' +
    'separate permission.',
});

/**
 * Bounds restated from `MIN_FISCAL_YEAR` / `MAX_FISCAL_YEAR` in
 * `src/modules/periods/periods.schemas.ts`, which is the authority and applies the
 * same check.
 *
 * MySQL's `DATE` range starts at 1000-01-01, and a fiscal year with a non-January
 * start month extends into the following calendar year — so the last year that can
 * be generated in full is 9998, not 9999. Stating it here is what turns a typo'd
 * year into a `validation_failed` naming the field rather than a driver error from
 * the twelfth insert of a partially-written fiscal year. If the two ever disagree
 * the service is right; the schema is looser or stricter, never the decider.
 */
const fiscalYearSchema = z
  .int()
  .min(1000)
  .max(9998)
  .meta({
    description:
      'The calendar year the fiscal year *starts* in. A year beginning in April 2026 and ending ' +
      'in March 2027 is fiscal year 2026.',
  });

/**
 * One fiscal period as the API returns it.
 *
 * `closedAt` is an instant rather than a calendar date, because it is the wall-clock
 * time of a system event and not an accounting date (plugin-api `primitives.ts`).
 * `closedByUserId` is null when the close was made by an automation or an agent,
 * which is not a `users` row.
 */
export const fiscalPeriodSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string().meta({ description: 'Human label for the month, e.g. `2026-03`.' }),
    startDate: calendarDateSchema,
    /** Inclusive. A posting dated on the end date is inside the period. */
    endDate: calendarDateSchema,
    status: periodStatusSchema,
    closedAt: z.iso.datetime().nullable(),
    closedByUserId: z.uuid().nullable(),
  })
  .meta({ id: 'FiscalPeriod', description: 'One monthly fiscal period.' });

/** The envelope convention: a top-level object has somewhere to put a later addition. */
export const fiscalPeriodListSchema = z
  .strictObject({
    periods: z.array(fiscalPeriodSchema),
  })
  .meta({
    id: 'FiscalPeriodList',
    description: 'The org’s fiscal periods in ascending date order. Unpaginated in M1.',
  });

/**
 * Creating one month by hand.
 *
 * This exists for the partial first year a business that started in September
 * actually has. Gaplessness is a property of fiscal-year generation rather than of
 * the table, so a caller building a year with this can leave a hole — and a date in
 * that hole is un-postable, which is answered rather than papered over.
 */
export const createFiscalPeriodRequestSchema = z
  .strictObject({
    year: fiscalYearSchema,
    month: z.int().min(1).max(12).meta({ description: 'Calendar month, 1–12.' }),
  })
  .meta({
    id: 'CreateFiscalPeriodRequest',
    description:
      'Creates one monthly period. A period is a calendar month, so it is named by year and ' +
      'month rather than by a date range.',
  });

export type CreateFiscalPeriodRequest = z.infer<typeof createFiscalPeriodRequestSchema>;

/**
 * Generating a whole fiscal year — twelve contiguous monthly periods.
 *
 * The month the year starts in comes from the org (`fiscalYearStartMonth`) and is
 * deliberately not a parameter: a client that could choose it per call could
 * generate two overlapping years for one org.
 */
export const generateFiscalYearRequestSchema = z
  .strictObject({
    fiscalYear: fiscalYearSchema,
  })
  .meta({
    id: 'GenerateFiscalYearRequest',
    description:
      'Generates the twelve monthly periods of one fiscal year. Generation is always explicit ' +
      '— no posting ever creates the period it needs (ROADMAP D-17).',
  });

export type GenerateFiscalYearRequest = z.infer<typeof generateFiscalYearRequestSchema>;

export const generatedFiscalYearSchema = z
  .strictObject({
    fiscalYear: fiscalYearSchema,
    startMonth: z.int().min(1).max(12),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    periods: z.array(fiscalPeriodSchema).meta({
      description: 'Twelve periods, contiguous, in ascending date order.',
    }),
  })
  .meta({
    id: 'GeneratedFiscalYear',
    description: 'The generated fiscal year, its span, and the twelve periods inside it.',
  });

/**
 * `status` omitted matches every period. A `strictObject` so a mistyped filter is a
 * `validation_failed` rather than an unfiltered list the client reads as filtered.
 */
export const listFiscalPeriodsQuerySchema = z
  .strictObject({
    status: periodStatusSchema.optional(),
  })
  .meta({ description: 'Omitting `status` matches open and closed periods alike.' });

export type ListFiscalPeriodsQuery = z.infer<typeof listFiscalPeriodsQuerySchema>;
