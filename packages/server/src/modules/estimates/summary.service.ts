import { sql } from 'kysely';

import type { EstimatesSummary, EstimatesSummaryQuery } from '@openbooks/shared-types';
import { estimatesSummaryQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import { orgScope, toBigInt } from './estimates.repository';

/**
 * The three headline figures the estimates list shows (mirror of OB-069's invoices/
 * bills list): what is still open, what of it has lapsed, and what has converted to
 * an invoice in the last 30 days.
 *
 * ## Why this reads `estimates` directly rather than the aging repository
 *
 * `invoicesSummary`/`billsSummary` reuse `aging.repository.ts` because "outstanding"
 * there is total minus allocations, computed against a posted journal — an estimate
 * has neither (D-M3). Its three buckets are instead stored-column predicates exactly
 * as `estimates.repository.ts`'s `statusPredicate` already expresses them: `draft`/
 * `approved` are `sequence_number`, `converted` is `converted_invoice_id`. Reading
 * that repository's per-row net/tax pattern (`NET_EXPRESSION`/`TAX_EXPRESSION`)
 * directly here, rather than paging through `selectEstimatesPage`, avoids fetching a
 * page's worth at a time for a figure that has to see every estimate the org has.
 *
 * ## Why `asOf` defaults to today, where the aging report refuses to
 *
 * D-40 makes an aging report reproducible, so it will not default to a moving
 * target. This is not that: it is what the screen shows *now*, a live snapshot, so
 * today is the only sensible default and a caller that omits the date gets it.
 */
export async function estimatesSummary(
  query: EstimatesSummaryQuery = {},
  ctx: RequestContext = getContext('estimatesSummary()'),
): Promise<EstimatesSummary> {
  await requirePermission(ctx, 'estimates.read');
  const request = parseInput(estimatesSummaryQuerySchema, query);
  const asOf = request.asOf ?? todayCalendarDate();
  const windowStart = minusDays(asOf, 30);

  const db = orgScope(ctx);
  const rows = await db
    .selectFrom('estimates')
    .select([
      'estimates.sequence_number',
      'estimates.converted_invoice_id',
      'estimates.expiry_date',
      'estimates.converted_at',
      NET_EXPRESSION.as('net'),
      TAX_EXPRESSION.as('tax'),
    ])
    .execute();

  let openValue = 0n;
  let openCount = 0;
  let expiredValue = 0n;
  let expiredCount = 0;
  let convertedValue = 0n;
  let convertedCount = 0;

  for (const row of rows) {
    const gross = toBigInt(row.net) + toBigInt(row.tax);

    if (row.converted_invoice_id === null) {
      // draft + approved, `statusPredicate`'s union of the two.
      openValue += gross;
      openCount += 1;

      // Lapsed: only an approved (numbered) estimate can expire, and due today is
      // not yet expired — the same `<` line `invoicesSummary`'s overdue draws.
      if (row.sequence_number !== null && row.expiry_date !== null && row.expiry_date < asOf) {
        expiredValue += gross;
        expiredCount += 1;
      }
    } else if (row.converted_at !== null) {
      // `chk_estimates_converted` ties the two columns together, so a non-null
      // `converted_invoice_id` always carries a non-null `converted_at` — the
      // narrowing here is for the compiler, not a case the data produces.
      const convertedDate = row.converted_at.toISOString().slice(0, 10);
      if (convertedDate >= windowStart && convertedDate <= asOf) {
        convertedValue += gross;
        convertedCount += 1;
      }
    }
  }

  return {
    asOf,
    openValue: openValue.toString(),
    openCount,
    expiredValue: expiredValue.toString(),
    expiredCount,
    convertedValue: convertedValue.toString(),
    convertedCount,
  };
}

/**
 * Per-estimate net/tax, `estimates.repository.ts`'s `NET_EXPRESSION`/`TAX_EXPRESSION`
 * restated here rather than imported: that file's copy is private to the keyset page
 * read, and exporting it for one other caller would tie a paging concern to this
 * one's shape.
 */
const NET_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.line_amount_minor), 0) FROM estimate_lines l
  WHERE l.org_id = estimates.org_id AND l.estimate_id = estimates.id
)`;

const TAX_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.tax_amount_minor), 0) FROM estimate_lines l
  WHERE l.org_id = estimates.org_id AND l.estimate_id = estimates.id
)`;

/** `YYYY-MM-DD` in UTC — the timezone the pool and the `DATE` columns already use. */
function todayCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `date` shifted back `days` whole days, in UTC.
 *
 * Through `Date.UTC` from the parsed parts for `aging.service.ts`'s reason: a local
 * midnight subtraction spans 23 or 25 hours across a DST boundary. `Date.UTC`
 * carries the month/year underflow, so 30 days before the 5th of a month lands in
 * the previous one without a special case.
 */
function minusDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // `calendarDateSchema` parsed anything a caller sent, and today's date is built
    // above; a malformed value here is a fault in this process, not input.
    throw new InternalError(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}
