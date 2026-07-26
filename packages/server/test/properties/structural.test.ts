import { MAX_MONEY_MINOR_UNITS, MIN_MONEY_MINOR_UNITS } from '@openbooks/shared-types/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ledgerPlanArb } from './arbitraries';
import {
  createScene,
  postPlan,
  readStoredLines,
  tryInsertLine,
  useLedgerDatabase,
} from './support';

/**
 * Spec §11 invariants 4 and 5: no one-sided lines, and `journal_lines.org_id` matches
 * its parent journal.
 *
 * **Both of these pass for a structural reason, and that is the interesting part.**
 * Unlike journal balance, neither is a rule the service remembers to apply:
 *
 * - `chk_journal_lines_one_sided` is a `CHECK` on the row — exactly one of
 *   `debit_minor` / `credit_minor` positive, the other zero. It rules out negative
 *   amounts and zero-value lines in the same expression (`0002_ledger`).
 * - `fk_journal_lines_journal` references `journals (org_id, id)` through that table's
 *   `UNIQUE (org_id, id)` key, not `journals (id)`. `migrations/README.md` states the
 *   consequence directly: a line whose `org_id` disagrees with its journal's "cannot be
 *   inserted — the foreign key has nothing to point at."
 *
 * So a property that finds no violation among generated postings is weak evidence: it
 * would also find none if the schema were silent and the service happened to be
 * careful. Each property below is therefore paired with a demonstration that MySQL
 * *refuses* the violating row, which is the claim actually worth making. The two
 * halves answer different questions — "does the write path produce it?" and "could
 * anything store it?" — and only together do they establish the invariant.
 */
const harness = useLedgerDatabase();

/**
 * The survey properties assert over every row in the database, so each run inherits the
 * rows every earlier run wrote and the coverage compounds — by the last run they are
 * checking a few thousand lines, not the twenty that run generated. The two-org survey
 * gets half the runs because each of its runs builds two orgs. The refusal property is
 * a single insert per run and costs almost nothing, so it gets the most.
 */
const SURVEY_RUNS = 50;
const MULTI_ORG_SURVEY_RUNS = 25;
const REFUSAL_RUNS = 96;

/**
 * Any value a `BIGINT` money column can hold, biased to the neighbourhood of zero.
 *
 * Bounded by the money module's own limits rather than by a literal, so a value out of
 * `BIGINT` range cannot reach MySQL — that would be refused for being unstorable, which
 * is a true fact about a different constraint and would make the equivalence below
 * report the wrong reason.
 */
const storableAmountArb = fc.oneof(
  { withCrossShrink: true },
  { arbitrary: fc.bigInt({ min: -3n, max: 3n }), weight: 5 },
  {
    arbitrary: fc.bigInt({ min: MIN_MONEY_MINOR_UNITS, max: MAX_MONEY_MINOR_UNITS }),
    weight: 1,
  },
);

describe('no one-sided lines (spec §11)', () => {
  it('stores exactly one positive side on every line the ledger writes', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, async (plan) => {
        const scene = await createScene(harness, plan.accounts);
        await postPlan(scene, plan.journals);

        const lines = await readStoredLines(harness);
        expect(lines.length).toBeGreaterThan(0);

        for (const line of lines) {
          const oneSided =
            (line.debitMinor > 0n && line.creditMinor === 0n) ||
            (line.debitMinor === 0n && line.creditMinor > 0n);
          expect(oneSided, `${line.debitMinor.toString()}/${line.creditMinor.toString()}`).toBe(
            true,
          );
        }
      }),
      { numRuns: SURVEY_RUNS },
    );
  });

  /**
   * The refusal half, stated as an equivalence rather than a rejection list.
   *
   * "These bad pairs are refused" is a weaker claim than it looks, because a constraint
   * that refused *everything* would satisfy it. Asserting acceptance and refusal from
   * one generated pair — accepted if and only if exactly one side is positive — pins
   * the constraint's boundary in both directions at once.
   *
   * Amounts come from a narrow band around zero, where every interesting case lives
   * (both positive, both zero, one negative, both negative), plus the full signed
   * `BIGINT` range, so the `CHECK` is also exercised at the extremes the column can
   * hold. Shrinking prefers the narrow band, so a counterexample is a pair of single
   * digits rather than a pair of nineteen-digit numbers.
   */
  it('refuses any other pair of amounts, and accepts every one-sided pair', async () => {
    const journal = await harness.factories.journal();
    const [line] = journal.lines;
    if (line === undefined) throw new Error('The journal factory produced no lines.');

    // Line numbers must stay unique within the journal (`uq_journal_lines_journal_line`),
    // and the harness resets per test rather than per run, so they come from a counter
    // that survives the whole property.
    let lineNumber = 100;

    await fc.assert(
      fc.asyncProperty(storableAmountArb, storableAmountArb, async (debitMinor, creditMinor) => {
        lineNumber += 1;
        const result = await tryInsertLine(harness, {
          orgId: journal.orgId,
          journalId: journal.id,
          lineNumber,
          accountId: line.accountId,
          debitMinor,
          creditMinor,
        });

        const oneSided =
          (debitMinor > 0n && creditMinor === 0n) || (debitMinor === 0n && creditMinor > 0n);
        expect(
          result.accepted,
          `debit ${debitMinor.toString()} credit ${creditMinor.toString()}`,
        ).toBe(oneSided);
        if (!result.accepted) {
          // Names the constraint, so a row rejected by some unrelated failure — a
          // duplicate line number, a broken parameter binding — cannot be mistaken
          // for the schema doing its job.
          expect(result.message).toContain('chk_journal_lines_one_sided');
        }
      }),
      { numRuns: REFUSAL_RUNS },
    );
  });
});

