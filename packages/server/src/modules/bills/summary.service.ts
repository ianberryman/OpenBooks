import type { BillsSummary, BillsSummaryQuery } from '@openbooks/shared-types';
import { billsSummaryQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';
import { selectApDocuments, selectPayments } from '../reports/aging.repository';

import { orgScope } from './ap-documents.repository';

/**
 * The three headline figures the bills list shows (OB-069 UI): what is still owed,
 * what of it is overdue, and what has been paid out in the last 30 days.
 *
 * ## Why this reuses the aging repository rather than summing the list
 *
 * Outstanding has one definition — total minus allocations, computed on read
 * (D-34) — and the aging repository is where the as-at version of it already lives,
 * correlated subqueries, counterpart-posted rule and all (OB-071). Summing it a
 * second way here would be the second source of truth D-34 exists to refuse, and it
 * would drift from the aging report the moment either changed. So the bill basis is
 * `selectApDocuments` and the paid figure is `selectPayments`, the same reads the
 * payable aging is assembled from, and `totalUnpaid` equals that report's bill total
 * by construction rather than by luck.
 *
 * The web list cannot sum it either: it is one capped page (D-list-limit), so a
 * browser total would be wrong past the first hundred bills. This is the server
 * doing the arithmetic once, over every bill, which is the only place it is right.
 *
 * ## Why `asOf` defaults to today, where the aging report refuses to
 *
 * D-40 makes an aging report reproducible, so it will not default to a moving
 * target. This is not that: it is what the screen shows *now*, a live snapshot, so
 * today is the only sensible default and a caller that omits the date gets it.
 */
export async function billsSummary(
  query: BillsSummaryQuery = {},
  ctx: RequestContext = getContext('billsSummary()'),
): Promise<BillsSummary> {
  await requirePermission(ctx, 'bills.read');
  const request = parseInput(billsSummaryQuerySchema, query);
  const asOf = request.asOf ?? todayCalendarDate();
  const windowStart = minusDays(asOf, 30);

  const db = orgScope(ctx);
  const [bills, payments] = await Promise.all([
    selectApDocuments(db, {
      asOf,
      documentType: 'bill',
      allocationLink: 'bill_id',
      contactId: null,
    }),
    selectPayments(db, { asOf, direction: 'paid', allocations: 'ap_allocations', contactId: null }),
  ]);

  let totalUnpaid = 0n;
  let openCount = 0;
  let totalOverdue = 0n;
  let overdueCount = 0;

  for (const bill of bills) {
    const outstanding = bill.total - bill.allocated;
    // A settled bill contributes zero and is not an open item — the same line
    // `settlementOf` draws, so the count matches what the list would call unpaid.
    if (outstanding <= 0n) continue;
    totalUnpaid += outstanding;
    openCount += 1;
    // Due today is not yet overdue, matching the aging report's `current` bucket
    // (`bucketFor`): a plain string `<` is chronological on `YYYY-MM-DD`.
    if (bill.dueDate !== null && bill.dueDate < asOf) {
      totalOverdue += outstanding;
      overdueCount += 1;
    }
  }

  let paidLast30Days = 0n;
  for (const payment of payments) {
    // The full payment amount — money out to a vendor — whatever it was applied to.
    if (payment.paymentDate >= windowStart && payment.paymentDate <= asOf) {
      paidLast30Days += payment.amount;
    }
  }

  return {
    asOf,
    totalUnpaid: totalUnpaid.toString(),
    openCount,
    totalOverdue: totalOverdue.toString(),
    overdueCount,
    paidLast30Days: paidLast30Days.toString(),
  };
}

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
