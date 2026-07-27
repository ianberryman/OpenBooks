import type { ReactElement } from 'react';

import { Button } from '../../components';
import { cx } from '../../lib/cx';
import type { Account } from './accounts-api';
import type { AccountTreeRow } from './tree';
import { ACCOUNT_TYPE_LABELS, NORMAL_BALANCE_LABELS } from './vocabulary';

/**
 * The chart, as a tree, in code order.
 *
 * Indentation carries the hierarchy for anyone who can see it, and it is the only thing
 * that does — so each child also names its parent's code in text. A row that is nested by
 * padding alone reads as a flat list to a screen reader, and "which account does this roll
 * up into" is the question the tree exists to answer.
 */
const INDENT_CLASSES: readonly string[] = ['', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'];

const CELL = 'px-3 py-2 align-top';
const HEADER_CELL = 'px-3 py-2 text-left text-xs font-medium text-text-muted';

export interface AccountTableProps {
  readonly rows: readonly AccountTreeRow[];
  readonly onEdit: (account: Account) => void;
  readonly onRemove: (account: Account) => void;
  readonly onSetActive: (account: Account, isActive: boolean) => void;
  readonly busyAccountId: string | null;
}

export function AccountTable({
  rows,
  onEdit,
  onRemove,
  onSetActive,
  busyAccountId,
}: AccountTableProps): ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">
          Chart of accounts, ordered by code, with each account nested under the one it rolls up
          into.
        </caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={HEADER_CELL}>
              Code
            </th>
            <th scope="col" className={HEADER_CELL}>
              Name
            </th>
            <th scope="col" className={HEADER_CELL}>
              Type
            </th>
            <th scope="col" className={HEADER_CELL}>
              Normal balance
            </th>
            <th scope="col" className={HEADER_CELL}>
              Status
            </th>
            <th scope="col" className={cx(HEADER_CELL, 'text-right')}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ account, depth, parent, detached }) => (
            <tr key={account.id} className="border-b border-border last:border-b-0">
              <td className={cx(CELL, 'font-mono whitespace-nowrap')}>{account.code}</td>

              <td className={CELL}>
                <div className={INDENT_CLASSES[Math.min(depth, INDENT_CLASSES.length - 1)] ?? ''}>
                  <span className={account.isActive ? 'text-text' : 'text-text-muted'}>
                    {account.name}
                  </span>
                  {parent !== null && (
                    <p className="text-xs text-text-subtle">Rolls up into {parent.code}</p>
                  )}
                  {detached && (
                    <p className="text-xs text-text-subtle">
                      Rolls up into an account that is not on the pages loaded yet.
                    </p>
                  )}
                  {account.description !== null && (
                    <p className="text-xs text-text-subtle">{account.description}</p>
                  )}
                </div>
              </td>

              <td className={cx(CELL, 'whitespace-nowrap text-text-muted')}>
                {ACCOUNT_TYPE_LABELS[account.type]}
              </td>

              <td className={cx(CELL, 'whitespace-nowrap text-text-muted')}>
                {NORMAL_BALANCE_LABELS[account.normalBalance]}
              </td>

              <td className={cx(CELL, 'whitespace-nowrap')}>
                <span className={account.isActive ? 'text-text-muted' : 'text-warning-text'}>
                  {account.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>

              <td className={cx(CELL, 'whitespace-nowrap text-right')}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onEdit(account);
                    }}
                  >
                    Edit
                  </Button>
                  {/*
                    Deactivation and deletion stay two controls here as well as in the
                    dialog: one takes an account out of circulation and keeps its history,
                    the other removes a row that has no history to keep. Collapsing them
                    into "Remove" would make the reversible one look like the destructive
                    one and hide the fact that only one of them is ever available for a
                    posted account.
                  */}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyAccountId === account.id}
                    onClick={() => {
                      onSetActive(account, !account.isActive);
                    }}
                  >
                    {account.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger-text"
                    onClick={() => {
                      onRemove(account);
                    }}
                  >
                    Delete…
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
