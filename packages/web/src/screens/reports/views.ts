/**
 * The set of report tabs the Reports screen offers, as a leaf type.
 *
 * Extracted from `reports.tsx` (OB-220) so `reports/export-control.tsx` can name a
 * `ReportView` without importing the screen it is rendered inside — the screen
 * imports the control, so the control importing the screen back is the circular edge
 * `.dependency-cruiser.cjs`'s `no-circular` rejects. A bare union has no runtime and
 * no other dependency, so both the screen and the control depend on it downward.
 */
export type ReportView =
  | 'trial-balance'
  | 'profit-and-loss'
  | 'balance-sheet'
  | 'general-ledger'
  | 'cash-flow'
  | 'cash-flow-projection'
  | 'budget-vs-actual'
  | 'audit';
