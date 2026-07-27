import type { PostedJournal } from '@openbooks/plugin-api';
import fc from 'fast-check';

import { setJournalLineDimensions } from '../../src/modules/dimensions';
import { reverseJournal } from '../../src/modules/ledger';
import { calendarDate, fiscalYearStartDate } from '../reports/balance-sheet-support';
import type { Axis } from '../reports/support';
import { post, withContext } from '../reports/support';

import { MAX_LINE_AMOUNT } from './arbitraries';
import type { BalanceSheetPlan, MaterializedBalanceSheetLedger } from './balance-sheet-arbitraries';
import { balanceSheetPlanArb, CURRENT_FISCAL_YEAR } from './balance-sheet-arbitraries';
import type { PlannedTags } from './report-arbitraries';
import { AXIS_A_VALUES, AXIS_B_VALUES } from './report-arbitraries';

/**
 * Generated ledgers for the cross-report properties (OB-053).
 *
 * Built on `balanceSheetPlanArb`, which is built on `reportPlanArb`, which is built
 * on `ledgerPlanArb`. Each of those files argues for the layer below it and none of
 * that argument is repeated here; what matters is that the stack already produces
 * every shape these properties need except one — a chart with contra accounts and a
 * hierarchy, journals of more than two lines, amounts spanning the band above 2^53,
 * per-line tags on two axes with untagged lines among them, a fiscal year that never
 * starts in January, and postings on both sides of the fiscal-year boundary
 * including one dated on the boundary itself.
 *
 * The one thing missing is a **correction**: a journal posted and then reversed.
 * `reversal.test.ts` reverses through `ledgerPlanArb`, which knows nothing about
 * charts, tags or fiscal years, so its ledgers cannot carry a cross-report claim.
 * What is added here is a correction journal drawn over the fixed chart
 * `balance-sheet-arbitraries.ts` appends to every run.
 *
 * ## Why the correction is drawn over the fixed accounts rather than the generated ones
 *
 * A reversal that nets to zero everywhere is only a claim about *every report* if
 * every report moved in the first place. A journal over two randomly typed accounts
 * touches revenue or expense on a minority of runs, so on the rest the P&L, both
 * derived equity lines, and half the balance sheet would be unchanged before and
 * after — and the property would pass against a `reverseJournal` that did nothing at
 * all to them. Drawing the correction over the fixed chart, with an expense debit
 * and a revenue credit present on every run, makes all four reports move.
 *
 * ## Why the correction has more than two lines
 *
 * CLAUDE.md records the mutation this exists for: permuting a reversal's accounts
 * instead of swapping its sides is *identical to correct* on a two-line journal, and
 * two-line journals were all M1's example suite posted. Three to seven lines, with
 * differing counts on the two sides, is what makes the permutation observable.
 *
 * ## Why the correction is dated on a boundary
 *
 * Either the fiscal year's first day or the report's own `asOf`, both drawn half the
 * time. Those are the two dates where a correction can fall out of the window a
 * report reads: the first is the boundary D-20 splits the derived equity lines at,
 * the second is an inclusive upper bound. A date in the middle of the year is the
 * case where an off-by-one cannot show.
 */

/**
 * The side each fixed account appears on, and the two that are never omitted.
 *
 * `9500` (expense) leads the debits and `9400` (revenue) leads the credits, so every
 * correction moves both P&L sections and therefore `currentYearEarnings`. The rest
 * are drawn freely and include the contra asset `9110` and the contra revenue
 * `9410`, whose sign comes from `type` rather than `normalBalance` in every report.
 */
const CORRECTION_DEBIT_CODES = ['9100', '9110', '9410', '9500'] as const;
const CORRECTION_CREDIT_CODES = ['9100', '9200', '9300', '9400'] as const;

/**
 * At most four debit lines, matching `MAX_LINES_PER_SIDE` in `arbitraries.ts`.
 *
 * `MAX_LINE_AMOUNT` is that file's cap divided by four, so four lines at the cap
 * total exactly the largest storable amount. A fifth would make a generated journal
 * the posting service legitimately refuses, which proves nothing and hides
 * everything.
 */
const MAX_CORRECTION_DEBITS = 4;
const MAX_CORRECTION_CREDITS = 3;

/**
 * Amounts in the two bands that behave differently, as `balance-sheet-arbitraries.ts`
 * draws them: the small band where a counterexample is readable, and the band above
 * 2^53 where a `double` stops being exact (D-13).
 */
const correctionAmountArb = fc.oneof(
  { withCrossShrink: true },
  { arbitrary: fc.bigInt({ min: 1n, max: 1_000_000n }), weight: 6 },
  { arbitrary: fc.bigInt({ min: 2n ** 53n + 1n, max: MAX_LINE_AMOUNT }), weight: 2 },
);

