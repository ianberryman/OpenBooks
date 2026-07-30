import type { PillTone } from '../settings/section';
import type { EstimateStatus } from './queries';

/**
 * The words this screen uses for a stored (not computed, D-M6) `status` —
 * `fixed-assets/vocabulary.ts`'s shape, sized to the three states an estimate moves
 * through in order: `draft` → `approved` → `converted`.
 */

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
