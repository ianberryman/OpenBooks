import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  CashSettlement,
  DocumentLeg,
  RecognizableDocument,
} from '../../src/modules/reports/cash-basis/recognition';
import { recognizeCashBasis } from '../../src/modules/reports/cash-basis/recognition';

/**
 * The cash-basis recognition core (OB-154, K7). A pure function, so these are pure
 * tests — no database. The examples pin the behaviour D-87 names; the properties are
 * the mutation-suite standard the transform is held to, because the arithmetic here
 * is the "gets them in trouble" part: a cent lost per partial payment is a P&L that
 * never closes.
 */

const UNBOUNDED = { from: null, to: null } as const;

function doc(
  gross: bigint,
  legs: readonly DocumentLeg[],
  settlements: readonly CashSettlement[],
): RecognizableDocument {
  return { gross, legs, settlements };
}

describe('cash-basis recognition — examples (D-87)', () => {
  it('re-recognises a document proportionally, at each settling payment date (K2)', () => {
    // A 1,000 invoice, all revenue, paid 400 in January and 600 in February.
    const invoice = doc(
      1000n,
      [{ accountId: 'revenue', debit: 0n, credit: 1000n }],
      [
        { date: '2026-01-10', amount: 400n },
        { date: '2026-02-20', amount: 600n },
      ],
    );

    const february = recognizeCashBasis(
      { documents: [invoice], directCashLegs: [] },
      { from: '2026-02-01', to: '2026-02-28' },
    );

    const revenue = february.get('revenue');
    // The January payment is opening (before the window); February's is the movement.
    expect(revenue?.opening).toEqual({ debits: 0n, credits: 400n, balance: -400n });
    expect(revenue?.movement).toEqual({ debits: 0n, credits: 600n, balance: -600n });
  });

  it('recognises nothing for an unpaid document (K2 — excludes the unpaid)', () => {
    const invoice = doc(1000n, [{ accountId: 'revenue', debit: 0n, credit: 1000n }], []);
    const result = recognizeCashBasis({ documents: [invoice], directCashLegs: [] }, UNBOUNDED);
    expect(result.size).toBe(0);
  });

  it('recognises a direct cash journal at its own date (path B)', () => {
    const result = recognizeCashBasis(
      {
        documents: [],
        directCashLegs: [{ accountId: 'expense', date: '2026-03-15', debit: 500n, credit: 0n }],
      },
      { from: '2026-03-01', to: '2026-03-31' },
    );
    expect(result.get('expense')?.movement).toEqual({ debits: 500n, credits: 0n, balance: 500n });
  });

  it('does not recognise a settlement after the report’s upper bound', () => {
    const invoice = doc(
      1000n,
      [{ accountId: 'revenue', debit: 0n, credit: 1000n }],
      [{ date: '2026-05-10', amount: 1000n }],
    );
    const result = recognizeCashBasis(
      { documents: [invoice], directCashLegs: [] },
      { from: null, to: '2026-04-30' },
    );
    expect(result.size).toBe(0);
  });

  it('splits an odd amount across partials without losing a cent, once fully paid', () => {
    // 1,000 revenue over three thirds — 333 + 333 + 334 = 1000 gross — must recognise
    // exactly 1000, not 999, when the whole invoice is paid.
    const invoice = doc(
      1000n,
      [{ accountId: 'revenue', debit: 0n, credit: 1000n }],
      [
        { date: '2026-01-05', amount: 333n },
        { date: '2026-01-15', amount: 333n },
        { date: '2026-01-25', amount: 334n },
      ],
    );
    const result = recognizeCashBasis({ documents: [invoice], directCashLegs: [] }, UNBOUNDED);
    expect(result.get('revenue')?.movement.credits).toBe(1000n);
  });
});

// ---------------------------------------------------------------------------
// Properties — the mutation-suite standard (K7).
// ---------------------------------------------------------------------------

