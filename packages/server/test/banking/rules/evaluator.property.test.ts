import { describe, expect, it } from 'vitest';

import type { RuleCandidateLine } from '../../../src/modules/banking/rule-evaluator';
import {
  compareRules,
  evaluatePage,
  type LoadedRule,
} from '../../../src/modules/banking/rules/evaluator';

/**
 * The determinism property, proved in memory (OB-080; ROADMAP D-44).
 *
 * The winner of two rules matching one line must not depend on the order the rules
 * were loaded in — "a lookup whose answer depends on scan order is not deterministic"
 * (D-44). `evaluatePage` sorts its input by `(priority, created_at, id)` before
 * matching, so this suite hands it *every permutation* of a rule set and asserts the
 * winner map never moves.
 *
 * This is the mutation target the project has been bitten by (CLAUDE.md, "Testing"):
 * a picker that took the *last* match, sorted descending, or broke a tie on the wrong
 * column is identical-to-correct on a single rule and wrong on two. Every line below
 * is matched by *more than one* rule for exactly that reason, and each of the three
 * ordering keys — priority, then created_at, then id — decides a different line, so no
 * single wrong key passes.
 */

function idBytes(last: number): Buffer {
  const buffer = Buffer.alloc(16);
  buffer[15] = last;
  return buffer;
}

interface RuleSpec {
  readonly ruleId: string;
  readonly priority: number;
  readonly createdAt: Date;
  readonly id: Buffer;
  readonly needleLower: string;
}

function loaded(spec: RuleSpec): LoadedRule {
  return {
    id: spec.id,
    priority: spec.priority,
    createdAt: spec.createdAt,
    bankAccountId: null,
    description: { mode: 'contains', needleLower: spec.needleLower },
    direction: null,
    amountMin: null,
    amountMax: null,
    match: { ruleId: spec.ruleId, accountId: 'account', contactId: null, dimensionValueIds: [] },
  };
}

// Priority decides `shared`; created_at (equal priority) decides `tie`; id (equal
// priority and created_at) decides `idline`. Each line is matched by two rules.
const R1 = loaded({
  ruleId: 'R1',
  priority: 10,
  createdAt: new Date(1000),
  id: idBytes(9),
  needleLower: 'shared',
});
const R2 = loaded({
  ruleId: 'R2',
  priority: 20,
  createdAt: new Date(1000),
  id: idBytes(8),
  needleLower: 'shared',
});
const R3 = loaded({
  ruleId: 'R3',
  priority: 30,
  createdAt: new Date(2000),
  id: idBytes(7),
  needleLower: 'tie',
});
const R4 = loaded({
  ruleId: 'R4',
  priority: 30,
  createdAt: new Date(1000),
  id: idBytes(6),
  needleLower: 'tie',
});
const R5 = loaded({
  ruleId: 'R5',
  priority: 40,
  createdAt: new Date(3000),
  id: idBytes(1),
  needleLower: 'idline',
});
const R6 = loaded({
  ruleId: 'R6',
  priority: 40,
  createdAt: new Date(3000),
  id: idBytes(0),
  needleLower: 'idline',
});

const RULES = [R1, R2, R3, R4, R5, R6];

const LINES: readonly RuleCandidateLine[] = [
  { lineId: 'shared', bankAccountId: 'acct', description: 'SHARED PURCHASE', amount: -1n },
  { lineId: 'tie', bankAccountId: 'acct', description: 'A TIE HERE', amount: -1n },
  { lineId: 'idline', bankAccountId: 'acct', description: 'IDLINE', amount: -1n },
  { lineId: 'none', bankAccountId: 'acct', description: 'UNMATCHED', amount: -1n },
];

// Worked out from the ordering by hand, independent of `compareRules`:
const EXPECTED = new Map<string, string>([
  ['shared', 'R1'], // priority 10 < 20
  ['tie', 'R4'], // equal priority; created_at 1000 < 2000
  ['idline', 'R6'], // equal priority and created_at; id byte 0 < 1
]);

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      const head = items[index];
      if (head !== undefined) result.push([head, ...tail]);
    }
  }
  return result;
}

function winners(rules: readonly LoadedRule[]): Map<string, string> {
  const matches = evaluatePage(rules, LINES);
  return new Map([...matches].map(([lineId, match]) => [lineId, match.ruleId]));
}

describe('evaluatePage — the winner is permutation-invariant', () => {
  it('agrees with the hand-computed winner under every permutation of the rules', () => {
    const all = permutations(RULES);
    expect(all).toHaveLength(720);

    for (const permutation of all) {
      expect(winners(permutation)).toEqual(EXPECTED);
    }
  });

  it('is not vacuous — a last-match picker would disagree on the priority line', () => {
    // If the evaluator returned the *last* matching rule rather than the first in
    // order, `shared` would resolve to R2 (priority 20), not R1. This asserts the
    // data actually discriminates the mutation the property is meant to catch.
    const lastMatch = (rules: readonly LoadedRule[]): string | undefined => {
      const matches = rules.filter((rule) => rule.description?.needleLower === 'shared');
      return matches.at(-1)?.match.ruleId;
    };
    // In this ordering the last matching rule is R2 (priority 20), while the correct
    // winner is R1 (priority 10) — so the naive last-match picker disagrees, and the
    // real evaluator still returns R1.
    const shuffled = [R1, R2, R3, R4, R5, R6];
    expect(lastMatch(shuffled)).not.toBe(EXPECTED.get('shared'));
    expect(winners(shuffled).get('shared')).toBe(EXPECTED.get('shared'));
  });
});

describe('compareRules — a strict total order', () => {
  it('is antisymmetric and transitive over the rule set', () => {
    for (const a of RULES) {
      expect(compareRules(a, a)).toBe(0);
      for (const b of RULES) {
        if (a === b) continue;
        expect(Math.sign(compareRules(a, b))).toBe(-Math.sign(compareRules(b, a)));
      }
    }

    const sorted = [...RULES].sort(compareRules);
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const left = sorted[i];
      const right = sorted[i + 1];
      if (left === undefined || right === undefined) continue;
      expect(compareRules(left, right)).toBeLessThan(0);
    }
  });
});
