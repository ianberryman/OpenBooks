import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogContent,
  ErrorBanner,
  FieldError,
  MoneyInput,
  ResponsiveTable,
  formatMoney,
} from '../../components';
import type { BillSummary } from './queries';

/**
 * Applying a vendor credit to bills (OB-069; D-39, D-37, C3).
 *
 * A vendor credit is a document, not a negative bill: approving it makes credit
 * available, and reducing a particular bill is a **separate fact**, written through the
 * same allocation mechanism a payment uses. That is what gives "what is outstanding" one
 * definition regardless of what reduced it.
 *
 * Every figure here is the server's. `outstanding` on each bill and on the credit is
 * computed on read (D-34), and this dialog neither sums allocations nor predicts what a
 * bill will be left owing — it sends amounts and re-reads. Over-allocating one bill is
 * refused by the service (C3) and arrives as a refusal with its own message; the local
 * checks below are only the ones the *request* cannot express, exactly as in the editor.
 */
export interface AllocateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly creditNumber: string;
  /** What is still available on the credit, from the server (D-34). */
  readonly creditOutstanding: string;
  readonly bills: readonly BillSummary[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly onApply: (allocations: readonly { targetId: string; amount: string }[]) => void;
}

/**
 * `bigint`, not `number`, and not because the amounts are large: `Number('9007199254740993')`
 * is silently 9007199254740992, and the ceiling is invisible (D-13). Nothing here divides,
 * so `bigint` is the whole of the arithmetic — this picks the smaller of two wire amounts
 * and does nothing else with them.
 */
function lesserOf(left: string, right: string): string {
  return BigInt(left) <= BigInt(right) ? left : right;
}

function isPositive(amount: string): boolean {
  return BigInt(amount) > 0n;
}

export function AllocateDialog({
  open,
  onOpenChange,
  creditNumber,
  creditOutstanding,
  bills,
  isPending,
  error,
  onApply,
}: AllocateDialogProps): ReactElement {
  const [amounts, setAmounts] = useState<ReadonlyMap<string, string | null>>(() => new Map());

  /**
   * Only the bills this credit can actually reduce: approved or part paid, with something
   * still owed. Filtered on the server's own `status` and `settlement.outstanding` — this
   * is reading two computed fields, not recomputing them (D-34, D-38).
   */
  const applicable = useMemo(
    () =>
      bills.filter(
        (bill) =>
          bill.status !== 'draft' &&
          bill.status !== 'void' &&
          isPositive(bill.settlement.outstanding),
      ),
    [bills],
  );

  const entered = applicable
    .map((bill) => ({ targetId: bill.id, amount: amounts.get(bill.id) ?? null }))
    .filter((row): row is { targetId: string; amount: string } => row.amount !== null)
    .filter((row) => isPositive(row.amount));

  const presented = error === null || error === undefined ? null : presentApiError(error);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Apply vendor credit ${creditNumber}`}
        description={
          `${formatMoney(creditOutstanding)} of this credit is still available. Applying it ` +
          `to a bill is a separate fact from approving it, and it is what reduces what is owed.`
        }
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={isPending || entered.length === 0}
              onClick={() => onApply(entered)}
            >
              {isPending ? 'Applying…' : 'Apply credit'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {presented !== null && <ErrorBanner error={error} />}

          {applicable.length === 0 ? (
            <p className="text-sm text-text-muted">
              This vendor has no approved bill with anything still owed on it. A credit can only be
              applied to a bill that has been approved.
            </p>
          ) : (
            <ResponsiveTable>
              <table className="w-full border-collapse">
                <caption className="sr-only">Bills this credit can be applied to</caption>
                <thead>
                  <tr className="text-left text-xs text-text-subtle">
                    <th scope="col" className="p-1 font-medium">
                      Bill
                    </th>
                    <th scope="col" className="p-1 text-right font-medium">
                      Still owed
                    </th>
                    <th scope="col" className="p-1 text-right font-medium">
                      Apply
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {applicable.map((bill) => {
                    const label = bill.documentNumber ?? bill.id;
                    return (
                      <tr key={bill.id} className="align-top">
                        <td className="p-1">
                          <span className="font-mono text-base text-text">{label}</span>
                          {bill.reference !== null && (
                            <span className="block text-xs text-text-subtle">
                              Vendor’s number {bill.reference}
                            </span>
                          )}
                        </td>
                        <td className="p-1 text-right font-mono text-base tabular-nums text-text">
                          {formatMoney(bill.settlement.outstanding)}
                        </td>
                        <td className="w-32 p-1">
                          <MoneyInput
                            aria-label={`Apply to bill ${label}`}
                            value={amounts.get(bill.id) ?? null}
                            disabled={isPending}
                            onValueChange={(amount) => {
                              setAmounts((current) => new Map(current).set(bill.id, amount));
                            }}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => {
                              setAmounts((current) =>
                                new Map(current).set(
                                  bill.id,
                                  lesserOf(bill.settlement.outstanding, creditOutstanding),
                                ),
                              );
                            }}
                          >
                            Use the smaller of the two
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ResponsiveTable>
          )}

          {entered.length === 0 && applicable.length > 0 && (
            <FieldError>Enter an amount against at least one bill.</FieldError>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
