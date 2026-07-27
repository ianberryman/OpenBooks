/**
 * The money arithmetic the report core is made of (OB-041; D-13).
 *
 * ## Why these are `bigint` and not the cents-only strings the trial balance returns
 *
 * `getTrialBalance` returns strings because it *is* a wire response — D-13's rule
 * is about what crosses JSON, and its output crosses JSON unchanged. This core is
 * not a response: its consumers are three report services that will each do
 * arithmetic on what comes back — a P&L totals its sections, a balance sheet
 * derives current-year earnings from revenue and expense (D-20), a general ledger
 * adds movement to opening. Handing them strings would put a parse in front of
 * every one of those sums, and a parse is where a `Number()` gets written. So the
 * amounts stay `bigint` minor units all the way to the projection, and the single
 * conversion to a cents-only string happens there, once, on the way out.
 *
 * Plain `bigint` rather than the branded `Money`, matching the trial balance.
 * `Money`'s constructors bound every value to the signed `BIGINT` range, which is
 * right for an amount a caller supplies and wrong for a total the database
 * computed: MySQL sums `BIGINT` columns into a `DECIMAL` that is wider than either
 * of them, and a large but perfectly legitimate ledger would then produce a report
 * that throws rather than a report that is large.
 */

/** A debit and credit pair, and the difference between them. Minor units. */
export interface BalanceAmounts {
  readonly debits: bigint;
  readonly credits: bigint;
  /** `debits - credits`. Negative means net credit. */
  readonly balance: bigint;
}

/**
 * One account's position over a range, decomposed the way B4 states it: opening
 * plus movement is closing, for every account and every range.
 *
 * The decomposition is not three reports, it is one — and which third of it a
 * caller reads is what makes the three M2 reports different from each other. A
 * P&L reads `movement` (what happened during the period). A balance sheet reads
 * `closing` (where things stand at the end of it). A general ledger prints
 * `opening`, then the entries, then `closing`, and B4 is the assertion that the
 * arithmetic on the page is the arithmetic here.
 *
 * `closing` is stored rather than left to the caller to compute, so that the
 * addition happens in one place — `closingOf` — rather than in each of three
 * reports plus every test.
 */
export interface AccountBalance {
  /** Postings strictly before the range's `from`. All zero when `from` is absent. */
  readonly opening: BalanceAmounts;
  /** Postings inside the range, both bounds inclusive. */
  readonly movement: BalanceAmounts;
  /** `opening + movement`, which is every posting up to and including `to`. */
  readonly closing: BalanceAmounts;
}

export const ZERO_AMOUNTS: BalanceAmounts = { debits: 0n, credits: 0n, balance: 0n };

export const ZERO_ACCOUNT_BALANCE: AccountBalance = {
  opening: ZERO_AMOUNTS,
  movement: ZERO_AMOUNTS,
  closing: ZERO_AMOUNTS,
};

/** The one place `debits - credits` is computed. */
export function amountsOf(debits: bigint, credits: bigint): BalanceAmounts {
  return { debits, credits, balance: debits - credits };
}

export function addAmounts(left: BalanceAmounts, right: BalanceAmounts): BalanceAmounts {
  return amountsOf(left.debits + right.debits, left.credits + right.credits);
}

/**
 * Assembles a decomposition from its two independent halves.
 *
 * Closing is the sum of the two rather than a third aggregate over a third date
 * window, which is what makes B4 true by construction instead of by agreement
 * between two `SUM`s that could drift at a boundary date.
 */
export function balanceOf(opening: BalanceAmounts, movement: BalanceAmounts): AccountBalance {
  return { opening, movement, closing: addAmounts(opening, movement) };
}

/**
 * Adds two decompositions, part by part.
 *
 * This is the operation every property in B6 and B7 is stated in — subtotalling a
 * subtree, summing a report's groups, totalling a P&L section — so it exists once
 * here rather than three times in three report services.
 */
export function addAccountBalance(left: AccountBalance, right: AccountBalance): AccountBalance {
  return {
    opening: addAmounts(left.opening, right.opening),
    movement: addAmounts(left.movement, right.movement),
    closing: addAmounts(left.closing, right.closing),
  };
}

export function sumAccountBalances(balances: Iterable<AccountBalance>): AccountBalance {
  let total = ZERO_ACCOUNT_BALANCE;
  for (const balance of balances) total = addAccountBalance(total, balance);
  return total;
}

/** Whether this account contributed nothing at all to the report's window. */
export function isZeroBalance(balance: AccountBalance): boolean {
  return (
    balance.opening.debits === 0n &&
    balance.opening.credits === 0n &&
    balance.movement.debits === 0n &&
    balance.movement.credits === 0n
  );
}
