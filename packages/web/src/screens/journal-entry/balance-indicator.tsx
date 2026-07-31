import type { ReactElement } from 'react';

import { formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { absolute, toWireAmount } from './balance';
import type { BalanceTotals } from './balance';

/**
 * The live balancing indicator: debits, credits, and what separates them.
 *
 * `role="status"` with a polite live region, because the number that matters changes in
 * response to typing in a *different* field — the user is looking at the amount box, not
 * at this panel, and a difference that only ever appears visually is invisible to
 * exactly the people who cannot glance at it.
 *
 * It states what the entry currently is and never what the server will say about it.
 * "In balance" is not "postable": the kernel checks arity, balance and one-sidedness
 * together and answers as one `validation_failed` naming `lines` (D-19 and the header
 * in `balance.ts`), and a panel that promised more than it knows would be wrong at
 * exactly the moment a user relied on it.
 */
export interface BalanceIndicatorProps {
  readonly totals: BalanceTotals;
  /** The server's own word on the line set, when a post has been refused for it. */
  readonly linesError?: string | undefined;
}

function Amount({
  label,
  value,
  emphasis,
}: {
  readonly label: string;
  readonly value: bigint;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-text-subtle">{label}</dt>
      <dd
        className={cx(
          'font-mono text-md tabular-nums',
          emphasis === true ? 'text-amount-negative' : 'text-amount-positive',
        )}
      >
        {formatMoney(toWireAmount(value))}
      </dd>
    </div>
  );
}

export function BalanceIndicator({ totals, linesError }: BalanceIndicatorProps): ReactElement {
  const balanced = totals.difference === 0n;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'flex flex-wrap items-start gap-6 rounded-lg border p-3',
        balanced && totals.entered
          ? 'border-success-border bg-success-soft'
          : 'border-border bg-surface-sunken',
      )}
    >
      <dl className="flex flex-wrap gap-6">
        <Amount label="Total debits" value={totals.debits} />
        <Amount label="Total credits" value={totals.credits} />
        <Amount
          label={balanced ? 'Difference' : 'Out of balance by'}
          value={absolute(totals.difference)}
          emphasis={!balanced}
        />
      </dl>

      <p className="min-w-0 flex-1 text-sm text-text-muted">
        {!totals.entered
          ? 'Nothing entered yet.'
          : balanced
            ? 'Debits equal credits.'
            : totals.difference > 0n
              ? 'Debits exceed credits.'
              : 'Credits exceed debits.'}
      </p>

      {linesError !== undefined && (
        <p role="alert" className="w-full text-sm text-danger-text">
          {linesError}
        </p>
      )}
    </div>
  );
}
