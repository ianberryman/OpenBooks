import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import { createTaxRate } from '../../src/modules/tax';

import {
  createSubledgerScene,
  dateAfterEpoch,
  useSubledgerDatabase,
  withContext,
  type SubledgerScene,
} from './subledger-support';
import { uuidToBuffer, type TestDatabase } from '../db';

/**
 * **Inclusive and exclusive entry of the same invoice post identical journals**
 * (OB-071; M3 C5, ROADMAP D-35).
 *
 * ## D-35's precondition, and why this generator is built the way it is
 *
 * D-35 states the criterion and then states that it is not unconditional, and the
 * boundary has to be read before writing a line of this file — a test written
 * without it "would either fail or be quietly weakened until it passed".
 *
 * Extraction and addition are exact in one direction only. D-35's own example:
 * gross 7 at 50% extracts to net 5 and tax 2, while adding 50% to a net of 5 gives
 * tax 3. Both are correct roundings of *different rationals*, and no rounding rule
 * reconciles them, because an inclusive unit price is itself whole cents (D-13). So
 * C5 is asserted, in D-35's words, "over entries whose line extension is exact",
 * which is every invoice a person actually types.
 *
 * Making that precondition constructive rather than filtering for it is the whole of
 * this generator, and it comes out of the algebra rather than out of trial:
 *
 * Write the rate as `r`. The inclusive path applies `r / (1 + r)` and the exclusive
 * path applies `r`. Reduce `r / (1 + r)` to lowest terms `n / D`. Then a gross unit
 * price that is a **multiple of `D`** splits with no rounding at all: `p = kD` gives
 * tax `kn` and net `k(D − n)` exactly. Feed that net back through the exclusive
 * path and its rate is `n / (D − n)`, so its tax is `k(D − n) · n / (D − n) = kn` —
 * the same integer, reached from the other side. With a quantity `q` for which
 * `q · k` is a whole number, both line extensions are exact too, and the two
 * documents are then the same invoice entered two ways.
 *
 * For 20% that makes `n/D = 1/6`, so any multiple of 6 cents works; for 8.875% it is
 * `71/871`. The generator picks a percentage, derives `D` and `n` from it by a `gcd`
 * written out here, and builds the pair. Nothing is filtered and nothing is
 * discarded, so every run asserts the property rather than most runs discarding.
 *
 * ## The boundary is asserted, not assumed
 *
 * A property that only ever holds inside its precondition is worth very little if
 * the precondition is doing all the work silently. The second test below takes the
 * same rate and a unit price that is deliberately **not** a multiple of `D`, enters
 * it both ways, and asserts that the two totals differ — which is D-35's claim
 * stated as a test rather than as prose. If that ever stops failing, the arithmetic
 * has changed and the precondition above has become unnecessary; someone should find
 * out why rather than discover it as an unexplained passing test.
 *
 * ## What "identical journals" is compared on
 *
 * The journal lines themselves, read from `journal_lines` by account, debit and
 * credit — not the documents' totals, which are computed by the same eleven lines of
 * arithmetic on the way in and would agree with themselves. The totals are compared
 * as well, because the subledger half of C5 is a claim too, but the journals are the
 * claim the criterion makes.
 */
const harness = useSubledgerDatabase();

const RUNS = 14;
const SHRINKING_BUDGET_MS = 120_000;

interface TaxModeCase {
  readonly startMonth: number;
  /** Parts per million, as `tax_rates.rate_ppm` stores it. Strictly positive. */
  readonly ratePpm: number;
  /** The gross unit price as a multiple of `D`, so the split is exact. */
  readonly multiplier: number;
  /** Ten-thousandths of a unit. */
  readonly quantityUnits: number;
  readonly lineCount: number;
  /** Picks the residual `m` in `1 <= m < D` the second test steps off `kD` by. */
  readonly residualSeed: number;
}