const correctionTagsArb: fc.Arbitrary<PlannedTags> = fc.record({
  a: fc.option(fc.nat({ max: AXIS_A_VALUES - 1 }), { nil: null }),
  b: fc.option(fc.nat({ max: AXIS_B_VALUES - 1 }), { nil: null }),
});

export interface CorrectionLine {
  readonly code: string;
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
  readonly tags: PlannedTags;
}

export interface CorrectionJournal {
  readonly date: string;
  readonly lines: readonly CorrectionLine[];
}

export interface CrossReportRange {
  readonly from: string;
  readonly to: string;
}

export interface CrossReportCase {
  readonly plan: BalanceSheetPlan;
  /** Posted on top of the plan, then reversed. */
  readonly correction: CorrectionJournal;
  /** For the reports that take a range rather than an `asOf`. */
  readonly range: CrossReportRange;
}

export const crossReportCaseArb: fc.Arbitrary<CrossReportCase> = balanceSheetPlanArb.chain((plan) =>
  fc
    .record({ correction: correctionArb(plan), range: rangeArb(plan) })
    .map(({ correction, range }) => ({ plan, correction, range })),
);

function correctionArb(plan: BalanceSheetPlan): fc.Arbitrary<CorrectionJournal> {
  const codeArb = (codes: readonly string[]): fc.Arbitrary<string> => fc.constantFrom(...codes);

  return fc
    .record({
      date: fc.constantFrom(fiscalYearStartDate(CURRENT_FISCAL_YEAR, plan.startMonth), plan.asOf),
      leadAmount: correctionAmountArb,
      extraDebits: fc.array(
        fc.record({ code: codeArb(CORRECTION_DEBIT_CODES), amount: correctionAmountArb }),
        { minLength: 1, maxLength: MAX_CORRECTION_DEBITS - 1 },
      ),
      extraCredits: fc.array(codeArb(CORRECTION_CREDIT_CODES), {
        minLength: 0,
        maxLength: MAX_CORRECTION_CREDITS - 1,
      }),
      tags: fc.array(correctionTagsArb, { minLength: 8, maxLength: 8 }),
    })
    .map((draw) => {
      const tag = (index: number): PlannedTags => draw.tags[index] ?? { a: null, b: null };

      const debits: CorrectionLine[] = [
        { code: '9500', side: 'debit', amount: draw.leadAmount, tags: tag(0) },
        ...draw.extraDebits.map((slot, index) => ({
          code: slot.code,
          side: 'debit' as const,
          amount: slot.amount,
          tags: tag(index + 1),
        })),
      ];

      const total = debits.reduce((running, line) => running + line.amount, 0n);
      const creditCodes = ['9400', ...draw.extraCredits];
      const shares = splitTotal(total, creditCodes.length);
      const credits: CorrectionLine[] = shares.map((amount, index) => ({
        // `shares` may be shorter than `creditCodes` — see `splitTotal` — so the
        // code is read positionally and the extras simply go unused.
        code: creditCodes[index] ?? '9400',
        side: 'credit' as const,
        amount,
        tags: tag(index + MAX_CORRECTION_DEBITS),
      }));

      return { date: draw.date, lines: [...debits, ...credits] };
    });
}

/**
 * Splits `total` into `parts` strictly positive shares, losing nothing.
 *
 * Fewer shares than asked for when `total < parts`, because
 * `chk_journal_lines_one_sided` requires every line to carry at least one minor unit
 * and the smallest total a generated journal can have is 1 — the same accommodation
 * `arbitraries.ts` makes, for the same constraint. The last share takes the
 * remainder so integer division drops nothing.
 */
function splitTotal(total: bigint, parts: number): readonly bigint[] {
  const count = total < BigInt(parts) ? Number(total) : parts;
  const each = total / BigInt(count);

  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? total - each * BigInt(count - 1) : each,
  );
}

/**
 * A range whose bounds land on the plan's own journal dates three times out of four.
 *
 * The weighting is `report-arbitraries.ts`'s measurement and not a style choice:
 * with bounds drawn uniformly from the year, mutating the opening window's `<` to
 * `<=` left every report property passing, and with the bounds drawn from the plan
 * the same mutation failed on the first run. The fiscal year's first day and the
 * sheet's `asOf` are added to the pool because they are the two dates the balance
 * sheet derives its own window from, and the general ledger has to agree with the
 * trial balance at exactly those.
 */
function rangeArb(plan: BalanceSheetPlan): fc.Arbitrary<CrossReportRange> {
  const dates = [
    ...new Set([
      ...plan.base.journals.map((journal) => journal.date),
      ...plan.fixed.map((journal) => journal.date),
      fiscalYearStartDate(CURRENT_FISCAL_YEAR, plan.startMonth),
      plan.asOf,
    ]),
  ];

  const bound = fc.oneof(
    { withCrossShrink: true },
    { arbitrary: fc.constantFrom(...dates), weight: 3 },
    { arbitrary: anyDayArb(plan.startMonth), weight: 1 },
  );

  return fc
    .tuple(bound, bound)
    .map(([left, right]) =>
      left <= right ? { from: left, to: right } : { from: right, to: left },
    );
}

