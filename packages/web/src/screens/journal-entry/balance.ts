/**
 * Debits, credits, and the difference between them — in `bigint` minor units.
 *
 * ## Why `bigint` and not `number`
 *
 * ROADMAP D-13 carries money on the wire as a cents-only string precisely because
 * integers are exact in a double only up to 2^53, and above that ceiling a parser
 * rounds silently. A balancing indicator built on `Number(amount)` inherits that
 * ceiling at the one place a user looks to decide whether an entry is right, and
 * inherits it *invisibly*: both sides round the same way, so the difference still
 * reads zero and the entry looks balanced. `9007199254740993` and
 * `9007199254740992` are the same double and are one cent apart here.
 *
 * There is no division anywhere in this module either. `cents / 100` yields
 * `1234.5599999999999`; display goes through `formatMinorUnits`, which is string
 * manipulation (`src/money/format.ts`).
 *
 * ## What this module does not decide
 *
 * Whether the entry may be posted. A journal needs at least two lines, must balance
 * exactly, and no line may be one-sided — and the kernel decides all three together,
 * answering as a single `validation_failed` naming `lines`
 * (`packages/server/src/modules/ledger/posting.service.ts`). Restating any part of
 * that here would be a second copy of the rules, drifting, in the layer that cannot
 * enforce them. This reports state; the server rules.
 */

export type Side = 'debit' | 'credit';

export interface SidedAmount {
  readonly side: Side | null;
  /** Minor units as they travel on the wire (D-13) — `"150000"` is 1500.00. `null` is empty. */
  readonly amount: string | null;
}

export interface BalanceTotals {
  readonly debits: bigint;
  readonly credits: bigint;
  /** `debits - credits`. Zero is the only value the ledger accepts. */
  readonly difference: bigint;
  /**
   * Whether anything has been entered at all. A difference of zero over nothing is not
   * balance, and an editor that congratulated an empty form on balancing would be
   * telling the user the opposite of what the server is about to say.
   */
  readonly entered: boolean;
}

/**
 * The pattern `formatMinorUnits` validates against, and the same one `fromMinorString`
 * enforces server-side: a canonical base-10 integer.
 *
 * Every amount reaching this module is canonical by construction — it came either from
 * `MoneyInput`, which emits `tryToMinorUnits` output or `null`, or from the API, which
 * renders every amount through `toMinorString`. The guard is here so that a value from
 * neither source is worth zero in a total rather than a `SyntaxError` thrown out of
 * `BigInt` during a render, which would take the whole editor down over one bad field.
 */
const MINOR_UNITS_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

function toMinorUnits(amount: string | null): bigint {
  if (amount === null || !MINOR_UNITS_PATTERN.test(amount)) return 0n;
  return BigInt(amount);
}

export function totalsOf(lines: readonly SidedAmount[]): BalanceTotals {
  let debits = 0n;
  let credits = 0n;

  for (const line of lines) {
    // A line with no side has no amount either — the draft schema reads such a line
    // back with neither, and an amount typed into a field whose side was then cleared
    // is not on the ledger's books in any direction.
    if (line.side === null) continue;

    const amount = toMinorUnits(line.amount);
    if (line.side === 'debit') debits += amount;
    else credits += amount;
  }

  return {
    debits,
    credits,
    difference: debits - credits,
    entered: debits !== 0n || credits !== 0n,
  };
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * A `bigint` of minor units as the cents-only string the display path takes.
 *
 * `String(bigint)` is exact and canonical for every value — including `-0n`, which does
 * not exist, so the `"-0"` case `formatMinorUnits` handles cannot arise from here.
 */
export function toWireAmount(value: bigint): string {
  return String(value);
}
