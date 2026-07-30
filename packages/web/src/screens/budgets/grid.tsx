import type { ReactElement } from 'react';
import { useState } from 'react';

import { MoneyInput } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { Account, Budget } from './queries';

/**
 * The grid one save covers: every active revenue and expense account, each with an
 * editable amount for the chosen period and slice.
 *
 * ## Why this remounts on a `key` rather than reacting to its own props
 *
 * `AssetFormContent` (`fixed-assets/asset-form.tsx`) seeds its state once, from a `useState`
 * initializer, and relies on the caller keying the whole subtree so a second edit starts
 * fresh. This grid does the same for the same reason: the amounts are draft state the user
 * is actively typing into, and re-deriving them from `budgets` on every render would
 * overwrite a keystroke the instant the list refetches (a background refetch, a slow
 * network reordering with a keystroke). `BudgetsScreen` keys this component on
 * `${periodId}:${dimensionValueId ?? 'total'}`, so switching the slice remounts it with a
 * fresh initializer and staying on one slice never does.
 *
 * ## What "changed" means for the save button
 *
 * Only accounts the user has actually edited in this slice travel in the batch — `queries.ts`'s
 * `useSetBudgets` sends exactly the entries it is given, and this grid is what decides which
 * those are. Typing into a field marks its account dirty; the account-total or per-value
 * figure that came back from the server and was never touched is left alone, so re-saving
 * one changed row never resends every other row's amount as a no-op write.
 */
export interface BudgetGridProps {
  readonly accounts: readonly Account[];
  /** This slice's existing budgets, already filtered to the chosen account-total or
   *  dimension value (`budgetsForSlice`). */
  readonly budgets: readonly Budget[];
  readonly disabled: boolean;
  /** Called with the full set of edited amounts whenever one changes, so the screen can
   *  build the batch at save time without this component knowing about idempotency keys
   *  or the mutation itself. */
  readonly onDirtyChange: (entries: ReadonlyMap<string, string>) => void;
}

function initialAmounts(budgets: readonly Budget[]): ReadonlyMap<string, string> {
  return new Map(budgets.map((budget) => [budget.accountId, budget.amount]));
}

export function BudgetGrid({
  accounts,
  budgets,
  disabled,
  onDirtyChange,
}: BudgetGridProps): ReactElement {
  const [saved] = useState<ReadonlyMap<string, string>>(() => initialAmounts(budgets));
  const [amounts, setAmounts] = useState<ReadonlyMap<string, string>>(saved);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());

  function edit(accountId: string, value: string | null): void {
    const nextAmounts = new Map(amounts);
    if (value === null) nextAmounts.delete(accountId);
    else nextAmounts.set(accountId, value);
    setAmounts(nextAmounts);

    const nextDirty = new Set(dirty);
    nextDirty.add(accountId);
    setDirty(nextDirty);

    const entries = new Map<string, string>();
    for (const id of nextDirty) {
      const amount = nextAmounts.get(id);
      if (amount !== undefined) entries.set(id, amount);
    }
    onDirtyChange(entries);
  }

  const revenue = accounts.filter((account) => account.type === 'revenue');
  const expense = accounts.filter((account) => account.type === 'expense');

  return (
    <table className={TABLE_CLASSES}>
      <caption className="sr-only">Budgeted amounts</caption>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASSES}>
            Account
          </th>
          <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
            Budgeted amount
          </th>
        </tr>
      </thead>
      <tbody>
        {accounts.length === 0 && <EmptyRow columns={2}>No revenue or expense accounts.</EmptyRow>}
        {revenue.length > 0 && <SectionRow label="Revenue" />}
        {revenue.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            value={amounts.get(account.id) ?? null}
            disabled={disabled}
            onValueChange={(value) => {
              edit(account.id, value);
            }}
          />
        ))}
        {expense.length > 0 && <SectionRow label="Expenses" />}
        {expense.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            value={amounts.get(account.id) ?? null}
            disabled={disabled}
            onValueChange={(value) => {
              edit(account.id, value);
            }}
          />
        ))}
      </tbody>
    </table>
  );
}

function SectionRow({ label }: { readonly label: string }): ReactElement {
  return (
    <tr>
      <th scope="colgroup" colSpan={2} className={cx(TH_CLASSES, 'bg-surface-sunken text-left')}>
        {label}
      </th>
    </tr>
  );
}

function AccountRow({
  account,
  value,
  disabled,
  onValueChange,
}: {
  readonly account: Account;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onValueChange: (value: string | null) => void;
}): ReactElement {
  return (
    <tr>
      <td className={TD_CLASSES}>
        <span className="font-mono text-xs text-text-subtle">{account.code}</span> {account.name}
      </td>
      <td className={cx(TD_CLASSES, 'text-right')}>
        <MoneyInput
          aria-label={`${account.name} budgeted amount`}
          value={value}
          disabled={disabled}
          onValueChange={onValueChange}
          className="ml-auto w-40"
        />
      </td>
    </tr>
  );
}
