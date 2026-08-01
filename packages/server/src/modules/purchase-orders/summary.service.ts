import { sql } from 'kysely';

import type { PurchaseOrdersSummary, PurchaseOrdersSummaryQuery } from '@openbooks/shared-types';
import { purchaseOrdersSummaryQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import { orgScope } from './purchase-orders.repository';

/**
 * The three headline figures the purchase-orders list shows, one per stored lifecycle state
 * (D-M6): what is still in draft, what is approved and awaiting conversion to a bill, and
 * what has converted in the last 30 days. The AP-side mirror of `estimatesSummary`.
 *
 * ## Why this reads `purchase_orders` directly rather than the aging repository
 *
 * `billsSummary`/`invoicesSummary` reuse `aging.repository.ts` because "outstanding" there
 * is total minus allocations against a posted journal — a purchase order has neither (D-M3).
 * Its three buckets are instead stored-column predicates exactly as
 * `purchase-orders.repository.ts`'s `selectPurchaseOrdersPage` already expresses them:
 * `draft` is `approved_at IS NULL`, `approved` is approved-but-not-`converted_bill_id`, and
 * `converted` is `converted_bill_id IS NOT NULL`. Reading the per-row net/tax SUM directly
 * here, rather than paging through `selectPurchaseOrdersPage`, is what lets a single figure
 * see every purchase order the org has.
 *
 * ## Why there is no "expired" bucket, where estimates have one
 *
 * An estimate's `expiryDate` is a lapse — an approved estimate past it has gone stale — so
 * `estimatesSummary` derives an "expired" figure from it. A purchase order's `expectedDate`
 * is instead an informational delivery date: a PO does not lapse, it waits. So the middle
 * card counts the approved-but-unconverted commitment rather than an expiry comparison.
 *
 * ## Why `asOf` defaults to today, where the aging report refuses to
 *
 * D-40 makes an aging report reproducible, so it will not default to a moving target. This
 * is not that: it is what the screen shows *now*, a live snapshot, so today is the only
 * sensible default and a caller that omits the date gets it.
 */
export async function purchaseOrdersSummary(
  query: PurchaseOrdersSummaryQuery = {},
  ctx: RequestContext = getContext('purchaseOrdersSummary()'),
): Promise<PurchaseOrdersSummary> {
  await requirePermission(ctx, 'purchase_orders.read');
  const request = parseInput(purchaseOrdersSummaryQuerySchema, query);
  const asOf = request.asOf ?? todayCalendarDate();
  const windowStart = minusDays(asOf, 30);

  const db = orgScope(ctx);
  const rows = await db
    .selectFrom('purchase_orders')
    .select([
      'purchase_orders.approved_at',
      'purchase_orders.converted_bill_id',
      'purchase_orders.converted_at',
      NET_EXPRESSION.as('net'),
      TAX_EXPRESSION.as('tax'),
    ])
    .execute();

  let draftValue = 0n;
  let draftCount = 0;
  let approvedValue = 0n;
  let approvedCount = 0;
  let convertedValue = 0n;
  let convertedCount = 0;

  for (const row of rows) {
    const gross = toBigInt(row.net) + toBigInt(row.tax);

    if (row.approved_at === null) {
      // Draft: the same `approved_at IS NULL` predicate `selectPurchaseOrdersPage` filters
      // `draft` with — a purchase order holds no number until it is approved.
      draftValue += gross;
      draftCount += 1;
    } else if (row.converted_bill_id === null) {
      // Approved and awaiting conversion: numbered but not yet turned into a bill.
      approvedValue += gross;
      approvedCount += 1;
    } else if (row.converted_at !== null) {
      // `chk_purchase_orders_converted` ties the two columns together, so a non-null
      // `converted_bill_id` always carries a non-null `converted_at` — the narrowing here is
      // for the compiler, not a case the data produces.
      const convertedDate = row.converted_at.toISOString().slice(0, 10);
      if (convertedDate >= windowStart && convertedDate <= asOf) {
        convertedValue += gross;
        convertedCount += 1;
      }
    }
  }

  return {
    asOf,
    draftValue: draftValue.toString(),
    draftCount,
    approvedValue: approvedValue.toString(),
    approvedCount,
    convertedValue: convertedValue.toString(),
    convertedCount,
  };
}

/**
 * Per-purchase-order net/tax, the SUM over its lines. Spelled out here rather than shared
 * from the repository for `estimatesSummary`'s reason: that file's line reads are private to
 * the keyset page, and exporting them for one other caller would tie a paging concern to
 * this one's shape.
 */
const NET_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.line_amount_minor), 0) FROM purchase_order_lines l
  WHERE l.org_id = purchase_orders.org_id AND l.purchase_order_id = purchase_orders.id
)`;

const TAX_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.tax_amount_minor), 0) FROM purchase_order_lines l
  WHERE l.org_id = purchase_orders.org_id AND l.purchase_order_id = purchase_orders.id
)`;

/** `SUM` columns arrive as a DECIMAL string; plain `BIGINT` columns as a `bigint`. */
function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/** `YYYY-MM-DD` in UTC — the timezone the pool and the `DATE` columns already use. */
function todayCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `date` shifted back `days` whole days, in UTC.
 *
 * Through `Date.UTC` from the parsed parts for `aging.service.ts`'s reason: a local midnight
 * subtraction spans 23 or 25 hours across a DST boundary. `Date.UTC` carries the month/year
 * underflow, so 30 days before the 5th of a month lands in the previous one without a
 * special case.
 */
function minusDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // `calendarDateSchema` parsed anything a caller sent, and today's date is built above; a
    // malformed value here is a fault in this process, not input.
    throw new InternalError(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  return new Date(Date.UTC(year, month - 1, day - days)).toISOString().slice(0, 10);
}