/** Any day of either fiscal year the generator posts into. */
function anyDayArb(startMonth: number): fc.Arbitrary<string> {
  return fc
    .record({
      year: fc.constantFrom(CURRENT_FISCAL_YEAR - 1, CURRENT_FISCAL_YEAR),
      offset: fc.nat({ max: 11 }),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map(({ year, offset, day }) => {
      const ordinal = startMonth - 1 + offset;
      return calendarDate(year + Math.floor(ordinal / 12), (ordinal % 12) + 1, day);
    });
}

export interface PostedCorrection {
  readonly journal: PostedJournal;
  /** Distinct accounts the correction touched, for the per-account report reads. */
  readonly accountIds: readonly string[];
  /** One entry per line, in line order, so the reversal can be tagged to match. */
  readonly valueIdsByLine: readonly (readonly string[])[];
}

/** Posts the correction through the real services, tags and all. */
export async function postCorrection(
  ledger: MaterializedBalanceSheetLedger,
  correction: CorrectionJournal,
): Promise<PostedCorrection> {
  const valueIdsByLine = correction.lines.map((line) =>
    tagValueIds(ledger.axisA, ledger.axisB, line.tags),
  );

  const journal = await post(
    ledger.scene,
    correction.date,
    correction.lines.map((line, index) => ({
      accountId: accountId(ledger, line.code),
      side: line.side,
      amount: line.amount,
      valueIds: valueIdsByLine[index] ?? [],
    })),
  );

  return {
    journal,
    accountIds: [...new Set(correction.lines.map((line) => accountId(ledger, line.code)))],
    valueIdsByLine,
  };
}

export interface ReverseCorrectionOptions {
  /**
   * Whether the reversal is retagged to match the original.
   *
   * Not a default, because there is no neutral answer: `reverseJournal` deliberately
   * does **not** copy tags — a tag is mutable analysis (D-32) and the correction a
   * reversal makes is frequently why the tagging is about to change — so a reversal
   * left alone restores every report's totals and does not restore its slices. Which
   * of those two a property is about has to be stated at the call site.
   */
  readonly copyTags: boolean;
}

/**
 * Reverses the correction on its own date, optionally retagging it to match.
 *
 * On its own date rather than a later one because the properties are "the reports
 * return to what they said": a reversal dated after a report's upper bound is in the
 * ledger and out of the window, so nothing would net and the property would be
 * asserting the opposite of what it claims.
 *
 * Tags are copied by line index, which is sound because `selectJournalToReverse`
 * reads the original's lines `ORDER BY line_number` and the reversal re-derives its
 * own numbers from that same order. The length check is what would notice if that
 * stopped being true, rather than the tags silently landing on the wrong lines.
 */
export async function reverseCorrection(
  ledger: MaterializedBalanceSheetLedger,
  posted: PostedCorrection,
  options: ReverseCorrectionOptions,
): Promise<PostedJournal> {
  const { scene } = ledger;

  const reversal = await withContext(scene.ctx, () =>
    reverseJournal(
      {
        journalId: posted.journal.journalId,
        date: posted.journal.date,
        actorType: 'user',
        actorId: scene.ctx.actorId,
      },
      scene.ctx,
    ),
  );

  if (reversal.lines.length !== posted.journal.lines.length) {
    throw new Error(
      `The reversal has ${String(reversal.lines.length)} lines and the original has ` +
        `${String(posted.journal.lines.length)}, so tags cannot be matched by position.`,
    );
  }

  if (options.copyTags) {
    for (const [index, line] of reversal.lines.entries()) {
      const valueIds = posted.valueIdsByLine[index] ?? [];
      if (valueIds.length === 0) continue;
      await setJournalLineDimensions(line.lineId, { valueIds: [...valueIds] }, scene.ctx);
    }
  }

  return reversal;
}

export function accountId(ledger: MaterializedBalanceSheetLedger, code: string): string {
  const account = ledger.accounts.get(code);
  if (account === undefined) throw new Error(`Chart is missing account ${code}.`);
  return account.id;
}

function tagValueIds(axisA: Axis, axisB: Axis, tags: PlannedTags): readonly string[] {
  const ids: string[] = [];
  if (tags.a !== null) ids.push(valueId(axisA, `A${String(tags.a)}`));
  if (tags.b !== null) ids.push(valueId(axisB, `B${String(tags.b)}`));
  return ids;
}

function valueId(axis: Axis, code: string): string {
  const id = axis.values.get(code);
  if (id === undefined) throw new Error(`Axis is missing value ${code}.`);
  return id;
}
