/**
 * Minor-units `bigint` arithmetic, scoped to what OB-116 needs (ROADMAP D-13).
 *
 * `money-in/amounts.tsx` gives the fuller reason this is `bigint` and not `number`: a cent
 * count above 2^53 rounds silently, and `cents / 100` in floating point is inexact. This
 * screen never asks the server what a vendor group totals to while the user is still
 * choosing which bills to pay — `PayableBill`'s four money fields are computed on read
 * (D-34, D-68), but a client-side "so far" total while building the batch exists nowhere on
 * the wire until the batch is sent — so the sum happens here, once, in `bigint`.
 */

export function sumMinorUnits(amounts: Iterable<string>): string {
  let total = 0n;
  for (const amount of amounts) total += BigInt(amount);
  return total.toString();
}

export function subtractMinorUnits(left: string, right: string): string {
  return (BigInt(left) - BigInt(right)).toString();
}

/** `'0'` and `'-0'` are both canonical on the wire (`src/money/format.ts`). */
export function isZeroAmount(wireAmount: string): boolean {
  return wireAmount === '0' || wireAmount === '-0';
}

/**
 * `YYYY-MM-DD` in the reader's own timezone. Duplicated from `money-in/amounts.tsx` and
 * `dunning/queries.ts` rather than imported — each screen folder is self-contained, the
 * reason `sales/queries.ts` gives for the same three lines appearing a third time.
 */
export function todayCalendarDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