const accountIdArb = fc.constantFrom('a', 'b', 'c');
const legArb = fc.record({
  accountId: accountIdArb,
  debit: fc.bigInt({ min: 0n, max: 10_000_000n }),
  credit: fc.bigInt({ min: 0n, max: 10_000_000n }),
});
const legsArb = fc.array(legArb, { minLength: 1, maxLength: 5 });
const positiveAmountsArb = fc.array(fc.bigInt({ min: 1n, max: 5_000_000n }), {
  minLength: 1,
  maxLength: 6,
});

/** Settlement amounts laid on distinct ascending dates in January 2026. */
function settlementsOf(amounts: readonly bigint[]): CashSettlement[] {
  return amounts.map((amount, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    amount,
  }));
}

function totalRecognised(
  map: ReadonlyMap<
    string,
    { opening: { debits: bigint; credits: bigint }; movement: { debits: bigint; credits: bigint } }
  >,
  accountId: string,
): { debits: bigint; credits: bigint } {
  const entry = map.get(accountId);
  if (entry === undefined) return { debits: 0n, credits: 0n };
  return {
    debits: entry.opening.debits + entry.movement.debits,
    credits: entry.opening.credits + entry.movement.credits,
  };
}

function legTotals(legs: readonly DocumentLeg[]): Map<string, { debits: bigint; credits: bigint }> {
  const totals = new Map<string, { debits: bigint; credits: bigint }>();
  for (const leg of legs) {
    const current = totals.get(leg.accountId) ?? { debits: 0n, credits: 0n };
    totals.set(leg.accountId, {
      debits: current.debits + leg.debit,
      credits: current.credits + leg.credit,
    });
  }
  return totals;
}

describe('cash-basis recognition — properties (K7)', () => {
  it('a fully-paid document recognises exactly the whole of every leg (no cent lost)', () => {
    fc.assert(
      fc.property(positiveAmountsArb, legsArb, (amounts, legs) => {
        const gross = amounts.reduce((sum, amount) => sum + amount, 0n);
        const result = recognizeCashBasis(
          { documents: [doc(gross, legs, settlementsOf(amounts))], directCashLegs: [] },
          UNBOUNDED,
        );
        for (const [accountId, expected] of legTotals(legs)) {
          expect(totalRecognised(result, accountId)).toEqual(expected);
        }
      }),
    );
  });

  it('never recognises more than a leg, however the partials fall (no over-recognition)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 20_000_000n }),
        positiveAmountsArb,
        legsArb,
        (gross, amounts, legs) => {
          // Cap paid at gross — the subledger forbids over-allocation (C3).
          const capped: bigint[] = [];
          let remaining = gross;
          for (const amount of amounts) {
            const take = amount < remaining ? amount : remaining;
            if (take > 0n) capped.push(take);
            remaining -= take;
          }
          const result = recognizeCashBasis(
            { documents: [doc(gross, legs, settlementsOf(capped))], directCashLegs: [] },
            UNBOUNDED,
          );
          for (const [accountId, expected] of legTotals(legs)) {
            const got = totalRecognised(result, accountId);
            expect(got.debits <= expected.debits).toBe(true);
            expect(got.credits <= expected.credits).toBe(true);
          }
        },
      ),
    );
  });

  it('splitting the window at any date leaves the total recognised unchanged (B4-style)', () => {
    fc.assert(
      fc.property(
        positiveAmountsArb,
        legsArb,
        fc.integer({ min: 1, max: 7 }),
        (amounts, legs, splitDay) => {
          const gross = amounts.reduce((sum, amount) => sum + amount, 0n);
          const document = doc(gross, legs, settlementsOf(amounts));
          const split = `2026-01-${String(splitDay).padStart(2, '0')}`;

          const whole = recognizeCashBasis(
            { documents: [document], directCashLegs: [] },
            UNBOUNDED,
          );
          const windowed = recognizeCashBasis(
            { documents: [document], directCashLegs: [] },
            { from: split, to: null },
          );

          for (const accountId of legTotals(legs).keys()) {
            // opening + movement of the windowed run equals the whole (unbounded) run.
            expect(totalRecognised(windowed, accountId)).toEqual(totalRecognised(whole, accountId));
          }
        },
      ),
    );
  });
});
