import { MAX_MONEY_MINOR_UNITS } from '@openbooks/shared-types/money';
import fc from 'fast-check';

import type { AccountSpec, JournalPlan, LedgerPlan, LinePlan } from './support';
import { OPEN_PERIOD } from './support';

/**
 * Generators for the §11 invariant properties.
 *
 * Two design constraints shape everything here, and both come from the ticket's
 * observation that a generator emitting only two-line journals of equal amounts
 * tests almost nothing.
 *
 * **A generated journal must never be rejected.** A property that fails because the
 * arbitrary produced an amount the ledger legitimately refuses proves nothing about
 * the invariant, and worse, hides real failures behind noise. So every bound below is
 * derived from a rule the posting service actually enforces rather than picked to look
 * safe: amounts are strictly positive, a journal's *total* stays inside the storable
 * range, and dates land inside the open period.
 *
 * **Counterexamples must be readable.** Shrinking is what makes a property test
 * useful when it fails, so amounts are biased small and the large bands are wired
 * with `withCrossShrink` so an eighteen-digit counterexample can collapse into a
 * two-digit one. Line counts, account counts, and journal counts all shrink toward
 * their minimums, which means a failure reports the smallest ledger that still breaks.
 */

/**
 * The most lines a generated journal puts on one side.
 *
 * Four rather than two because asymmetric journals are the interesting shape — one
 * debit against three credits is an ordinary split payment, and a generator that only
 * ever produced matched pairs would never exercise the aggregation across differing
 * line counts.
 */
const MAX_LINES_PER_SIDE = 4;

/**
 * The ceiling on a single line.
 *
 * `fromMinorUnits` bounds every amount to the signed `BIGINT` range, and
 * `validateLines` totals the sides with `sum`, which routes each intermediate through
 * that same bound. So the binding constraint is on the *total*, not the line: with at
 * most `MAX_LINES_PER_SIDE` debit lines, capping each line at `MAX / 4` makes the
 * worst-case total exactly `MAX` and therefore storable. The credit side splits that
 * same total, so no credit line can exceed it either.
 *
 * This is why the cap is computed rather than written as a literal — a later change to
 * `MAX_LINES_PER_SIDE` must move it, and a stale literal would surface as a
 * `MoneyParseError` in an unrelated property.
 */
export const MAX_LINE_AMOUNT = MAX_MONEY_MINOR_UNITS / BigInt(MAX_LINES_PER_SIDE);

/** 2^53: the point above which a JSON number stops being exact (D-13). */
const UNSAFE_INTEGER_THRESHOLD = 2n ** 53n;

/**
 * Line amounts, spanning the three ranges that behave differently.
 *
 * The band above 2^53 is the reason money is `bigint` end to end and a string on the
 * wire, so it has to be generated rather than hoped for: an implementation that lost
 * precision would look correct for every amount a `double` can hold. It is weighted
 * down rather than out because the small band is where a readable counterexample
 * lives, and `withCrossShrink` lets a value from either large band shrink into it.
 */
const amountArb = fc.oneof(
  { withCrossShrink: true },
  { arbitrary: fc.bigInt({ min: 1n, max: 1_000_000n }), weight: 6 },
  { arbitrary: fc.bigInt({ min: 1_000_001n, max: UNSAFE_INTEGER_THRESHOLD }), weight: 2 },
  { arbitrary: fc.bigInt({ min: UNSAFE_INTEGER_THRESHOLD + 1n, max: MAX_LINE_AMOUNT }), weight: 2 },
);

/** 2026 is not a leap year, so this table is complete for the generated period. */
const DAYS_IN_MONTH_2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * A date inside the open period.
 *
 * Clamped to the month's real length rather than capped at 28, so month-end dates —
 * where real journals cluster, and where an off-by-one in period resolution would
 * show — are generated. Clamping happens in a `map` rather than a `chain` because a
 * chained day range re-generates on every shrink step and shrinks far worse.
 */
const dateArb = fc
  .record({ month: fc.integer({ min: 1, max: 12 }), day: fc.integer({ min: 1, max: 31 }) })
  .map(({ month, day }) => {
    const lastDay = DAYS_IN_MONTH_2026[month - 1] ?? 28;
    return `${String(OPEN_PERIOD.year)}-${pad(month)}-${pad(Math.min(day, lastDay))}`;
  });

/**
 * An account's type and normal balance, generated **independently**.
 *
 * That combination produces contra accounts — a credit-normal asset is accumulated
 * depreciation, a debit-normal revenue is a sales discount — and generating them is
 * the point. The accounting equation classifies by `accounts.type`; a contra account
 * belongs to its type's side of the equation and merely contributes negatively to it.
 * An implementation (or a test) that keyed the equation's sign off `normal_balance`
 * instead would be correct for every ordinary account and wrong for every contra one,
 * so without these the accounting-equation property would have no teeth on the one
 * question that is genuinely easy to get wrong.
 */
const accountSpecArb: fc.Arbitrary<AccountSpec> = fc.record({
  type: fc.constantFrom('asset', 'liability', 'equity', 'revenue', 'expense'),
  normalBalance: fc.constantFrom('debit', 'credit'),
});

