import type { ReactElement } from 'react';

import { formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';

/**
 * Signed cents, added exactly and printed once (ROADMAP D-13).
 *
 * ## Why there is arithmetic here at all, when the reports screen has none
 *
 * Every figure a report prints arrives already summed, so `screens/reports/cells.tsx` can
 * state that nothing in it does arithmetic. This screen cannot: an allocation form has to
 * say how much of a payment is still unassigned *while the user is typing into it*, and
 * that number exists nowhere on the server until the batch is sent.
 *
 * So the arithmetic is confined to this file and it is `bigint`. Not `number`: a cent
 * count above 2^53 rounds silently, which is the ceiling D-13 chose a string to escape,
 * and `cents / 100` yields `1234.5599999999999`. `BigInt('150000')` is exact at any
 * magnitude and `toString()` returns the canonical wire form the API accepts back.
 *
 * What is **not** computed here is anything the API already answers. `settlement.outstanding`
 * on a payment and on a document is the server's, computed on read from the allocations
 * (D-34), and re-deriving it from the allocation rows a screen happens to have loaded is
 * the second definition of outstanding that D-34 exists to prevent.
 */

/** `'0'` and `'-0'` are both canonical on the wire (`src/money/format.ts`). */
export function isZeroAmount(wireAmount: string): boolean {
  return wireAmount === '0' || wireAmount === '-0';
}

export function isNegativeAmount(wireAmount: string): boolean {
  return wireAmount.startsWith('-') && wireAmount !== '-0';
}

export function isPositiveAmount(wireAmount: string): boolean {
  return !isNegativeAmount(wireAmount) && !isZeroAmount(wireAmount);
}

export function sumMinorUnits(amounts: Iterable<string>): string {
  let total = 0n;
  for (const amount of amounts) total += BigInt(amount);
  return total.toString();
}

export function subtractMinorUnits(left: string, right: string): string {
  return (BigInt(left) - BigInt(right)).toString();
}

/** `-1`, `0` or `1`, in `Array.prototype.sort`'s convention. */
export function compareMinorUnits(left: string, right: string): number {
  const [a, b] = [BigInt(left), BigInt(right)];
  return a < b ? -1 : a > b ? 1 : 0;
}

export function exceeds(amount: string, limit: string): boolean {
  return compareMinorUnits(amount, limit) > 0;
}

/**
 * A figure, in the ledger's two amount roles.
 *
 * `amount-negative` rather than `danger`: a credit on a contact is money the business is
 * holding, not a fault, and the token layer keeps the two roles apart for exactly that
 * reason (`styles/tokens.css`). Colouring an unapplied receipt red-as-in-error is the
 * misreading this screen exists to prevent.
 */
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
  emphasis,
  className,
}: {
  readonly value: string | null;
  readonly emphasis?: boolean;
  readonly className?: string | undefined;
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
 * `YYYY-MM-DD` in the reader's own timezone.
 *
 * Not `toISOString().slice(0, 10)`. A calendar date is not an instant — that is why
 * `scripts/codegen.mjs` maps `DATE` to `string` — and slicing a UTC instant puts a reader
 * west of UTC on tomorrow's date every evening, which on this screen would default a
 * payment into a period that may not be open.
 */
export function todayCalendarDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
