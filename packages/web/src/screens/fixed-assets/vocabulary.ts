import type { FixedAssetMethod } from './queries';

/**
 * The words this screen uses for a `method` — `recurring-invoices/vocabulary.ts`'s shape,
 * sized to what a fixed asset actually has: two methods, both explained where the choice is
 * made rather than left for the first posted period to demonstrate.
 */

export const METHOD_LABELS: Readonly<Record<FixedAssetMethod, string>> = {
  straight_line: 'Straight-line',
  declining_balance: 'Declining balance',
};

export const METHOD_OPTIONS: ReadonlyArray<{ value: FixedAssetMethod; label: string }> = [
  { value: 'straight_line', label: METHOD_LABELS.straight_line },
  { value: 'declining_balance', label: METHOD_LABELS.declining_balance },
];

/**
 * `straight_line` charges an equal amount every period; `declining_balance` charges a fixed
 * rate of the remaining book value, floored at salvage (D-114) — `FixedAsset.method`'s own
 * description, said in full at the control the way `recurring-invoices/vocabulary.ts`'s
 * `MATERIALIZATION_MODE_EXPLANATIONS` says its pair.
 */
export const METHOD_EXPLANATIONS: Readonly<Record<FixedAssetMethod, string>> = {
  straight_line:
    '(acquisition cost − salvage value) ÷ useful life, charged in equal installments every ' +
    'period.',
  declining_balance:
    'A fixed rate of the remaining book value each period, floored at the salvage value — ' +
    'never depreciates below it.',
};

export function isMethod(value: string): value is FixedAssetMethod {
  return value === 'straight_line' || value === 'declining_balance';
}