interface DebitSlot {
  readonly accountIndex: number;
  readonly amount: bigint;
}

interface CreditSlot {
  readonly accountIndex: number;
  /** A proportion, not money: it decides how the debit total is split. */
  readonly weight: number;
}

/**
 * A balanced journal, built by generating one side freely and splitting its total
 * across the other.
 *
 * Balance is a property of the *construction* here, not something the generator
 * filters for. Generating both sides and discarding the unbalanced ones would reject
 * effectively every candidate, and generating equal-and-opposite pairs would make
 * every journal symmetric — the shape that tests least. Splitting a freely generated
 * debit total across an independently generated number of credit slots gives varied
 * line counts on both sides and amounts that are unrelated across the two sides,
 * while still balancing exactly.
 */
function journalPlanArb(accountCount: number): fc.Arbitrary<JournalPlan> {
  const accountIndexArb = fc.nat({ max: accountCount - 1 });

  return fc
    .record({
      date: dateArb,
      debits: fc.array<DebitSlot>(fc.record({ accountIndex: accountIndexArb, amount: amountArb }), {
        minLength: 1,
        maxLength: MAX_LINES_PER_SIDE,
      }),
      credits: fc.array<CreditSlot>(
        fc.record({ accountIndex: accountIndexArb, weight: fc.integer({ min: 1, max: 64 }) }),
        { minLength: 1, maxLength: MAX_LINES_PER_SIDE },
      ),
    })
    .map(buildJournalPlan);
}

function buildJournalPlan(input: {
  readonly date: string;
  readonly debits: readonly DebitSlot[];
  readonly credits: readonly CreditSlot[];
}): JournalPlan {
  const total = input.debits.reduce((running, slot) => running + slot.amount, 0n);

  // `chk_journal_lines_one_sided` requires every line to carry at least one minor
  // unit, so a total smaller than the number of credit slots gets fewer slots rather
  // than a zero-value line. Reachable: the smallest total a journal can have is 1.
  const slotCount = total < BigInt(input.credits.length) ? Number(total) : input.credits.length;
  const slots = input.credits.slice(0, slotCount);

  const debitLines: LinePlan[] = input.debits.map((slot) => ({
    accountIndex: slot.accountIndex,
    side: 'debit',
    amount: slot.amount,
  }));
  const creditLines: LinePlan[] = shareOut(total, slots, (slot) => slot.weight).map(
    ({ slot, amount }) => ({ accountIndex: slot.accountIndex, side: 'credit', amount }),
  );

  return { date: input.date, lines: [...debitLines, ...creditLines] };
}

/**
 * Splits `total` across `slots` in proportion to their weights, giving each slot at
 * least one minor unit and losing nothing.
 *
 * Every slot is floored at 1 and the *surplus* above those floors is what gets shared
 * proportionally, which is what keeps each part strictly positive. The last slot takes
 * the remainder rather than its computed share, so the integer division's dropped
 * fractions land somewhere instead of vanishing — the same reason
 * `shared-types/money/allocate` exists. Requires `total >= slots.length`, which
 * `buildJournalPlan` guarantees by trimming the slot list.
 */
function shareOut<T>(
  total: bigint,
  slots: readonly T[],
  weightOf: (slot: T) => number,
): readonly { readonly slot: T; readonly amount: bigint }[] {
  const surplus = total - BigInt(slots.length);
  const totalWeight = slots.reduce((running, slot) => running + BigInt(weightOf(slot)), 0n);

  let assigned = 0n;
  return slots.map((slot, index) => {
    const share =
      index === slots.length - 1
        ? surplus - assigned
        : (surplus * BigInt(weightOf(slot))) / totalWeight;
    assigned += share;
    return { slot, amount: share + 1n };
  });
}

/**
 * A chart of accounts and the journals posted against it.
 *
 * `chain` rather than two independent arrays because line references are indices into
 * the account list, and an index generated against a different length would be a
 * broken plan rather than an interesting one. Both lengths shrink toward their
 * minimums, so the smallest reported counterexample is two accounts and one journal.
 */
export const ledgerPlanArb: fc.Arbitrary<LedgerPlan> = fc
  .array(accountSpecArb, { minLength: 2, maxLength: 5 })
  .chain((accounts) =>
    fc
      .array(journalPlanArb(accounts.length), { minLength: 1, maxLength: 4 })
      .map((journals) => ({ accounts, journals })),
  );

/**
 * A plan plus a permutation of its journals, for the posting-order property.
 *
 * `shuffledSubarray` over the full index range is a permutation, and it shrinks toward
 * the original order — so a failure reports the smallest reordering that breaks
 * agreement rather than an arbitrary scramble.
 */
export const orderedLedgerPlanArb: fc.Arbitrary<{
  readonly plan: LedgerPlan;
  readonly order: readonly number[];
}> = ledgerPlanArb.chain((plan) =>
  fc
    .shuffledSubarray(
      plan.journals.map((_, index) => index),
      { minLength: plan.journals.length, maxLength: plan.journals.length },
    )
    .map((order) => ({ plan, order })),
);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
