import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ParsedStatementRow } from '../../../src/modules/banking/parser';
import {
  computeFingerprint,
  fingerprintRows,
} from '../../../src/modules/banking/statements/fingerprint';

/**
 * The dedupe identity, as a set of properties (OB-078; D-42, E1).
 *
 * These are pure — no database — because that is the point of keeping the identity
 * function separate: E1 is a property over inputs, and it is checkable here against
 * every ordering fast-check can invent rather than against the handful an example
 * suite would list. The database half (persist, re-import, overlap) is in
 * `import.service.test.ts`.
 */

/** A small alphabet on every field, so fingerprints collide often and dedupe is exercised. */
const rowArb: fc.Arbitrary<ParsedStatementRow> = fc.record({
  postedDate: fc.constantFrom('2026-01-01', '2026-01-02', '2026-02-01'),
  valueDate: fc.constantFrom('2026-01-01', '2026-01-03', null),
  amount: fc.bigInt({ min: -500n, max: 500n }),
  description: fc.constantFrom('COFFEE', 'TESCO', 'RENT'),
  counterparty: fc.constantFrom('Acme', 'Beta', null),
  bankReference: fc.constantFrom('FIT1', 'FIT2', null),
});

/** A stored line's full identity, as a comparable string (amount is a bigint). */
function key(entry: {
  fingerprint: string;
  occurrenceIndex: number;
  row: ParsedStatementRow;
}): string {
  const r = entry.row;
  return [
    entry.fingerprint,
    entry.occurrenceIndex,
    r.postedDate,
    r.valueDate,
    r.amount.toString(),
    r.description,
    r.counterparty,
    r.bankReference,
  ].join('|');
}

describe('computeFingerprint', () => {
  it('is deterministic', () => {
    fc.assert(
      fc.property(rowArb, (row) => {
        expect(computeFingerprint(row)).toBe(computeFingerprint(row));
      }),
    );
  });

  it('depends only on the four bank-supplied fields, not on valueDate or counterparty', () => {
    fc.assert(
      fc.property(rowArb, rowArb, (a, b) => {
        const sameSuppliedFields =
          a.postedDate === b.postedDate &&
          a.amount === b.amount &&
          a.description === b.description &&
          a.bankReference === b.bankReference;
        if (sameSuppliedFields) {
          expect(computeFingerprint(a)).toBe(computeFingerprint(b));
        }
      }),
    );
  });

  it('is injective over the supplied fields: different tuples never share a fingerprint', () => {
    fc.assert(
      fc.property(rowArb, rowArb, (a, b) => {
        const differ =
          a.postedDate !== b.postedDate ||
          a.amount !== b.amount ||
          a.description !== b.description ||
          a.bankReference !== b.bankReference;
        if (differ) {
          expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
        }
      }),
    );
  });

  it('does not let a description impersonate the next field (delimiter safety)', () => {
    // The failure a naive delimiter-join would have: ('a|b', null) and ('a', 'b')
    // collapsing to the same pre-image. The amount and reference make these two
    // distinct tuples, and their fingerprints must differ.
    const one = computeFingerprint({
      postedDate: '2026-01-01',
      amount: 100n,
      description: 'a"|"b',
      bankReference: null,
    });
    const two = computeFingerprint({
      postedDate: '2026-01-01',
      amount: 100n,
      description: 'a',
      bankReference: 'b',
    });
    expect(one).not.toBe(two);
  });
});

describe('fingerprintRows', () => {
  it('numbers each fingerprint group 0 … k-1, exactly once each', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), (rows) => {
        const byFingerprint = new Map<string, number[]>();
        for (const entry of fingerprintRows(rows)) {
          const list = byFingerprint.get(entry.fingerprint) ?? [];
          list.push(entry.occurrenceIndex);
          byFingerprint.set(entry.fingerprint, list);
        }
        for (const indexes of byFingerprint.values()) {
          const sorted = [...indexes].sort((a, b) => a - b);
          expect(sorted).toEqual(indexes.map((_, i) => i));
        }
      }),
    );
  });

  it('produces the identical stored set whatever the file’s ordering (E1)', () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 40 }).chain((rows) =>
          fc.tuple(
            fc.constant(rows),
            fc.array(fc.double({ noNaN: true }), {
              minLength: rows.length,
              maxLength: rows.length,
            }),
          ),
        ),
        ([rows, weights]) => {
          const shuffled = rows
            .map((row, i) => ({ row, weight: weights[i]! }))
            .sort((a, b) => a.weight - b.weight)
            .map((entry) => entry.row);

          const original = fingerprintRows(rows).map(key).sort();
          const permuted = fingerprintRows(shuffled).map(key).sort();
          expect(permuted).toEqual(original);
        },
      ),
    );
  });
});
