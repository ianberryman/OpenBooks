import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import type {
  GeneralLedger,
  GeneralLedgerEntry,
  GeneralLedgerQuery,
} from '../../src/modules/reports';
import { getGeneralLedger } from '../../src/modules/reports';
import { useReportDatabase, withContext } from '../reports/support';

import { glCaseArb, glPlanArb } from './general-ledger-arbitraries';
import { AXIS_A_VALUES, materialize } from './report-arbitraries';

/**
 * The general ledger over generated ledgers (OB-044; acceptance B4 and B6).
 *
 * The examples next door say what a split's counterparty is and which order two
 * entries made on one day come back in. These say the things an example cannot,
 * because each is a statement about *every* account and *every* range rather than
 * about one the author happened to write down.
 *
 *  1. **B4.** `opening + movement = closing`, and the running balance of the last
 *     entry equals `closing`. The second half is the one with teeth: the header
 *     comes from `getAccountBalances`, where B4 holds by construction, and the
 *     entries come from a completely separate keyset query with its own copy of
 *     the filter predicate. Asserting that the list's own accumulation lands on
 *     the aggregation's figure is what ties the two together.
 *  2. **Cross-page correctness.** Every page concatenated equals the unpaged
 *     answer, entry for entry, running balance for running balance. That is
 *     strictly stronger than any per-page example: a keyset predicate that is
 *     wrong at a boundary produces a page that is individually plausible and a
 *     concatenation that is short by a row or long by one.
 *  3. **B6.** The ledger sliced by each of an axis's values, plus the unassigned
 *     slice, partitions the unfiltered ledger exactly — the same entries, each
 *     once, and the three balance arms summing.
 *
 * The generator is what makes any of this mean something. `glPlanArb` draws every
 * journal's date from a pool of two or three days, so entries sharing an
 * `entry_date` and entries posted out of date order are the common case rather
 * than a one-in-a-hundred coincidence. Without both, the ordering half of this
 * ticket is untested — see the note at the top of `general-ledger-arbitraries.ts`,
 * and the assertion below that the generator really does produce them.
 */
const harness = useReportDatabase();

/**
 * 30 runs, matching the OB-041 properties.
 *
 * A run materializes the same ledger those do — a chart through `createAccount`,
 * two axes, every journal through `postJournal` — and then reads it back once per
 * account per property, with the paging property reading each account a page at a
 * time at a limit of one to three. Measured at about 65ms a run against the
 * harness container, so the three properties together are a few seconds. The
 * variety comes from the generator rather than from the count: every run is a
 * different chart, a different tag distribution, a different date pool and a
 * different range.
 */
const RUNS = 30;

/** Large enough that every generated plan fits in one page. */
const UNPAGED = 200;

