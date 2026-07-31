import type { ReactElement } from 'react';

import { Button, ResponsiveTable, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { BillSummary, ExpenseReferenceData } from './queries';
import { STATUS_LABELS, STATUS_TONE, payableHint } from './vocabulary';

/**
 * One page of expenses.
 *
 * `status` and `totals` are read off the response, never derived — computed server-side
 * (D-38) exactly as `purchases/document-list.tsx` reads them for a vendor bill, which an
 * expense is (D-M1). Approve and Discard are offered only on a draft: approving is the
 * one-way step that posts the journal and turns this into a payable (D-38), and there is
 * no expense-specific void here at all — a correction after approval is the existing bill
 * void, out of this screen's scope.
 */
export interface ExpenseListProps {
  readonly expenses: readonly BillSummary[];
  readonly reference: ExpenseReferenceData;
  readonly loading: boolean;
  readonly emptyMessage: string;
  /** The one expense a row action is in flight for, so a second row's buttons stay live
   *  while the first one's request is still out. */
  readonly busyId: string | null;
  readonly onEdit: (expense: BillSummary) => void;
  readonly onApprove: (expense: BillSummary) => void;
  readonly onDiscard: (expense: BillSummary) => void;
}

export function ExpenseList({
  expenses,
  reference,
  loading,
  emptyMessage,
  busyId,
  onEdit,
  onApprove,
  onDiscard,
}: ExpenseListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Employee expenses</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Expense number
            </th>
            <th scope="col" className={TH_CLASSES}>
              Employee
            </th>
            <th scope="col" className={TH_CLASSES}>
              Issued
            </th>
            <th scope="col" className={TH_CLASSES}>
              Due
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Total
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {expenses.length === 0 && (
            <EmptyRow columns={7}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {expenses.map((expense) => {
            const busy = busyId === expense.id;
            const hint = payableHint(expense.status);

            return (
              <tr key={expense.id}>
                <td className={TD_CLASSES}>
                  <button
                    type="button"
                    onClick={() => {
                      onEdit(expense);
                    }}
                    className="rounded-sm text-left font-mono text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                  >
                    {expense.documentNumber ?? 'Draft'}
                  </button>
                </td>
                <td className={TD_CLASSES}>
                  {reference.employeesById.get(expense.contactId)?.displayName ??
                    'Unknown employee'}
                </td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{expense.issueDate}</td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{expense.dueDate}</td>
                <td className={TD_CLASSES}>
                  <Pill tone={STATUS_TONE[expense.status]}>{STATUS_LABELS[expense.status]}</Pill>
                  {hint !== null && (
                    <span className="mt-1 block text-xs text-text-subtle">{hint}</span>
                  )}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMinorUnits(expense.totals.gross)}
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    {expense.status === 'draft' && (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            onEdit(expense);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy}
                          onClick={() => {
                            onApprove(expense);
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          aria-label={`Discard ${expense.documentNumber ?? 'draft expense'}`}
                          disabled={busy}
                          onClick={() => {
                            onDiscard(expense);
                          }}
                        >
                          Discard
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
