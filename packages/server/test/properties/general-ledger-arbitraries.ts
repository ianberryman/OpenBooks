import fc from 'fast-check';

import type { ReportPlan } from './report-arbitraries';
import { reportPlanArb } from './report-arbitraries';

/**
 * Generated ledgers for the OB-044 properties.
 *
 * `reportPlanArb` next door already produces a chart with a shape, tagged lines,
 * and journals the posting service accepts. What it does *not* reliably produce is
 * the two shapes the general ledger's ordering exists for, and a generator that
 * omits them tests everything except the half of this ticket that is about order:
 *
 *  - **Two journals on one `entry_date`.** `reportPlanArb` draws dates uniformly
 *    across 2026 and posts at most four journals, so two of them coincide about
 *    one run in a hundred. `entry_date` alone is not a total ordering (D-14, D-21)
 *    and that is the whole reason the sequence number is the second cursor column
 *    — but with no collisions generated, an implementation that ordered by date
 *    alone passes every run.
 *  - **A back-dated posting.** `sequence_number` is allocated in posting order and
 *    `entry_date` is chosen by the user, so a journal posted later can sort
 *    earlier. That is how a correction is made here (D-02: no edits, only
 *    reversing entries), and it is the event D-21 chose keyset paging for.
 *
 * Both are produced by drawing every journal's date from a **small pool** — two or
 * three days for the whole plan — and assigning pool entries independently of
 * posting order. Collisions then become the common case rather than the rare one,
 * and a descending pair falls out of the same draw. `assertGeneratesTheHardShapes`
 * in the property file checks that this actually happens rather than assuming it.
 *
 * Nothing else about the plan is touched: the chart, the amounts (including the
 * band above 2^53), the line counts and the tags are `reportPlanArb`'s, for the
 * reason it states about not re-deriving bounds a service already enforces.
 */

/**
 * How many distinct days a generated plan's journals land on.
 *
 * Two at minimum, so a range bound can fall strictly between two dates and there
 * is always something on each side of it; three at most, so that four journals
 * across them collide on nearly every run.
 */
const DATE_POOL_MIN = 2;
const DATE_POOL_MAX = 3;

export const glPlanArb: fc.Arbitrary<ReportPlan> = reportPlanArb.chain((plan) =>
  fc
    .record({
      pool: fc.uniqueArray(dayOfYearArb(), {
        minLength: DATE_POOL_MIN,
        maxLength: DATE_POOL_MAX,
      }),
      // One draw per journal, independent of its position in the list — which is
      // the posting order, and therefore the sequence-number order. An index
      // drawn low for a late journal is a back-dated entry.
      picks: fc.array(fc.nat({ max: DATE_POOL_MAX - 1 }), {
        minLength: plan.journals.length,
        maxLength: plan.journals.length,
      }),
    })
    .map(({ pool, picks }) => ({
      ...plan,
      journals: plan.journals.map((journal, index) => ({
        ...journal,
        date: pool[(picks[index] ?? 0) % pool.length] ?? journal.date,
      })),
    })),
);

export interface GeneralLedgerCase {
  readonly plan: ReportPlan;
  readonly from: string;
  readonly to: string;
  /** The page size the paging property reads at. Small, so a plan spans several pages. */
  readonly limit: number;
}

/**
 * A plan, a range whose bounds land on its own journal dates, and a page size.
 *
 * The bounds are drawn from the plan's dates three times out of four rather than
 * uniformly, and that weighting is not a style choice — `report-arbitraries.ts`
 * records the measurement behind it: with uniform bounds, mutating the opening
 * window's `<` to `<=` left every report property passing, and with the bounds
 * drawn from the plan the same mutation failed on the first run. Here the pool is
 * two or three days wide, so a bound landing on one of them is also the case where
 * a whole day's worth of entries sits exactly on the boundary.
 *
 * `limit` is one to three, so a plan of a dozen lines is read in several pages and
 * the cross-page property has boundaries to cross. It shrinks toward 1, which is
 * the page size that puts a boundary between every pair of rows.
 */
export const glCaseArb: fc.Arbitrary<GeneralLedgerCase> = glPlanArb.chain((plan) => {
  const dates = [...new Set(plan.journals.map((journal) => journal.date))];
  const bound =
    dates.length === 0
      ? dayOfYearArb()
      : fc.oneof(
          { withCrossShrink: true },
          { arbitrary: fc.constantFrom(...dates), weight: 3 },
          { arbitrary: dayOfYearArb(), weight: 1 },
        );

  return fc
    .record({ left: bound, right: bound, limit: fc.integer({ min: 1, max: 3 }) })
    .map(({ left, right, limit }) => ({
      plan,
      from: left <= right ? left : right,
      to: left <= right ? right : left,
      limit,
    }));
});

/**
 * A day in 2026, the open period every fixture posts into.
 *
 * Copied from `report-arbitraries.ts` rather than exported from it, following the
 * convention `test/reports/support.ts` states: that file belongs to OB-041, and
 * neither ticket's generator should change because the other's did.
 */
function dayOfYearArb(): fc.Arbitrary<string> {
  const DAYS_IN_MONTH_2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

  return fc
    .record({ month: fc.integer({ min: 1, max: 12 }), day: fc.integer({ min: 1, max: 31 }) })
    .map(({ month, day }) => {
      const lastDay = DAYS_IN_MONTH_2026[month - 1] ?? 28;
      return `2026-${pad(month)}-${pad(Math.min(day, lastDay))}`;
    });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
