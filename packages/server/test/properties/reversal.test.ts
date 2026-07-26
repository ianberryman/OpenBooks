import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance } from '../../src/modules/ledger';
import { ledgerPlanArb } from './arbitraries';
import { createScene, postPlan, reverseAll, useLedgerDatabase, withContext } from './support';

/**
 * Spec §11 invariant 6: a journal plus its reversal nets to zero per account.
 *
 * Per *account*, not per journal, and the distinction is the substance. A reversal that
 * merely flipped the totals would net to zero in aggregate while still moving money
 * between accounts, and the aggregate claim is already covered by org-wide balance. The
 * statement worth making is that every account the original touched is left exactly
 * where it started — which is what makes a reversal a correction rather than a second
 * transaction (D-02, D-16).
 *
 * This is also the invariant with the most obvious wrong implementation. Reversal is
 * `postJournal` with the sides swapped and the amounts untouched; swap the *accounts*
 * instead of the sides and the org-wide totals are still balanced, the trial balance
 * still sums to zero difference, and every individual account is wrong. Asserting per
 * account is what separates those two worlds.
 */
const harness = useLedgerDatabase();

/**
 * 50 runs. Each posts up to four journals and then reverses every one of them, so a run
 * costs roughly twice a `balance.test.ts` run — hence fewer of them for a similar
 * second-and-a-half budget.
 */
const RUNS = 50;

describe('a journal and its reversal net to zero per account (spec §11)', () => {
  it('leaves every account at its pre-posting balance, whatever was posted', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, async (plan) => {
        const scene = await createScene(harness, plan.accounts);
        const posted = await postPlan(scene, plan.journals);
        const before = await withContext(scene.ctx, () => getTrialBalance());
        await reverseAll(scene, posted);
        const after = await withContext(scene.ctx, () => getTrialBalance());

        // There was something to reverse. Without this the property would be satisfied
        // by a posting path that wrote nothing at all.
        expect(BigInt(before.totalDebits)).toBeGreaterThan(0n);

        for (const row of after.rows) {
          expect(row.balance, `account ${row.code}`).toBe('0');
          // Stronger than `balance === '0'` on its own for a contra-heavy chart: it
          // says the two sides cancel per account rather than netting out across the
          // account's own debits and credits by coincidence.
          expect(row.debits, `account ${row.code}`).toBe(row.credits);
        }

        // Gross activity doubles. This is what distinguishes "reversed" from "deleted":
        // spec §2.2 and D-16 make the original unremovable, so the zero net balance
        // must be the sum of two recorded movements, not the absence of one. A
        // `reverseJournal` that somehow erased the original would pass every assertion
        // above and fail this one.
        expect(BigInt(after.totalDebits)).toBe(BigInt(before.totalDebits) * 2n);
        expect(after.difference).toBe('0');
      }),
      { numRuns: RUNS },
    );
  });
});
