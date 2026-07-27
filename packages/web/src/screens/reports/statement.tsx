import type { ReactElement } from 'react';

import { cx } from '../../lib/cx';
import { AmountCell, DrillLink, isZeroAmount } from './cells';
import type { HierarchyRow } from './tree';
import { buildRowTree, pruneZeroRows } from './tree';

/**
 * The section table both statements are built from (OB-052; B7).
 *
 * The P&L's rows and the balance sheet's are the same shape — a code, a name, the
 * account's **own** amount, and the subtotal of its subtree — so they get one renderer.
 * Which sections a statement has, what its bottom line is called, and which way its
 * numbers point are each report's own decisions and are made in its own file.
 *
 * ## The double-count trap, which is what this component exists to get right
 *
 * `amount` is the account's own postings. `subtotal` is that plus every descendant's
 * `amount`. A section's `total` is the sum of the **`amount`s**, not of the subtotals —
 * summing the subtotals counts each parent's subtree once per level of the hierarchy, and
 * the result is a plausible-looking statement that is wrong by an amount that grows with
 * the depth of the chart.
 *
 * So this component prints the server's `total` and never adds anything up, and it prints
 * `amount` and `subtotal` in two separate columns so a reader can see which is which. The
 * subtotal column is left empty on a leaf, where the two are equal by definition.
 */

export interface StatementRow extends HierarchyRow {
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly amount: string;
  readonly subtotal: string;
}

export interface StatementSectionProps<Row extends StatementRow> {
  readonly title: string;
  readonly rows: readonly Row[];
  readonly total: string;
  readonly totalLabel: string;
  readonly hideZeroRows: boolean;
  readonly onDrillThrough: (accountId: string) => void;
}

export function StatementSection<Row extends StatementRow>({
  title,
  rows,
  total,
  totalLabel,
  hideZeroRows,
  onDrillThrough,
}: StatementSectionProps<Row>): ReactElement {
  const tree = buildRowTree(rows);
  const visible = hideZeroRows
    ? pruneZeroRows(tree, (row) => isZeroAmount(row.amount) && isZeroAmount(row.subtotal))
    : tree;

  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold tracking-wide text-text-muted uppercase">{title}</h4>
      {/* Named, because a statement puts two or three of these on one page with identical
          column headers, and an unnamed table is "table" three times to a screen reader. */}
      <table aria-label={title} className="w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-border text-xs text-text-subtle">
            <th scope="col" className="px-3 py-1 text-left font-medium">
              Account
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Subtotal
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={3} className="px-3 py-2 text-text-subtle">
                {hideZeroRows ? 'Every account in this section stands at zero.' : 'No accounts.'}
              </td>
            </tr>
          )}
          {visible.map(({ row, depth, hasChildren }) => (
            <tr key={row.accountId} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-1 text-left font-normal">
                <span
                  className="flex items-baseline gap-2"
                  // Indentation is the hierarchy, so it is a real offset rather than a
                  // class per depth: a chart may nest deeper than any fixed set of classes.
                  style={{ paddingInlineStart: `calc(var(--spacing) * ${String(depth * 4)})` }}
                >
                  <span className="font-mono text-xs text-text-subtle">{row.code}</span>
                  <DrillLink
                    onClick={() => {
                      onDrillThrough(row.accountId);
                    }}
                    title="Show the entries behind this line"
                  >
                    <span className={cx(hasChildren && 'font-medium')}>{row.name}</span>
                  </DrillLink>
                  {!row.isActive && <span className="text-xs text-text-subtle">(inactive)</span>}
                </span>
              </th>
              <AmountCell value={row.amount} />
              {/* Empty on a leaf: `subtotal` equals `amount` there, and printing one figure
                  twice is an invitation to total the wrong column. */}
              <AmountCell value={hasChildren ? row.subtotal : null} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong">
            <th scope="row" className="px-3 py-1 text-left font-semibold">
              {totalLabel}
            </th>
            {/* The server's own total, under the Amount column it is the sum of. */}
            <AmountCell value={total} emphasis />
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/**
 * The one-line explanation of the two columns, printed once per statement.
 *
 * Worth the space because the distinction is invisible in the numbers themselves on any
 * chart without a posting parent, which is most charts most of the time.
 */
export function SubtotalNote(): ReactElement {
  return (
    <p className="text-xs text-text-subtle">
      <strong className="font-medium">Amount</strong> is the account&rsquo;s own postings;{' '}
      <strong className="font-medium">Subtotal</strong> adds every account beneath it (B7). A
      section total is the sum of the Amount column — adding the subtotals would count each subtree
      once per level.
    </p>
  );
}