describe('journal_lines.org_id matches its parent journal (spec §11)', () => {
  it('never disagrees with the parent, across every line in the database', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, ledgerPlanArb, async (mine, theirs) => {
        // Two orgs, because a one-tenant database cannot distinguish "the org_id is
        // right" from "there is only one org_id it could be".
        const self = await createScene(harness, mine.accounts);
        const other = await createScene(harness, theirs.accounts);
        await postPlan(self, mine.journals);
        await postPlan(other, theirs.journals);

        // `readStoredLines` joins on `journals.id` alone; joining on the composite key
        // the way production does would filter a mismatch out of the result set and
        // turn a violation into an absence. See its comment.
        const lines = await readStoredLines(harness);
        expect(lines.length).toBeGreaterThan(0);

        for (const line of lines) {
          expect(line.lineOrgId, `line of journal ${line.journalId}`).toBe(line.journalOrgId);
        }
      }),
      { numRuns: MULTI_ORG_SURVEY_RUNS },
    );
  });

  /**
   * The refusal half, and the one that carries the weight.
   *
   * Three rows, differing only in which org the line claims and which org its account
   * belongs to. The accepted case is not decoration: without it, the two refusals
   * would be consistent with `journal_lines` rejecting every raw insert, and the test
   * would prove nothing about tenancy.
   */
  it('cannot be violated: MySQL refuses a line whose org disagrees with its journal', async () => {
    const mine = await harness.factories.journal();
    const theirs = await harness.factories.journal();
    const [myLine] = mine.lines;
    const [theirLine] = theirs.lines;
    if (myLine === undefined || theirLine === undefined) {
      throw new Error('The journal factory produced no lines.');
    }

    const attempt = (row: {
      readonly orgId: Buffer;
      readonly journalId: Buffer;
      readonly accountId: Buffer;
      readonly lineNumber: number;
    }) => tryInsertLine(harness, { ...row, debitMinor: 1n, creditMinor: 0n });

    // Consistent: line, journal, and account all in one org.
    const consistent = await attempt({
      orgId: mine.orgId,
      journalId: mine.id,
      accountId: myLine.accountId,
      lineNumber: 50,
    });
    expect(consistent.accepted).toBe(true);

    // The line claims another org than its journal. Its account is chosen from *that*
    // org, so `fk_journal_lines_account` is satisfied and the journal key is the only
    // thing that can fail — otherwise the refusal would be ambiguous.
    const foreignOrg = await attempt({
      orgId: theirs.orgId,
      journalId: mine.id,
      accountId: theirLine.accountId,
      lineNumber: 51,
    });
    expect(foreignOrg.accepted).toBe(false);
    if (!foreignOrg.accepted) {
      expect(foreignOrg.message).toContain('fk_journal_lines_journal');
    }

    // The mirror image: org and journal agree, but the account belongs elsewhere. The
    // same composite-key pattern makes a cross-org account reference unstorable, which
    // is why `assertAccountsPostable` exists for the error *surface* (A7) rather than
    // for correctness.
    const foreignAccount = await attempt({
      orgId: mine.orgId,
      journalId: mine.id,
      accountId: theirLine.accountId,
      lineNumber: 52,
    });
    expect(foreignAccount.accepted).toBe(false);
    if (!foreignAccount.accepted) {
      expect(foreignAccount.message).toContain('fk_journal_lines_account');
    }
  });
});
