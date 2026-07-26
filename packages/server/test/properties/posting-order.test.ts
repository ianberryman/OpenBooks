import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance, type TrialBalance } from '../../src/modules/ledger';
import { orderedLedgerPlanArb } from './arbitraries';
import { createScene, postPlan, useLedgerDatabase, withContext, type JournalPlan } from './support';

/**
 * Spec §11 invariant 7: posting-order independence.
 *
 * The same set of journals, posted in any order, must produce the same trial balance.
 * It is worth stating because the ledger *does* carry order-dependent state —
 * `journals.sequence_number` is allocated from a counter taken `FOR UPDATE` (D-14), and
 * `journal_lines.id` is an `AUTO_INCREMENT` — so "order does not matter" is a claim
 * about the *report*, not about the rows. What the invariant rules out is any reported
 * figure that depends on arrival order: a running-balance column, a cached total, a
 * per-account sequence. `trial-balance.service.ts` avoids all three by aggregating
 * directly over `journal_lines` with no cache and no denormalized totals, and this is
 * the property that would notice if that ever stopped being true.
 *
 * ## Two orgs rather than one ledger posted twice
 *
 * Order can only be varied by replaying the same journals, and journals cannot be
 * removed — the app user holds no `DELETE` on `journals` (`0004_app_grants`), which is
 * the point. So each order is posted into its own freshly built org and the two trial
 * balances are compared. Accounts are matched by `code`, since account UUIDs
 * necessarily differ between the two orgs; `accountCode` derives codes from position in
 * the plan precisely so this comparison has a stable key.
 */
const harness = useLedgerDatabase();

/** 30 runs each: every run builds two orgs and posts the full journal set twice. */
const RUNS = 30;

/**
 * The order-independent projection of a trial balance.
 *
 * Two things are deliberately projected away, and both for the same reason: they
 * legitimately differ between two orgs, so comparing them would make the property fail
 * for something other than posting order. `accountId` is a per-org UUID. Row order is
 * re-derived by sorting on `code` rather than trusted — the report orders by
 * `accounts.code` today, but *that* is a presentation choice, and a property about
 * arrival order should not double as a test of it.
 *
 * Everything that is a function of the postings — both totals, the difference, and each
 * account's debits, credits, and net — is compared exactly, as strings, so nothing
 * passes through a `Number`.
 */
function comparable(trialBalance: TrialBalance): unknown {
  return {
    totalDebits: trialBalance.totalDebits,
    totalCredits: trialBalance.totalCredits,
    difference: trialBalance.difference,
    rows: trialBalance.rows
      .map((row) => ({
        code: row.code,
        type: row.type,
        normalBalance: row.normalBalance,
        debits: row.debits,
        credits: row.credits,
        balance: row.balance,
      }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  };
}

function reorder(
  journals: readonly JournalPlan[],
  order: readonly number[],
): readonly JournalPlan[] {
  return order.map((index) => {
    const journal = journals[index];
    if (journal === undefined) {
      throw new Error(`Permutation referenced journal ${String(index)}, which does not exist.`);
    }
    return journal;
  });
}

describe('the trial balance does not depend on posting order (spec §11)', () => {
  it('agrees account by account between two orgs given the same journals in different orders', async () => {
    await fc.assert(
      fc.asyncProperty(orderedLedgerPlanArb, async ({ plan, order }) => {
        const inPlanOrder = await createScene(harness, plan.accounts);
        const inShuffledOrder = await createScene(harness, plan.accounts);

        await postPlan(inPlanOrder, plan.journals);
        await postPlan(inShuffledOrder, reorder(plan.journals, order));

        const expected = await withContext(inPlanOrder.ctx, () => getTrialBalance());
        const actual = await withContext(inShuffledOrder.ctx, () => getTrialBalance());

        expect(comparable(actual)).toEqual(comparable(expected));

        // Both ledgers actually hold something, so a pair of empty reports cannot be
        // what made them agree.
        expect(BigInt(expected.totalDebits)).toBeGreaterThan(0n);
      }),
      { numRuns: RUNS },
    );
  });

  it('is unaffected by an asOf bound applied to reordered postings', async () => {
    await fc.assert(
      fc.asyncProperty(orderedLedgerPlanArb, async ({ plan, order }) => {
        const inPlanOrder = await createScene(harness, plan.accounts);
        const inShuffledOrder = await createScene(harness, plan.accounts);

        await postPlan(inPlanOrder, plan.journals);
        await postPlan(inShuffledOrder, reorder(plan.journals, order));

        // Mid-year, so the window usually splits the generated dates rather than
        // including or excluding all of them. The `asOf` bound filters on
        // `entry_date`, which is plan data and therefore order-invariant — but it is
        // applied inside a JOIN condition whose interaction with the outer join was
        // subtle enough to ship as a bug once (see `trial-balance.service.ts`), so it
        // is worth asserting that arrival order does not leak into the window either.
        const asOf = '2026-06-30';
        const expected = await withContext(inPlanOrder.ctx, () => getTrialBalance({ asOf }));
        const actual = await withContext(inShuffledOrder.ctx, () => getTrialBalance({ asOf }));

        expect(comparable(actual)).toEqual(comparable(expected));
        expect(actual.difference).toBe('0');
      }),
      { numRuns: RUNS },
    );
  });
});
