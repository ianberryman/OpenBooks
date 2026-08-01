import type { PillTone } from '../../components';
import type { EstimateStatus } from './queries';

/**
 * The words this screen uses for a stored (not computed, D-M6) `status` —
 * `fixed-assets/vocabulary.ts`'s shape, sized to the three states an estimate moves
 * through in order: `draft` → `approved` → `converted`.
 */

/**
 * Unlike `sales/vocabulary.tsx`'s `vocabularyFor`, there is only one document kind here —
 * an estimate is never an invoice or a credit note wearing a different label — so this is
 * a pair of constants rather than a lookup keyed by kind. `estimate-header.tsx` reads these
 * rather than hardcoding "Estimate"/"Estimates" at each call site.
 */
export const SINGULAR = 'Estimate';
export const PLURAL = 'Estimates';

export const STATUS_LABELS: Readonly<Record<EstimateStatus, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  converted: 'Converted',
};

/** `settings/section.tsx`'s `Pill` tones — draft is unremarkable, approved is the state
 *  worth calling out (it is the one that can still be sent or converted), converted is a
 *  terminal state exactly as `fixed-assets/list.tsx` treats `disposed`. */
export const STATUS_PILL_TONE: Readonly<Record<EstimateStatus, PillTone>> = {
  draft: 'neutral',
  approved: 'positive',
  converted: 'muted',
};

export function isEstimateStatus(value: string): value is EstimateStatus {
  return value === 'draft' || value === 'approved' || value === 'converted';
}