const taxModeCaseArb: fc.Arbitrary<TaxModeCase> = fc.record({
  startMonth: fc.integer({ min: 2, max: 12 }),
  // Rates with wildly different denominators, so `D` ranges from 6 to 871 and the
  // representable unit prices are sparse in some runs and dense in others. 8.875% is
  // the rate `taxPercentageSchema` cites as the one basis points cannot express.
  // 50% is D-35's own worked example (gross 7 extracts to 5 + 2, while adding 50%
  // to 5 gives 3) and it is the rate at which the second test below diverges most
  // readily. Without it the divergence guard is a coin toss on the other five.
  ratePpm: fc.constantFrom(200_000, 50_000, 175_000, 88_750, 100_000, 77_000, 500_000),
  multiplier: fc.integer({ min: 1, max: 400 }),
  quantityUnits: fc.constantFrom(10_000, 20_000, 30_000, 5_000, 25_000),
  lineCount: fc.integer({ min: 1, max: 3 }),
  residualSeed: fc.nat({ max: 10_000 }),
});

describe('inclusive and exclusive entry post identical journals (OB-071, C5, D-35)', () => {
  it(
    'agrees line for line on a document whose extension is exact',
    async () => {
      await fc.assert(
        fc.asyncProperty(taxModeCaseArb, async (input) => {
          const scene = await createSubledgerScene(harness, {
            startMonth: input.startMonth,
            contacts: 1,
          });
          const split = exactSplit(input);

          const rateId = await withContext(scene.ctx, async () => {
            const rate = await createTaxRate(
              {
                name: `Rate ${String(input.ratePpm)}`,
                percentage: percentText(input.ratePpm),
                accountId: scene.accounts.salesTax,
                appliesTo: 'sales',
              },
              scene.ctx,
            );
            return rate.id;
          });

          const inclusive = await approvedInvoice(scene, {
            rateId,
            taxMode: 'inclusive',
            unitAmount: split.grossUnit,
            quantityUnits: split.quantityUnits,
            lineCount: input.lineCount,
          });
          const exclusive = await approvedInvoice(scene, {
            rateId,
            taxMode: 'exclusive',
            unitAmount: split.netUnit,
            quantityUnits: split.quantityUnits,
            lineCount: input.lineCount,
          });

          // The subledger half. Three sums each, so a mode that agreed on the gross
          // and split it differently between revenue and the tax liability — which is
          // the failure that actually reaches a VAT return — is visible.
          expect(inclusive.totals).toEqual(exclusive.totals);

          // The criterion itself. Compared as sorted `(account, debit, credit)`
          // triples: line *order* within a journal is not part of the claim, and
          // `postJournal` is free to emit the tax line wherever it likes.
          const inclusiveLines = await journalLines(harness, inclusive.journalId);
          const exclusiveLines = await journalLines(harness, exclusive.journalId);
          expect(inclusiveLines).toEqual(exclusiveLines);

          // And a guard against the pair agreeing because both are empty or untaxed:
          // a zero-tax journal has two lines and satisfies everything above trivially.
          expect(BigInt(inclusive.totals.tax)).toBeGreaterThan(0n);
          expect(inclusiveLines.length).toBeGreaterThan(2);
        }),
        { numRuns: RUNS },
      );
    },
    SHRINKING_BUDGET_MS,
  );

  /**
   * D-35's own worked example, pinned as an example rather than left to a generator.
   *
   * The decision says: "Gross 7 at 50% extracts to net 5 and tax 2; adding 50% to a
   * net of 5 gives tax 3." That is the entire justification for the precondition the
   * property above constructs, and it is one invoice each way — so it is asserted
   * directly instead of being hoped for.
   *
   * Measured, and the reason this is not left to the generator: a run that merely
   * *counted* divergences across fourteen generated cases came up empty on some
   * seeds. Whether a residual crosses the half-cent differently on the two paths is
   * a property of the rate, and a guard that depends on which rates a seed happened
   * to draw is a guard that fails for reasons unrelated to the arithmetic.
   */
  it('does not commute on D-35’s own example: gross 7 at 50%', async () => {
    const scene = await createSubledgerScene(harness, { startMonth: 4, contacts: 1 });

    const rateId = await withContext(scene.ctx, async () => {
      const rate = await createTaxRate(
        {
          name: 'Half',
          percentage: '50',
          accountId: scene.accounts.salesTax,
          appliesTo: 'sales',
        },
        scene.ctx,
      );
      return rate.id;
    });

    const inclusive = await approvedInvoice(scene, {
      rateId,
      taxMode: 'inclusive',
      unitAmount: 7n,
      quantityUnits: 10_000,
      lineCount: 1,
    });
    const exclusive = await approvedInvoice(scene, {
      rateId,
      taxMode: 'exclusive',
      unitAmount: 5n,
      quantityUnits: 10_000,
      lineCount: 1,
    });

    expect(inclusive.totals).toEqual({ net: '5', tax: '2', gross: '7' });
    expect(exclusive.totals).toEqual({ net: '5', tax: '3', gross: '8' });

    // 7 is not a multiple of 6, which is `r / (1 + r)` at 50% in lowest terms — so
    // this pair sits outside the precondition by exactly one cent, and the two paths
    // land a cent apart. Inside it (the property above) they are identical. If this
    // ever starts passing with equal totals, `compute.ts` has changed and the
    // precondition is no longer necessary; that is worth understanding rather than
    // discovering as a test somebody deleted.
    expect(inclusive.totals.gross).not.toBe(exclusive.totals.gross);
  });

  it(
    'stays within a cent or two of itself outside the precondition',
    async () => {
      await fc.assert(
        fc.asyncProperty(taxModeCaseArb, async (input) => {
          const scene = await createSubledgerScene(harness, {
            startMonth: input.startMonth,
            contacts: 1,
          });
          const { denominator, numerator } = ratioOf(input.ratePpm);

          // A generated residual `1 <= m < D` rather than a fixed `+1`, and the
          // difference is the whole of whether this test says anything. Measured:
          // with `m = 1` fixed, all fourteen runs *agreed* — at 20% (`n/D = 1/6`)
          // the residual rounds the same way on both paths for m = 1, 2, 4 and 5,
          // and only m = 3 diverges. A generator that could only produce the one
          // residual that happens not to diverge would report "the precondition is
          // unnecessary", which is false.
          const residual = 1n + BigInt(input.residualSeed % Number(denominator - 1n));
          const grossUnit = BigInt(input.multiplier) * denominator + residual;
          const inclusiveTax = roundHalfUp(grossUnit * numerator, denominator);
          const netUnit = grossUnit - inclusiveTax;

          const rateId = await withContext(scene.ctx, async () => {
            const rate = await createTaxRate(
              {
                name: `Rate ${String(input.ratePpm)}`,
                percentage: percentText(input.ratePpm),
                accountId: scene.accounts.salesTax,
                appliesTo: 'sales',
              },
              scene.ctx,
            );
            return rate.id;
          });

          const inclusive = await approvedInvoice(scene, {
            rateId,
            taxMode: 'inclusive',
            unitAmount: grossUnit,
            quantityUnits: 10_000,
            lineCount: 1,
          });
          const exclusive = await approvedInvoice(scene, {
            rateId,
            taxMode: 'exclusive',
            unitAmount: netUnit,
            quantityUnits: 10_000,
            lineCount: 1,
          });

          // The bound D-35 states for a representable-adjacent price at quantity one:
          // the two roundings are of different rationals and cannot be more than a
          // cent or two apart. This is the *upper* half of the claim, and it is what
          // would fail if the arithmetic ever started drifting rather than rounding.
          const gap = BigInt(inclusive.totals.gross) - BigInt(exclusive.totals.gross);
          expect(gap >= -2n && gap <= 2n, `gap ${gap.toString()}`).toBe(true);
        }),
        { numRuns: RUNS },
      );
    },
    SHRINKING_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// The precondition, constructed
// ---------------------------------------------------------------------------

interface ExactSplit {
  readonly grossUnit: bigint;
  readonly netUnit: bigint;
  readonly quantityUnits: number;
}

/**
 * A gross unit price that splits exactly at the rate, and a quantity that extends
 * exactly against both prices.
 *
 * `p = kD` where `n/D` is `r/(1+r)` in lowest terms. The quantity is doubled into
 * `k` when it is half-integral, so `q · k` stays whole and neither extension rounds
 * — the second half of D-35's precondition, and the one that is easy to satisfy for
 * the inclusive document and forget for the exclusive one.
 */
function exactSplit(input: TaxModeCase): ExactSplit {
  const { denominator, numerator } = ratioOf(input.ratePpm);
  const halfIntegral = input.quantityUnits % 10_000 !== 0;
  const multiplier = BigInt(input.multiplier) * (halfIntegral ? 2n : 1n);

  const grossUnit = multiplier * denominator;
  const taxUnit = multiplier * numerator;

  return { grossUnit, netUnit: grossUnit - taxUnit, quantityUnits: input.quantityUnits };
}

/** `r / (1 + r)` in lowest terms, from parts per million. */
function ratioOf(ratePpm: number): { readonly numerator: bigint; readonly denominator: bigint } {
  const raw = BigInt(ratePpm);
  const whole = 1_000_000n + raw;
  const divisor = gcd(raw, whole);
  return { numerator: raw / divisor, denominator: whole / divisor };
}

function gcd(left: bigint, right: bigint): bigint {
  return right === 0n ? left : gcd(right, left % right);
}

/** Half-up, matching `DEFAULT_ROUNDING_MODE`. Positive inputs only, which is all this uses. */
function roundHalfUp(value: bigint, by: bigint): bigint {
  return (2n * value + by) / (2n * by);
}

/** Parts per million as the percentage string `taxPercentageSchema` takes. */
function percentText(ratePpm: number): string {
  const scaled = (ratePpm / 10_000).toFixed(4);
  return scaled.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Building and reading one invoice
// ---------------------------------------------------------------------------

interface InvoiceSpec {
  readonly rateId: string;
  readonly taxMode: 'inclusive' | 'exclusive';
  readonly unitAmount: bigint;
  readonly quantityUnits: number;
  readonly lineCount: number;
}

interface ApprovedInvoice {
  readonly journalId: string;
  readonly totals: { readonly net: string; readonly tax: string; readonly gross: string };
}

async function approvedInvoice(scene: SubledgerScene, spec: InvoiceSpec): Promise<ApprovedInvoice> {
  const { ctx } = scene;
  const contactId = scene.contacts[0];
  if (contactId === undefined) throw new Error('The tax-mode scene has no contact.');
  const issueDate = dateAfterEpoch(0);

  const created = await withContext(ctx, () =>
    createInvoice(
      {
        contactId,
        issueDate,
        dueDate: issueDate,
        taxMode: spec.taxMode,
        lines: Array.from({ length: spec.lineCount }, () => ({
          description: 'Work',
          quantity: quantityText(spec.quantityUnits),
          unitAmount: spec.unitAmount.toString(),
          accountId: scene.accounts.income,
          taxRateId: spec.rateId,
        })),
      },
      ctx,
    ),
  );

  const approved = await withContext(ctx, () => approveInvoice(created.id, ctx));
  if (approved.journalId === null) {
    throw new Error('An approved invoice carries no journal, which C1 makes unrepresentable.');
  }

  return { journalId: approved.journalId, totals: approved.totals };
}

interface StoredLine {
  readonly code: string;
  readonly debit: string;
  readonly credit: string;
}

/**
 * One journal's lines as `(account code, debit, credit)`, sorted.
 *
 * Read directly rather than through a report, because the criterion is about the
 * *journal* and every report is an aggregation that could hide a compensating pair.
 * The account **code** rather than its id, so two journals in two different orgs
 * would still be comparable — which they are not here, but a helper that only works
 * within one org invites a future caller to discover that the hard way.
 */
async function journalLines(db: TestDatabase, journalUuid: string): Promise<readonly StoredLine[]> {
  const rows = await db.app
    .selectFrom('journal_lines')
    .innerJoin('journals', (join) =>
      join
        .onRef('journals.id', '=', 'journal_lines.journal_id')
        .onRef('journals.org_id', '=', 'journal_lines.org_id'),
    )
    .innerJoin('accounts', (join) =>
      join
        .onRef('accounts.id', '=', 'journal_lines.account_id')
        .onRef('accounts.org_id', '=', 'journal_lines.org_id'),
    )
    .select(['accounts.code as code', 'journal_lines.debit_minor', 'journal_lines.credit_minor'])
    .where('journals.id', '=', uuidToBuffer(journalUuid))
    .execute();

  return rows
    .map((row) => ({
      code: row.code,
      debit: row.debit_minor.toString(),
      credit: row.credit_minor.toString(),
    }))
    .sort((left, right) =>
      `${left.code}|${left.debit}|${left.credit}`.localeCompare(
        `${right.code}|${right.debit}|${right.credit}`,
      ),
    );
}

function quantityText(units: number): string {
  const whole = Math.trunc(units / 10_000);
  const fraction = String(units % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${String(whole)}.${fraction}`;
}
