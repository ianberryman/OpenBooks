import type { PillTone } from '../../components';
import type { Estimate, EstimateSummary } from './queries';

/**
 * The status/expiry helpers read only `status`, `convertedInvoiceId` and `expiryDate`,
 * which the list summary and the full estimate both carry — so the detail header and the
 * list draw their pills from one definition rather than two, the same split
 * `sales/invoice-list.ts` makes for `SalesDocument | SalesDocumentSummary`.
 */
type EstimateItem = EstimateSummary | Estimate;

/**
 * Presentation helpers for the estimates list — the non-posting mirror of
 * `sales/invoice-list.ts`'s `statusPresentation` / `matchesCardFilter` /
 * `compareInvoicesForList` (estimates redesign, AGENT E-LEAVES).
 *
 * ## Expired is a derived display state, not a stored one
 *
 * `status` is stored, not derived (D-M6) — `draft` → `approved` → `converted` and nothing
 * else. "Expired" is not a fourth status: it is `expiryDate < asOf` read on top of
 * `approved`, the same kind of derivation `isOverdue` makes for invoices. An estimate that
 * has lapsed is still `approved` in the database; only the pill and the filter say
 * "Expired", and both say it from the same comparison so they cannot disagree.
 *
 * ## Why the card filter and the sort are client-side
 *
 * `open` spans two statuses (`draft`, `approved`) and `expired` is an expiry-date
 * comparison against `asOf` — neither is a filter `/v1/estimates` offers — so both narrow
 * the page already loaded rather than refetching. `status` and `expiryDate` are still the
 * server's; the helpers below only read them.
 */
export type EstimateCardFilter = 'open' | 'expired' | 'converted';

/**
 * Whether an estimate has lapsed: it was approved, it was never converted, it carries an
 * expiry date, and that date is behind `asOf`. Used both by `statusPresentation` and by
 * the list to color the expiry-date cell red — one definition of "expired" rather than two
 * that could drift apart.
 */
export function isExpired(item: EstimateItem, asOf: string): boolean {
  return (
    item.status === 'approved' &&
    item.convertedInvoiceId === null &&
    item.expiryDate !== null &&
    item.expiryDate < asOf
  );
}

/**
 * The status pill shown on the list and the detail header, one estimate at a time.
 *
 * `converted` and `draft` are named directly from `status`. What remains — `approved` —
 * is the mockup's "Approved" unless its expiry date has already passed, in which case it
 * reads "Expired" instead: a lapsed estimate is still labelled by the date, not by the
 * status column, exactly as an overdue invoice is on the AR side.
 */
export function statusPresentation(
  item: EstimateItem,
  asOf: string,
): { label: string; tone: PillTone } {
  if (item.status === 'converted') return { label: 'Converted', tone: 'positive' };
  if (item.status === 'draft') return { label: 'Draft', tone: 'muted' };

  if (isExpired(item, asOf)) return { label: 'Expired', tone: 'negative' };

  return { label: 'Approved', tone: 'accent' };
}

/**
 * The subset of estimates each summary card stands for, so tapping the card narrows the
 * list to exactly what the card counts. `status`, `convertedInvoiceId` and `expiryDate`
 * are still the server's; this only reads them.
 */
export function matchesCardFilter(
  item: EstimateItem,
  filter: EstimateCardFilter,
  asOf: string,
): boolean {
  switch (filter) {
    case 'open':
      return item.status !== 'converted';
    case 'expired':
      return isExpired(item, asOf);
    case 'converted':
      return item.status === 'converted';
  }
}

/**
 * The estimates list's default order: what is still open first, then by expiry date so the
 * soonest to lapse (and the already-expired) rise to the top. A converted estimate sorts
 * after every open one, whatever its date. An estimate with no expiry date sorts last
 * within its group. `status` and `expiryDate` are the server's; this only reads them to
 * order the page, and reorders nothing on the server.
 */
export function compareEstimatesForList(a: EstimateSummary, b: EstimateSummary): number {
  const aConverted = a.status === 'converted' ? 1 : 0;
  const bConverted = b.status === 'converted' ? 1 : 0;
  if (aConverted !== bConverted) return aConverted - bConverted;

  const aExpiry = a.expiryDate;
  const bExpiry = b.expiryDate;
  if (aExpiry === bExpiry) return 0;
  if (aExpiry === null) return 1;
  if (bExpiry === null) return -1;
  return aExpiry < bExpiry ? -1 : 1;
}
