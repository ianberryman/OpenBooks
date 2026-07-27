import type { ReactElement, ReactNode } from 'react';

import { formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import type { ReportGroupKey } from './filters';

/**
 * The cells every statement is made of: an amount, and the control that drills through it.
 *
 * Nothing here does arithmetic. Every figure a report prints — each row's amount, each
 * subtotal, every section total, the difference — arrives from the server already summed
 * in exact `bigint` minor units, and this layer's whole job is to place a string in the
 * right column. That is not only D-13's rule about `cents / 100`; it is also the reason a
 * wrong total cannot originate here (B7).
 */

/** `"0"` and `"-0"` are both canonical on the wire (`src/money/format.ts`). */
export function isZeroAmount(wireAmount: string): boolean {
  return wireAmount === '0' || wireAmount === '-0';
}

function isNegativeAmount(wireAmount: string): boolean {
  return wireAmount.startsWith('-') && wireAmount !== '-0';
}

export function Amount({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string | undefined;
}): ReactElement {
  return (
    <span
      className={cx(
        /**
         * Tabular figures and a monospace face, matching `MoneyInput`. A financial
         * statement is a column of digits read by scanning down it, and a proportional
         * font makes a mis-keyed magnitude the same width as a correct one.
         */
        'font-mono tabular-nums',
        isNegativeAmount(value) ? 'text-amount-negative' : 'text-amount-positive',
        className,
      )}
    >
      {formatMinorUnits(value)}
    </span>
  );
}

export function AmountCell({
  value,
  className,
  emphasis,
}: {
  readonly value: string | null;
  readonly className?: string | undefined;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <td className={cx('px-3 py-1 text-right whitespace-nowrap', className)}>
      {value === null ? (
        <span aria-hidden className="text-text-subtle">
          —
        </span>
      ) : (
        <Amount value={value} className={emphasis === true ? 'font-semibold' : undefined} />
      )}
    </td>
  );
}

/**
 * The drill-through control: a report figure that opens the entries behind it.
 *
 * A button rather than an anchor. The general ledger *is* linkable — the routes chose
 * `GET` partly so it would be (`transport/routes/reports.ts`) — but the route table
 * belongs to the shell, not to this screen, so the deep link is a URL this ticket cannot
 * mint. A control that navigates is a button until it has an href.
 */
export function DrillLink({
  onClick,
  children,
  title,
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly title?: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx(
        'rounded-sm text-left text-text underline-offset-2 hover:underline',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
      )}
    >
      {children}
    </button>
  );
}

/**
 * A bucket's name. `null` is the unassigned bucket, which every grouped report carries and
 * no view may omit — a slice view that dropped untagged lines would show a smaller
 * business than exists, and it would do it most on the accounts nobody remembered to tag
 * (D-18).
 */
export function groupLabel(key: ReportGroupKey | null): string {
  return key === null ? 'Unassigned' : `${key.code} — ${key.name}`;
}

export function GroupHeading({
  groupKey,
}: {
  readonly groupKey: ReportGroupKey | null;
}): ReactElement {
  return (
    <div className="flex items-baseline gap-2 border-b border-border-strong pb-1">
      <h3 className="text-md font-semibold text-text">{groupLabel(groupKey)}</h3>
      {groupKey === null && (
        <span className="text-xs text-text-subtle">lines carrying no value on this axis</span>
      )}
    </div>
  );
}
