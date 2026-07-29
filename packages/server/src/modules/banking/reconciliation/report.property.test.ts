import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { runInContext } from '../../../context';
import {
  bankJournalIn,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
} from '../../../../test/banking/clearing-support';
import { clearBankStatementLine } from '../clearing/clearing.service';

import {
  createReconciliationSession,
  finaliseReconciliationSession,
} from './reconciliation.service';
import { getReconciliationReport } from './report.service';

/**
 * **The reconciling items are the gap, exactly** (OB-083, the ticket's C8; ROADMAP
 * D-50). The way OB-071 tied the subledger to its control account: two independent
 * aggregations over different tables must agree, so the report is asserted against the
 * session's own `unclearedAmount` — never against a figure recomputed the same way it
 * was.
 *
 * The identity, on every generated shape and in both states:
 *
 * ```
 *   Σ report.reconcilingItems === balances.unclearedAmount
 *   clearedBalance + Σ report.reconcilingItems === bookBalance
 * ```
 *
 * A shape is some exactly-cleared lines (each a line and a bank journal of equal
 * amount, linked), some uncleared bank journals (the reconciling ledger entries), and
 * some uncleared statement lines (the statement-side backlog). The generator is bare —
 * `mutation-test anything load-bearing` (CLAUDE.md) — so an item list that dropped the
 * sign, double-counted a cleared journal, or leaked an uncleared statement line into
 * the sum would fail here, where the example suite's two-line journals could not tell.
 *
 * Real MySQL, a fresh org per run (spec §11). The run count is deliberately modest: each
 * run posts several real journals and clearings, and the property is linear, so a dozen
 * distinct shapes buy the confidence without the suite outrunning its container budget.
 */

const db = useServiceDatabase();
const RUNS = 12;
const POSTED = '2026-01-15';
const END = '2026-01-31';

/** A signed, non-zero minor-units amount — a statement line or a ledger movement. */
const amountArb: fc.Arbitrary<bigint> = fc
  .tuple(fc.integer({ min: 1, max: 100_000 }), fc.boolean())
  .map(([magnitude, negative]) => (negative ? -BigInt(magnitude) : BigInt(magnitude)));

interface Plan {
  readonly cleared: readonly bigint[];
  readonly ledger: readonly bigint[];
  readonly lines: readonly bigint[];
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  cleared: fc.array(amountArb, { maxLength: 4 }),
  ledger: fc.array(amountArb, { maxLength: 4 }),
  lines: fc.array(amountArb, { maxLength: 3 }),
});

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function sumItems(items: readonly { readonly amount: string }[]): bigint {
  return items.reduce((total, item) => total + BigInt(item.amount), 0n);
}

/** Materialises a plan on a fresh scene and returns what the report must reproduce. */
async function build(scene: Scene, plan: Plan): Promise<void> {
  await runInContext(scene.ctx, async () => {
    for (const amount of plan.cleared) {
      const line = await statementLineIn(db, scene, { amountMinor: amount, postedDate: POSTED });
      const journal = await bankJournalIn(db, scene, amount, scene.revenue);
      await clearBankStatementLine(line.uuid, {
        entries: [{ method: 'link_entry', journalId: journal.uuid }],
      });
    }
    for (const amount of plan.ledger) {
      await bankJournalIn(db, scene, amount, scene.expense);
    }
    for (const amount of plan.lines) {
      await statementLineIn(db, scene, { amountMinor: amount, postedDate: POSTED });
    }
  });
}

describe('the reconciling items tie to unclearedAmount', () => {
  it('sum to the gap on every shape, open and finalised', async () => {
    let unclearedSeen = 0;
    let statementBacklogSeen = 0;

    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const scene = await sceneIn(db);
        await build(scene, plan);

        const expectedCleared = sum(plan.cleared);
        const expectedUncleared = sum(plan.ledger);
        const expectedBook = expectedCleared + expectedUncleared;

        // Open the session against the cleared balance, so it may also be finalised
        // (difference is zero — the uncleared statement lines do not enter it).
        const session = await runInContext(scene.ctx, () =>
          createReconciliationSession({
            bankAccountId: scene.bankAccountUuid,
            endDate: END,
            statementClosingBalance: expectedCleared.toString(),
          }),
        );

        const open = await runInContext(scene.ctx, () => getReconciliationReport(session.id));

        // The balances are the session's own, and they are what the generator predicted.
        expect(open.balances.clearedBalance).toBe(expectedCleared.toString());
        expect(open.balances.bookBalance).toBe(expectedBook.toString());
        expect(open.balances.unclearedAmount).toBe(expectedUncleared.toString());

        // The identity, both forms.
        expect(sumItems(open.reconcilingItems)).toBe(expectedUncleared);
        expect(BigInt(open.balances.clearedBalance) + sumItems(open.reconcilingItems)).toBe(
          BigInt(open.balances.bookBalance),
        );

        // One reconciling item per uncleared ledger journal — a cleared journal that
        // leaked in would push the count past the ledger entries the plan wrote.
        expect(open.reconcilingItems).toHaveLength(plan.ledger.length);
        // The backlog is exactly the uncleared lines, and it stays out of the sum.
        expect(open.unclearedStatementLines).toHaveLength(plan.lines.length);
        expect(sumItems(open.unclearedStatementLines)).toBe(sum(plan.lines));

        // The same identity once membership is frozen (D-51): clearedBalance from the
        // stamp, and the items still the gap.
        const finalised = await runInContext(scene.ctx, () =>
          finaliseReconciliationSession(session.id),
        );
        const after = await runInContext(scene.ctx, () => getReconciliationReport(finalised.id));
        expect(after.state).toBe('finalised');
        expect(after.balances.unclearedAmount).toBe(expectedUncleared.toString());
        expect(sumItems(after.reconcilingItems)).toBe(expectedUncleared);
        expect(BigInt(after.balances.clearedBalance) + sumItems(after.reconcilingItems)).toBe(
          BigInt(after.balances.bookBalance),
        );
        expect(after.reconcilingItems).toHaveLength(plan.ledger.length);

        if (expectedUncleared !== 0n) unclearedSeen += 1;
        if (plan.lines.length > 0) statementBacklogSeen += 1;
      }),
      { numRuns: RUNS },
    );

    // The generator has to actually reach the states the properties are about, or they
    // assert nothing — the discipline `balance-sheet.test.ts` keeps.
    expect(unclearedSeen).toBeGreaterThan(0);
    expect(statementBacklogSeen).toBeGreaterThan(0);
  });
});
