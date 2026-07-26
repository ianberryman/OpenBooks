import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance } from '../../src/modules/ledger';
import { ledgerPlanArb } from './arbitraries';
import {
  createScene,
  linesForOrg,
  postPlan,
  readStoredLines,
  sumLines,
  totalsByJournal,
  useLedgerDatabase,
  withContext,
  type Scene,
} from './support';

/**
 * Spec §11 invariants 1 and 2: journal balance, and org-wide debits equal credits.
 *
 * These are the two invariants the ledger has no structural defence for. A `CHECK`
 * constraint is evaluated per row, so "the lines of this journal sum to zero" is not
 * expressible in the schema — `posting.service.ts` says as much — which makes it
 * precisely the kind of claim a property test is for. Everything below reads the
 * result back out of MySQL rather than inspecting what the service returned, because
 * the invariant is about what the ledger *holds*, not about what the write path
 * intended.
 */
const harness = useLedgerDatabase();

/**
 * 75 runs, and 35 for the two-org property since each of its runs builds two orgs and
 * posts three plans.
 *
 * A run builds an org and posts up to four journals through the real service — roughly
 * fifty round trips — which costs about 20ms against the harness container. 75 runs is
 * therefore under two seconds for a couple of hundred generated journals, which covers
 * every amount band and line-count shape many times over. The run count is chosen
 * against that measured cost rather than set to a round number: against a real database
 * the marginal value of run 300 is far below its price, and a property suite nobody
 * wants to run is worth less than a smaller one that runs on every commit.
 */
const RUNS = 75;
const MULTI_ORG_RUNS = 35;

describe('every posted journal balances (spec §11)', () => {
  it('has debits equal to credits, for any line count and any amounts', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, async (plan) => {
        const scene = await createScene(harness, plan.accounts);
        await postPlan(scene, plan.journals);

        const totals = totalsByJournal(linesForOrg(await readStoredLines(harness), scene.orgId));

        // The count is part of the invariant, not incidental. A write path that
        // dropped a journal, or that wrote its header without its lines, would leave
        // every surviving journal balanced and still be broken.
        expect(totals.size).toBe(plan.journals.length);

        for (const [journalId, journal] of totals) {
          expect(journal.debits, `journal ${journalId} debits`).toBe(journal.credits);
          // Balance alone is satisfied by a journal of no value, which
          // `validateLines` rejects for being financially meaningless.
          expect(journal.debits).toBeGreaterThan(0n);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('org-wide debits equal org-wide credits (spec §11)', () => {
  it('reports a zero difference across every journal in the org', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, async (plan) => {
        const scene = await createScene(harness, plan.accounts);
        await postPlan(scene, plan.journals);

        const trialBalance = await withContext(scene.ctx, () => getTrialBalance());
        const stored = sumLines(linesForOrg(await readStoredLines(harness), scene.orgId));

        expect(trialBalance.totalDebits).toBe(trialBalance.totalCredits);
        expect(trialBalance.difference).toBe('0');

        // The anchor, and the reason this property is not vacuous: two equal zeros
        // satisfy the assertions above, so a trial balance that aggregated nothing —
        // a broken join, an `asOf` bound applied in the wrong clause, a lost
        // `SUM` — would pass. Tying both totals to the rows actually stored is what
        // makes the equality mean the ledger was read.
        expect(BigInt(trialBalance.totalDebits)).toBe(stored.debits);
        expect(BigInt(trialBalance.totalCredits)).toBe(stored.credits);
        expect(stored.debits).toBeGreaterThan(0n);
      }),
      { numRuns: RUNS },
    );
  });

  it('stays balanced per org while other orgs hold postings of their own', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, ledgerPlanArb, async (mine, theirs) => {
        const scenes: readonly Scene[] = [
          await createScene(harness, mine.accounts),
          await createScene(harness, theirs.accounts),
        ];
        const [self, other] = scenes;
        if (self === undefined || other === undefined) throw new Error('unreachable');

        // Interleaved, so neither org's postings are a contiguous block of
        // `journals.created_at` or of the auto-increment on `journal_lines.id`.
        await postPlan(self, mine.journals);
        await postPlan(other, theirs.journals);
        await postPlan(self, mine.journals);

        for (const scene of scenes) {
          const trialBalance = await withContext(scene.ctx, () => getTrialBalance());
          const stored = sumLines(linesForOrg(await readStoredLines(harness), scene.orgId));

          expect(trialBalance.difference).toBe('0');
          // Balanced *and* scoped: an aggregation that leaked another org's lines
          // would still balance, since every org balances. Only the equality against
          // this org's own rows catches it.
          expect(BigInt(trialBalance.totalDebits)).toBe(stored.debits);
        }
      }),
      { numRuns: MULTI_ORG_RUNS },
    );
  });
});
