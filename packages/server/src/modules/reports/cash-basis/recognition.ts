import type { BalanceAmounts } from '../amounts';
import { amountsOf } from '../amounts';

/**
 * The cash-basis recognition core (OB-154; D-87) — the pure, exact-arithmetic heart
 * of the transform, isolated from all I/O so it is the unit the property and mutation
 * suites stand over (K7). Given the raw materials the repository gathers and a report
 * window, it produces, per account, the debit/credit a **cash-basis** P&L recognises
 * in the opening window (before `from`) and the movement window (`from`…`to`). The
 * service wraps those two `BalanceAmounts` with `balanceOf` into the exact same
 * `AccountBalance` the accrual core emits, so every projection above it is unchanged.
 *
 * ## The two recognition paths (this file's whole content)
 *
 * **Documents (path A).** An accrual invoice/bill recognises its P&L when *cash*
 * settles it, at the settling payment's date, **proportionally** — a half-paid
 * invoice recognises half its revenue (K2). Its journal's P&L legs (revenue/expense)
 * are scaled by the fraction of the document's gross that each cash settlement paid.
 * Credit-note settlements are not here — they move no cash, so the repository never
 * hands them over (their allocation has no `payment_id`).
 *
 * **Direct cash journals (path B).** A journal that touches cash directly and carries
 * a P&L leg — a cash sale, a cash expense — recognises that leg at its own date; the
 * cash already moved. (A payment's own journal has no P&L leg, so it is not here.)
 *
 * A pure-accrual journal — no cash, no settling payment — recognises nothing on cash
 * basis and never reaches this function.
 *
 * ## Why the rounding is cumulative, and why that is the load-bearing line
 *
 * Recognising `leg × paid / gross` per settlement with independent `floor`s loses a
 * cent whenever the division does not divide, and a fully-paid invoice would then
 * recognise `gross − ε` of its revenue forever. So recognition is **cumulative**:
 * each settlement books `floor(leg × paidThrough / gross) − floor(leg × paidBefore /
 * gross)`. The flooring error never accumulates — at full payment `paidThrough ==
 * gross` and the running total is exactly `leg`. This is the one identity the
 * mutation suite exists to protect: **the sum of what every settlement recognises
 * equals the whole leg, once the document is fully paid.** Settlements are processed
 * in date order for the same reason opening/movement is one pair of windows in the
 * accrual core — the boundary between "already recognised" and "recognised now" is a
 * single running number, not two independent sums that can disagree at a date.
 */

/** A P&L leg of a document's journal, carrying the sides it was posted on. */
export interface DocumentLeg {
  readonly accountId: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

/** One cash settlement of a document — a payment allocation (`payment_id` set). */
export interface CashSettlement {
  /** The allocation's `allocated_on` — the date cash is recognised against. */
  readonly date: string;
  /** `amount_minor` applied by this allocation. */
  readonly amount: bigint;
}

/** An accrual document (invoice/bill) as cash-basis recognition sees it. */
export interface RecognizableDocument {
  /** The control-line amount, `Σ(line + tax)` — the denominator of the fraction. */
  readonly gross: bigint;
  /** The document journal's P&L legs (revenue/expense accounts). */
  readonly legs: readonly DocumentLeg[];
  /** Its cash settlements. Recognised in date order; sorted here defensively. */
  readonly settlements: readonly CashSettlement[];
}

/** A P&L leg of a direct cash-touching journal, recognised at its own date. */
export interface DirectCashLeg {
  readonly accountId: string;
  /** The journal's `entry_date`. */
  readonly date: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface CashBasisInputs {
  readonly documents: readonly RecognizableDocument[];
  readonly directCashLegs: readonly DirectCashLeg[];
}

export interface RecognitionWindow {
  /** Inclusive lower bound. `null` means the ledger's beginning, so no opening. */
  readonly from: string | null;
  /** Inclusive upper bound. `null` means every settlement to date. */
  readonly to: string | null;
}

/** One account's cash-basis position, the two halves the accrual core also produces. */
export interface RecognizedBalance {
  readonly opening: BalanceAmounts;
  readonly movement: BalanceAmounts;
}

interface Sums {
  openingDebits: bigint;
  openingCredits: bigint;
  movementDebits: bigint;
  movementCredits: bigint;
}

type Placement = 'opening' | 'movement' | 'future';

export function recognizeCashBasis(
  inputs: CashBasisInputs,
  window: RecognitionWindow,
): ReadonlyMap<string, RecognizedBalance> {
  const sums = new Map<string, Sums>();

  const placementOf = (date: string): Placement => {
    // A settlement after the report's upper bound has not happened as of `to`, so it
    // is recognised in neither window and does not advance `paidThrough` — the report
    // is a statement about cash received through `to`.
    if (window.to !== null && date > window.to) return 'future';
    // Strictly before `from` is opening; `from`…`to` (or unbounded below) is movement.
    if (window.from !== null && date < window.from) return 'opening';
    return 'movement';
  };

  const book = (
    accountId: string,
    placement: 'opening' | 'movement',
    debit: bigint,
    credit: bigint,
  ): void => {
    if (debit === 0n && credit === 0n) return;
    const current = sums.get(accountId) ?? {
      openingDebits: 0n,
      openingCredits: 0n,
      movementDebits: 0n,
      movementCredits: 0n,
    };
    if (placement === 'opening') {
      current.openingDebits += debit;
      current.openingCredits += credit;
    } else {
      current.movementDebits += debit;
      current.movementCredits += credit;
    }
    sums.set(accountId, current);
  };

  for (const doc of inputs.documents) {
    // A zero-or-negative gross has no fraction to take, and dividing by it is the one
    // way this arithmetic could throw. Such a document (a fully-discounted invoice, a
    // malformed one) recognises nothing rather than crashing the report.
    if (doc.gross <= 0n) continue;

    // Date order, so cumulative recognition sees settlements as they happened. A copy,
    // because the input is readonly and callers should not observe a reordering.
    const settlements = [...doc.settlements].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );

    // `paidThrough` is the cumulative amount settled after each step; each leg books
    // `floor(leg × paidThrough / gross) − floor(leg × paidBefore / gross)`, so the
    // flooring error never accumulates and full payment recognises the whole leg —
    // the invariant in the header. No per-leg running total is needed: `paidBefore`
    // and `paidThrough` already carry the cumulative position.
    let paidThrough = 0n;

    for (const settlement of settlements) {
      const placement = placementOf(settlement.date);
      if (placement === 'future') continue;

      const paidBefore = paidThrough;
      paidThrough += settlement.amount;

      for (const leg of doc.legs) {
        const debitDelta =
          (leg.debit * paidThrough) / doc.gross - (leg.debit * paidBefore) / doc.gross;
        const creditDelta =
          (leg.credit * paidThrough) / doc.gross - (leg.credit * paidBefore) / doc.gross;
        book(leg.accountId, placement, debitDelta, creditDelta);
      }
    }
  }

  for (const leg of inputs.directCashLegs) {
    const placement = placementOf(leg.date);
    if (placement === 'future') continue;
    book(leg.accountId, placement, leg.debit, leg.credit);
  }

  const result = new Map<string, RecognizedBalance>();
  for (const [accountId, sum] of sums) {
    result.set(accountId, {
      opening: amountsOf(sum.openingDebits, sum.openingCredits),
      movement: amountsOf(sum.movementDebits, sum.movementCredits),
    });
  }
  return result;
}
