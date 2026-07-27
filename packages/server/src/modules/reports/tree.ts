import type { AccountType, NormalBalance } from '@openbooks/shared-types';

import { InternalError } from '../../errors';

import type { AccountBalance } from './amounts';
import { addAccountBalance } from './amounts';

/**
 * Rolling account balances up the chart of accounts (OB-041; acceptance B7).
 *
 * OB-035 made `parent_account_id` real and OB-039 gave it rules — a bounded
 * depth, no cycle, and a parent whose type equals its children's. B7 is what
 * those rules exist for: **a parent's subtotal equals the sum of its
 * descendants**, plus its own postings.
 *
 * Two things about the shape, both of which a report will lean on:
 *
 * **A parent may carry postings of its own.** Nothing in the schema makes a parent
 * a pure heading, and charts in the wild post to one — an "Office expenses" parent
 * with three children under it collects the entries nobody itemised. So a node
 * carries `row` (this account alone) *and* `subtotal` (this account plus
 * everything under it), and a report that printed only the subtotal against the
 * parent's name would be double-counting the moment it also printed the children.
 *
 * **Every row ends up in exactly one tree.** The forest is built from the rows
 * handed in, not from a second read of `accounts`, so the flat list and the forest
 * are the same numbers arranged two ways — which is what lets B7 be checked
 * against the report's own totals rather than against a separately computed sum.
 */

export interface AccountBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  readonly parentAccountId: string | null;
  /**
   * Inactive accounts are reported, not hidden, matching the trial balance's
   * treatment of accounts with no postings: an inactive account holding a balance
   * is exactly what someone reading a report needs to see. Whether to print it is
   * a presentation decision, and it belongs to the report that prints it.
   */
  readonly isActive: boolean;
  /** This account's own postings. Descendants are in the node's `subtotal`. */
  readonly balance: AccountBalance;
}

export interface AccountBalanceNode {
  /** The same object as the corresponding entry in the group's flat `rows`. */
  readonly row: AccountBalanceRow;
  /** `row.balance` plus every descendant's `row.balance`. Acceptance B7. */
  readonly subtotal: AccountBalance;
  readonly children: readonly AccountBalanceNode[];
}

interface MutableNode {
  readonly row: AccountBalanceRow;
  subtotal: AccountBalance;
  readonly children: MutableNode[];
}

/**
 * The forest of the given rows, roots first, siblings in the order the rows
 * arrived — which is account code order, because that is how the aggregation
 * sorts.
 *
 * A row whose parent is not among the rows becomes a root. That is unreachable
 * through the query this serves, since every filter it offers removes whole trees
 * rather than severing one: the account-type filter is safe because a parent's
 * type must equal its children's (`accounts/hierarchy.ts`), and no other filter
 * touches the `accounts` table at all. It is handled anyway, and handled by
 * promoting rather than dropping, because the alternative is a row that is in the
 * totals and in no subtotal — which would make B7 fail somewhere far from the
 * cause.
 */
export function buildAccountTree(
  rows: readonly AccountBalanceRow[],
): readonly AccountBalanceNode[] {
  const nodes = new Map<string, MutableNode>(
    rows.map((row) => [row.accountId, { row, subtotal: row.balance, children: [] }]),
  );

  const roots: MutableNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.accountId);
    if (node === undefined) continue;

    const parent = row.parentAccountId === null ? undefined : nodes.get(row.parentAccountId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  let reached = 0;
  for (const root of roots) reached += accumulate(root);

  // A stored cycle would leave its members unreachable from any root, and the
  // report would then quietly total more than its forest does. `hierarchy.ts`
  // takes the same position on the same fault: every write path enforces the
  // no-cycle rule, so a chart that holds one is a state this system should not
  // have been able to produce, and reporting it as the caller's mistake would send
  // someone looking in the wrong place.
  if (reached !== rows.length) {
    throw new InternalError(
      'The chart of accounts did not form a forest: some accounts are unreachable from any ' +
        'root, which means a parent chain closes on itself. Subtotals cannot be computed over ' +
        'a cycle, and no write path is supposed to be able to create one.',
    );
  }

  return roots;
}

/** Post-order, so a node's subtotal is assembled from children already finished. */
function accumulate(node: MutableNode): number {
  let counted = 1;
  let subtotal = node.row.balance;

  for (const child of node.children) {
    counted += accumulate(child);
    subtotal = addAccountBalance(subtotal, child.subtotal);
  }

  node.subtotal = subtotal;
  return counted;
}
