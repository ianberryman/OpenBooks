import type { PillTone } from '../../components';
import type { PurchaseOrder, PurchaseOrderSummary } from './queries';
import { STATUS_LABELS, STATUS_TONES } from './vocabulary';

/**
 * The status helpers read only `status`, which the list summary and the full purchase order
 * both carry — so the detail header and the list draw their pills from one definition rather
 * than two, the AP-side mirror of `estimates/estimate-presentation.ts`.
 */
type PurchaseOrderItem = PurchaseOrderSummary | PurchaseOrder;

/**
 * Presentation helpers for the purchase-orders list (PO redesign, matching the bill/estimate
 * treatment).
 *
 * ## No "expired" here, unlike estimates
 *
 * An estimate's `estimate-presentation.ts` derives an "Expired" display state from
 * `expiryDate < asOf`: an approved estimate that has lapsed. A purchase order does not lapse
 * — its `expectedDate` is an informational delivery date — so there is no derived fourth
 * state. The pill is just the stored `status` (D-M6): `draft` → `approved` → `converted`.
 *
 * ## Why the card filter and the sort are client-side
 *
 * Each summary card narrows the page already loaded to one lifecycle state rather than
 * refetching, and the default order is client-side too. `status` and `expectedDate` are the
 * server's; the helpers below only read them. (`/v1/purchase-orders` does offer a `status`
 * filter, but the cards double as a client toggle over the same page the search box narrows,
 * so both live here for one consistent narrowing.)
 */
export type PurchaseOrderCardFilter = 'draft' | 'approved' | 'converted';

/**
 * The status pill shown on the list and the detail header, one purchase order at a time —
 * read straight off the stored `status` through the `vocabulary.ts` maps, since a PO has no
 * date-derived state to override it with.
 */
export function statusPresentation(item: PurchaseOrderItem): { label: string; tone: PillTone } {
  return { label: STATUS_LABELS[item.status], tone: STATUS_TONES[item.status] };
}

/**
 * The subset of purchase orders each summary card stands for, so tapping the card narrows the
 * list to exactly what the card counts. `status` is the server's; this only reads it.
 */
export function matchesCardFilter(
  item: PurchaseOrderItem,
  filter: PurchaseOrderCardFilter,
): boolean {
  return item.status === filter;
}

/**
 * The purchase-orders list's default order: what is not yet converted first, then by
 * expected date so the soonest-awaited rise to the top. A converted purchase order sorts
 * after every open one, whatever its date. One with no expected date sorts last within its
 * group. `status` and `expectedDate` are the server's; this only reads them to order the
 * page, and reorders nothing on the server.
 */
export function comparePurchaseOrdersForList(
  a: PurchaseOrderSummary,
  b: PurchaseOrderSummary,
): number {
  const aConverted = a.status === 'converted' ? 1 : 0;
  const bConverted = b.status === 'converted' ? 1 : 0;
  if (aConverted !== bConverted) return aConverted - bConverted;

  const aExpected = a.expectedDate;
  const bExpected = b.expectedDate;
  if (aExpected === bExpected) return 0;
  if (aExpected === null) return 1;
  if (bExpected === null) return -1;
  return aExpected < bExpected ? -1 : 1;
}
