import type { PillTone } from '../../components';
import type { PurchaseOrderStatus } from './queries';

/**
 * The words this screen uses for `status` — `fixed-assets/vocabulary.ts`'s shape, sized to
 * the three states a purchase order actually stores (D-M6): `draft` until approved,
 * `approved` once a gapless number is allocated, `converted` once it has produced a bill.
 */

/**
 * One document kind, so a pair of constants rather than a lookup keyed by kind
 * (`estimates/vocabulary.ts`'s reason) — the header and the list read these rather than
 * hardcoding "Purchase order"/"Purchase orders" at each call site.
 */
export const SINGULAR = 'Purchase order';
export const PLURAL = 'Purchase orders';

export const STATUS_LABELS: Readonly<Record<PurchaseOrderStatus, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  converted: 'Converted',
};

export const STATUS_TONES: Readonly<Record<PurchaseOrderStatus, PillTone>> = {
  draft: 'muted',
  approved: 'positive',
  converted: 'neutral',
};
