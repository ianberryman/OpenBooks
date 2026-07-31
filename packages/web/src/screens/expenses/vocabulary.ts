import type { PillTone } from '../../components';
import type { ExpenseStatus } from './queries';

/**
 * The words this screen uses for `status` — computed, never stored (D-38), and read here
 * exactly as the server states it. `void` is included even though nothing on this screen
 * ever produces it: an expense is a bill, and the existing bill void (out of this
 * screen's scope) can still leave one in that state, which this list must still be able
 * to show rather than crash on an enum value it did not expect.
 */
export const STATUS_LABELS: Readonly<Record<ExpenseStatus, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  part_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};

export const STATUS_TONE: Readonly<Record<ExpenseStatus, PillTone>> = {
  draft: 'muted',
  approved: 'neutral',
  part_paid: 'neutral',
  paid: 'positive',
  void: 'negative',
};

/**
 * Once approved, the expense has posted its journal and is owed to the employee — the
 * same payable a vendor bill becomes, settled by the same screen (D-M2: "reimbursement is
 * Pay Bills settling this same document once approved; there is no separate reimbursement
 * request"). Shown wherever a status leaves `draft` behind, so nobody goes looking on this
 * screen for a reimbursement action that lives elsewhere.
 */
export function payableHint(status: ExpenseStatus): string | null {
  if (status === 'draft' || status === 'void') return null;
  return 'Payable via Pay Bills.';
}
