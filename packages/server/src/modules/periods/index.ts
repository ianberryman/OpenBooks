/**
 * Fiscal periods (OB-019; spec §7; ROADMAP D-08, D-17).
 *
 * This module owns acceptance criterion **A4 — posting to a locked period is
 * rejected** — which it delivers through `assertPostable`, the one function OB-020's
 * posting repository calls. Read its commentary in `periods.service.ts` before
 * calling it: it takes no database handle and no org, because both are ambient, and
 * it takes a row lock by default because that is what makes A9 (a posting racing a
 * period lock leaves nothing half-written) true rather than likely.
 *
 * Three decisions are argued at the code that implements them rather than here:
 *
 *  - **No `Date`, anywhere.** Calendar dates are `YYYY-MM-DD` strings end to end.
 *    `calendar.ts` explains why constructing a `Date` from one is how an
 *    `entry_date` lands in the wrong period.
 *  - **Non-overlap is this service's job.** MySQL has no exclusion constraints, so
 *    `fiscal_periods` cannot express it. `createPeriods` in `periods.service.ts`
 *    holds the algorithm and `rangesOverlap` in `calendar.ts` holds the predicate,
 *    including the containment and straddling cases a naive check misses.
 *  - **Generation is explicit.** There is no code path that creates a period as a
 *    side effect of posting into it (D-17).
 *
 * Everything below is permission-gated in the service layer (spec §5, §2.4) except
 * `assertPostable`, which is an invariant check inside an already-authorized
 * operation — argued where it is defined.
 */
export type { CalendarMonth, FiscalYearSpan, MonthSpan } from './calendar';
export {
  addMonths,
  daysInMonth,
  fiscalYearSpan,
  isLeapYear,
  monthEndDate,
  monthLabel,
  MONTHS_PER_YEAR,
  monthSpan,
  monthStartDate,
  rangesOverlap,
} from './calendar';

export type {
  CreatePeriodInput,
  GenerateFiscalYearInput,
  ListPeriodsInput,
  PeriodRef,
  PeriodStatus,
} from './periods.schemas';
export {
  calendarDateSchema,
  createPeriodInputSchema,
  generateFiscalYearInputSchema,
  listPeriodsInputSchema,
  MAX_FISCAL_YEAR,
  MIN_FISCAL_YEAR,
  periodRefSchema,
  periodStatusSchema,
} from './periods.schemas';

export type {
  FiscalPeriod,
  GeneratedFiscalYear,
  PostabilityOptions,
  PostablePeriod,
} from './periods.service';
export {
  assertPostable,
  closePeriod,
  createPeriod,
  generateFiscalYear,
  getPeriod,
  listPeriods,
  reopenPeriod,
} from './periods.service';