describe('the general ledger, over generated ledgers (OB-044)', () => {
  it('generates entries sharing a date and entries posted out of date order', () => {
    // The generator's own precondition, asserted rather than assumed. Both shapes
    // below are what the second and third cursor columns exist for, and a plan
    // generator that stopped producing them would leave every property here
    // passing against an implementation that ordered by `entry_date` alone.
    const plans = fc.sample(glPlanArb, { numRuns: 40, seed: 44 });

    const withSharedDate = plans.filter((plan) => {
      const dates = plan.journals.map((journal) => journal.date);
      return new Set(dates).size < dates.length;
    });
    const withBackDating = plans.filter((plan) =>
      plan.journals.some(
        (journal, index) =>
          index > 0 && journal.date < (plan.journals[index - 1]?.date ?? journal.date),
      ),
    );

    expect(withSharedDate.length).toBeGreaterThan(0);
    expect(withBackDating.length).toBeGreaterThan(0);
  });

  it('opens, moves and closes on B4, and the last running balance is the closing balance', async () => {
    await fc.assert(
      fc.asyncProperty(glCaseArb, async ({ plan, from, to }) => {
        const { scene, accounts } = await materialize(harness, plan);

        for (const account of accounts) {
          const report = await readPage(scene.ctx, {
            accountId: account.id,
            from,
            to,
            limit: UNPAGED,
          });

          expectDecomposes(report);
          expectEntriesAreTheMovement(report);
          expectOrdered(report.entries);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('pages: every page concatenated is the unpaged ledger, running balances included', async () => {
    await fc.assert(
      fc.asyncProperty(glCaseArb, async ({ plan, from, to, limit }) => {
        const { scene, accounts } = await materialize(harness, plan);

        for (const account of accounts) {
          const query = { accountId: account.id, from, to };
          const whole = await readPage(scene.ctx, { ...query, limit: UNPAGED });
          const paged = await readEveryPage(scene.ctx, { ...query, limit });

          // Entry for entry, and that includes the running balance — which is the
          // only field a page boundary can get wrong without also losing a row.
          expect(paged.entries).toEqual(whole.entries);

          // The header travels with every page, so the last page's `closing` is
          // the figure the last running balance has to land on. With nothing
          // posting concurrently the two reads see the same ledger, and this
          // asserts the header is recomputed rather than carried.
          expect(paged.closing).toBe(whole.closing.balance);

          const last = paged.entries.at(-1);
          if (last !== undefined) {
            expect(last.runningBalance).toBe(paged.closing);
          }

          // Nothing is served twice. `toEqual` above would catch a duplicate only
          // if it displaced something; this catches it directly.
          expect(new Set(paged.entries.map((entry) => entry.lineId)).size).toBe(
            paged.entries.length,
          );
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('slices by an axis plus unassigned, and the parts are exactly the whole (B6)', async () => {
    await fc.assert(
      fc.asyncProperty(glCaseArb, async ({ plan, from, to }) => {
        const { scene, accounts, axisA } = await materialize(harness, plan);
        const valueIds = [...axisA.values.values()];
        expect(valueIds).toHaveLength(AXIS_A_VALUES);

        for (const account of accounts) {
          const base = { accountId: account.id, from, to, limit: UNPAGED };
          const whole = await readPage(scene.ctx, base);

          const slices: GeneralLedger[] = [];
          for (const valueId of valueIds) {
            slices.push(
              await readPage(scene.ctx, {
                ...base,
                dimensions: [{ dimensionId: axisA.id, valueIds: [valueId] }],
              }),
            );
          }
          slices.push(
            await readPage(scene.ctx, {
              ...base,
              dimensions: [{ dimensionId: axisA.id, includeUnassigned: true }],
            }),
          );

          // All three arms, not only movement. D-18's claim is that tagging never
          // moves money, and an opening balance that failed to slice would put the
          // discrepancy before the first row of every sliced report.
          for (const arm of ['opening', 'movement', 'closing'] as const) {
            for (const field of ['debits', 'credits', 'balance'] as const) {
              const parts = slices.reduce((total, slice) => total + BigInt(slice[arm][field]), 0n);
              expect(parts.toString()).toBe(whole[arm][field]);
            }
          }

          // A partition, not merely a sum: a line carries at most one value per
          // axis, so every entry belongs to exactly one slice.
          const sliced = slices.flatMap((slice) => slice.entries.map((entry) => entry.lineId));
          expect(new Set(sliced).size).toBe(sliced.length);
          expect([...sliced].sort()).toEqual(whole.entries.map((entry) => entry.lineId).sort());
        }
      }),
      { numRuns: RUNS },
    );
  });
});

/** B4 on the wire: the three arms are one decomposition, in cents-only strings. */
function expectDecomposes(report: GeneralLedger): void {
  for (const field of ['debits', 'credits', 'balance'] as const) {
    expect((BigInt(report.opening[field]) + BigInt(report.movement[field])).toString()).toBe(
      report.closing[field],
    );
  }
}

/**
 * The entries are the movement, and the running balance is their prefix sum.
 *
 * Two claims in one place because they are the two halves of the same tie between
 * the aggregation and the list: the list's rows must total to the aggregation's
 * `movement`, and each row's running balance must be `opening` plus the rows
 * through it. Either one alone can hold while the other fails — a running balance
 * seeded from the wrong opening totals correctly and reads wrong on every row.
 */
function expectEntriesAreTheMovement(report: GeneralLedger): void {
  let debits = 0n;
  let credits = 0n;
  let running = BigInt(report.opening.balance);

  for (const entry of report.entries) {
    debits += BigInt(entry.debit);
    credits += BigInt(entry.credit);
    running += BigInt(entry.debit) - BigInt(entry.credit);
    expect(entry.runningBalance).toBe(running.toString());
  }

  expect(debits.toString()).toBe(report.movement.debits);
  expect(credits.toString()).toBe(report.movement.credits);

  const last = report.entries.at(-1);
  if (last === undefined) {
    // An empty range is still a statement: nothing moved, so the account closes
    // where it opened.
    expect(report.movement).toEqual({ debits: '0', credits: '0', balance: '0' });
    expect(report.closing).toEqual(report.opening);
  } else {
    expect(last.runningBalance).toBe(report.closing.balance);
  }
}

/**
 * `(entry_date, sequence_number, lineId)`, ascending and strict.
 *
 * Strict is the part worth stating: two entries comparing equal under the ordering
 * would be a cursor that cannot separate them, which is the failure the third
 * column exists to remove and the one a same-date generator is needed to reach.
 */
function expectOrdered(entries: readonly GeneralLedgerEntry[]): void {
  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    if (previous === undefined) continue;
    expect(compareEntries(previous, entry)).toBeLessThan(0);
  }
}

function compareEntries(left: GeneralLedgerEntry, right: GeneralLedgerEntry): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.sequenceNumber !== right.sequenceNumber) {
    return BigInt(left.sequenceNumber) < BigInt(right.sequenceNumber) ? -1 : 1;
  }
  if (left.lineId === right.lineId) return 0;
  return BigInt(left.lineId) < BigInt(right.lineId) ? -1 : 1;
}

function readPage(ctx: RequestContext, query: GeneralLedgerQuery): Promise<GeneralLedger> {
  return withContext(ctx, () => getGeneralLedger(query, ctx));
}

/**
 * Every page of one ledger, concatenated.
 *
 * The iteration bound is not decoration. A keyset predicate that failed to advance
 * — the classic `>=` where `>` was meant — returns the same page forever, and a
 * property test that hung would report as a timeout on whichever run was unlucky
 * rather than as the defect it is.
 */
async function readEveryPage(
  ctx: RequestContext,
  query: GeneralLedgerQuery,
): Promise<{ readonly entries: readonly GeneralLedgerEntry[]; readonly closing: string }> {
  const entries: GeneralLedgerEntry[] = [];
  let cursor: string | undefined;
  let page: GeneralLedger | undefined;

  for (let fetches = 0; fetches < 200; fetches += 1) {
    page = await readPage(ctx, { ...query, ...(cursor === undefined ? {} : { cursor }) });
    entries.push(...page.entries);

    if (page.nextCursor === null) {
      return { entries, closing: page.closing.balance };
    }
    cursor = page.nextCursor;
  }

  throw new Error('The general ledger did not reach its last page in 200 fetches.');
}
