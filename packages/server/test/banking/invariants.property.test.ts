import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { runInContext } from '../../src/context';
import type { DB } from '../../src/db/generated';
import { toWireError } from '../../src/errors';
import { uuidToBuffer } from '../db';

import {
  bankJournalIn,
  billIn,
  invoiceIn,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
} from './clearing-support';
import { clearBankStatementLine } from '../../src/modules/banking/clearing/clearing.service';
import {
  createReconciliationSession,
  finaliseReconciliationSession,
  getReconciliationSession,
} from '../../src/modules/banking/reconciliation/reconciliation.service';
import { getReconciliationReport } from '../../src/modules/banking/reconciliation/report.service';

/**
 * The banking cross-cutting invariants (OB-088, wave 5; ROADMAP E1–E10, D-42, D-43,
 * D-50, D-51; spec §11's subledger-agreement invariant).
 *
 * This is the M4 analog of OB-071's subledger-agreement suite. The single-ticket
 * property tests each prove one seam — E1 idempotency (`statements/`), E4 clearing
 * (`clearing.e4`), the report tie-out (`report.property`). None of them sees the
 * invariant that spans the *whole* pipeline: import → clear (a mix of the three
 * methods) → reconcile, and the one number that ties the banking subledger to the
 * ledger it is built on. That number is what this file generates its way at.
 *
 * ## The centre: one number, four ways of computing it (spec §11, D-50)
 *
 * After a finalised reconciliation, the cleared balance is computable four independent
 * ways over four different tables, and they are always equal:
 *
 * ```
 *   W  the session's own clearedBalance          (reconciliation.service computeFigures)
 *   X  Σ cleared_amount_minor of counted clearings (bank_line_clearings, the subledger)
 *   Y  the bank ledger account's cleared portion    (journal_lines, the ledger itself)
 *   Z  bookBalance − Σ report.reconcilingItems       (the report's enumeration)
 * ```
 *
 * W==X is the subledger reporting its own stored figure; the content is W==Y (the
 * clearing's *stored* movement equals what the ledger actually moved — the OB-071
 * agreement, one level down) and W==Z (the report enumerates the gap exactly, so the
 * cleared portion falls out of book minus items). A mutation that summed unsigned, or
 * counted a cleared journal twice, or leaked an uncleared line into the cleared total,
 * breaks one of Y or Z against W — which a two-line example could not tell (CLAUDE.md).
 *
 * ## Everything round-trips in cents (D-13)
 *
 * No property here reduces to a float comparison: every figure is a `bigint`, and every
 * wire string is asserted to be a canonical integer — no decimal point anywhere, which
 * is the only representation `1234.5599999999999` cannot sneak into.
 *
 * Real MySQL, a fresh org per run (spec §11). Run counts are modest: each run posts
 * several real journals, records real payments and finalises a real session, and the
 * properties are linear, so a handful of generated shapes buy the confidence without
 * the suite outrunning its container budget — the discipline `report.property` keeps.
 */

const db = useServiceDatabase();

const POSTED = '2026-01-15';
const END = '2026-01-31';

/** A canonical signed integer string — cents, never a decimal (D-13). */
const CENTS = /^-?(?:0|[1-9]\d*)$/;
function expectCents(...values: readonly string[]): void {
  for (const value of values) expect(value).toMatch(CENTS);
}

type Method = 'post_entry' | 'link_entry' | 'allocate_document';

/** A signed, non-zero minor-units amount — a cleared movement or a reconciling one. */
const amountArb: fc.Arbitrary<bigint> = fc
  .tuple(fc.integer({ min: 1, max: 500_000 }), fc.boolean())
  .map(([magnitude, negative]) => (negative ? -BigInt(magnitude) : BigInt(magnitude)));

interface ClearedItem {
  readonly amount: bigint;
  readonly method: Method;
}

const clearedItemArb: fc.Arbitrary<ClearedItem> = fc.record({
  amount: amountArb,
  method: fc.constantFrom<Method>('post_entry', 'link_entry', 'allocate_document'),
});

// ---------------------------------------------------------------------------
// Materialising a plan on a fresh scene, through the real services
// ---------------------------------------------------------------------------

/**
 * Clears one line by the requested method, so the clearing's bank movement is exactly
 * `amount` and its difference is zero: `post_entry` posts a journal for the line,
 * `link_entry` links a bank journal of equal amount, `allocate_document` records a real
 * payment against an invoice (money in) or a bill (money out) through M3's mechanism.
 * Every path is the sanctioned service, not a hand-written clearing row.
 */
async function clearOne(scene: Scene, item: ClearedItem): Promise<void> {
  const line = await statementLineIn(db, scene, { amountMinor: item.amount, postedDate: POSTED });
  const inbound = item.amount > 0n;

  switch (item.method) {
    case 'post_entry':
      await clearBankStatementLine(line.uuid, {
        entries: [
          {
            method: 'post_entry',
            accountId: inbound ? scene.revenue.uuid : scene.expense.uuid,
          },
        ],
      });
      return;
    case 'link_entry': {
      const journal = await bankJournalIn(
        db,
        scene,
        item.amount,
        inbound ? scene.revenue : scene.expense,
        POSTED,
      );
      await clearBankStatementLine(line.uuid, {
        entries: [{ method: 'link_entry', journalId: journal.uuid }],
      });
      return;
    }
    case 'allocate_document': {
      const magnitude = inbound ? item.amount : -item.amount;
      const document = inbound
        ? await invoiceIn(db, scene, magnitude)
        : await billIn(db, scene, magnitude);
      await clearBankStatementLine(line.uuid, {
        entries: [
          {
            method: 'allocate_document',
            targetType: inbound ? 'invoice' : 'bill',
            targetId: document.uuid,
          },
        ],
      });
      return;
    }
  }
}

interface Plan {
  readonly cleared: readonly ClearedItem[];
  /** Bank journals with no clearing — unpresented cheques / deposits in transit. */
  readonly unclearedLedger: readonly bigint[];
  /** Statement lines with no clearing — the statement-side backlog. */
  readonly unclearedLines: readonly bigint[];
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  cleared: fc.array(clearedItemArb, { minLength: 1, maxLength: 3 }),
  unclearedLedger: fc.array(amountArb, { maxLength: 2 }),
  unclearedLines: fc.array(amountArb, { maxLength: 2 }),
});

async function build(scene: Scene, plan: Plan): Promise<void> {
  await runInContext(scene.ctx, async () => {
    for (const item of plan.cleared) await clearOne(scene, item);
    for (const amount of plan.unclearedLedger) {
      await bankJournalIn(db, scene, amount, amount > 0n ? scene.revenue : scene.expense, POSTED);
    }
    for (const amount of plan.unclearedLines) {
      await statementLineIn(db, scene, { amountMinor: amount, postedDate: POSTED });
    }
  });
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function sumItems(items: readonly { readonly amount: string }[]): bigint {
  return items.reduce((total, item) => total + BigInt(item.amount), 0n);
}

// ---------------------------------------------------------------------------
// The two independent recomputations, straight from the tables (X, Y)
// ---------------------------------------------------------------------------

/** X: Σ of the stored `cleared_amount_minor` for the clearings this session counts. */
async function storedClearedSum(app: Kysely<DB>, sessionId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ s: string }>`
    SELECT COALESCE(SUM(cleared_amount_minor), 0) AS s
    FROM bank_line_clearings
    WHERE reconciliation_session_id = ${sessionId}
  `.execute(app);
  return BigInt(rows[0]?.s ?? '0');
}

/**
 * Y: the bank ledger account's *cleared portion*, computed from the ledger alone —
 * `Σ(debit − credit)` over the journal lines on the bank account whose journal a counted
 * clearing cleared. Independent of `cleared_amount_minor`: it never reads the subledger's
 * stored figure, only the journals it points at. W==Y is the agreement OB-071 asserts.
 */
async function ledgerClearedPortion(
  app: Kysely<DB>,
  bankLedgerAccountId: Buffer,
  sessionId: Buffer,
): Promise<bigint> {
  // D-105: `cleared_journal_id` moved off `bank_line_clearings` onto its child
  // `bank_line_clearing_entries`, so the join to a counted journal now goes through it.
  const { rows } = await sql<{ d: string; c: string }>`
    SELECT COALESCE(SUM(jl.debit_minor), 0) AS d, COALESCE(SUM(jl.credit_minor), 0) AS c
    FROM journal_lines jl
    JOIN bank_line_clearing_entries blce ON blce.cleared_journal_id = jl.journal_id
    JOIN bank_line_clearings blc ON blc.id = blce.clearing_id
    WHERE jl.account_id = ${bankLedgerAccountId}
      AND blc.reconciliation_session_id = ${sessionId}
  `.execute(app);
  return BigInt(rows[0]?.d ?? '0') - BigInt(rows[0]?.c ?? '0');
}

// ---------------------------------------------------------------------------
// 1. The subledger agrees with the ledger — the centre
// ---------------------------------------------------------------------------

describe('the banking subledger agrees with the ledger (the OB-071 analog)', () => {
  it('the cleared balance is one number computed four ways, always equal', async () => {
    let ledgerReconcilingSeen = 0;
    const methodsSeen = { post_entry: 0, link_entry: 0, allocate_document: 0 };

    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const scene = await sceneIn(db);
        await build(scene, plan);

        const expectedCleared = sum(plan.cleared.map((item) => item.amount));

        const session = await runInContext(scene.ctx, () =>
          createReconciliationSession({
            bankAccountId: scene.bankAccountUuid,
            endDate: END,
            // Open against the cleared balance so it also finalises (D-50): the uncleared
            // ledger entries and statement lines are reconciling, and do not block.
            statementClosingBalance: expectedCleared.toString(),
          }),
        );

        // --- Open: the session's figure is the generator's, and the report ties out. ---
        const open = await runInContext(scene.ctx, () => getReconciliationReport(session.id));
        expectCents(
          open.balances.clearedBalance,
          open.balances.bookBalance,
          open.balances.unclearedAmount,
        );
        expect(open.balances.clearedBalance).toBe(expectedCleared.toString());
        // clearedBalance + Σ reconcilingItems === bookBalance, the report's own identity.
        expect(BigInt(open.balances.clearedBalance) + sumItems(open.reconcilingItems)).toBe(
          BigInt(open.balances.bookBalance),
        );

        // --- Finalise: membership frozen by the stamp (D-51). Now the four ways. ---
        const finalised = await runInContext(scene.ctx, () =>
          finaliseReconciliationSession(session.id),
        );
        expect(finalised.balances.difference).toBe('0');

        const report = await runInContext(scene.ctx, () => getReconciliationReport(session.id));
        const sessionId = uuidToBuffer(session.id);

        const w = BigInt(report.balances.clearedBalance); // the session
        const x = await storedClearedSum(db.app, sessionId); // the subledger's stored figure
        const y = await ledgerClearedPortion(db.app, scene.bankLedger.id, sessionId); // the ledger
        const z = BigInt(report.balances.bookBalance) - sumItems(report.reconcilingItems); // report

        expect(w).toBe(expectedCleared);
        expect(x).toBe(w);
        expect(y).toBe(w);
        expect(z).toBe(w);

        // Membership counts: one counted clearing per cleared item; one reconciling item
        // per uncleared ledger journal; the statement backlog is exactly the loose lines.
        expect(report.reconcilingItems).toHaveLength(plan.unclearedLedger.length);
        expect(sumItems(report.reconcilingItems)).toBe(sum(plan.unclearedLedger));
        expect(report.unclearedStatementLines).toHaveLength(plan.unclearedLines.length);
        for (const item of report.reconcilingItems) expectCents(item.amount);

        if (plan.unclearedLedger.length > 0) ledgerReconcilingSeen += 1;
        for (const item of plan.cleared) methodsSeen[item.method] += 1;
      }),
      { numRuns: 10 },
    );

    // The generator has to actually reach the shapes the property is about, or it asserts
    // nothing — the coverage discipline `balance-sheet.test.ts` and `report.property` keep.
    expect(ledgerReconcilingSeen).toBeGreaterThan(0);
    expect(methodsSeen.post_entry).toBeGreaterThan(0);
    expect(methodsSeen.link_entry).toBeGreaterThan(0);
    expect(methodsSeen.allocate_document).toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 2. A finalised assertion is reproducible (D-50/D-51)
// ---------------------------------------------------------------------------

describe('a finalised assertion is reproducible under later activity (D-51)', () => {
  it('the stamp freezes cleared balance and membership against clearings entered after', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(clearedItemArb, { minLength: 1, maxLength: 3 }),
        fc.array(clearedItemArb, { minLength: 1, maxLength: 3 }),
        async (before, later) => {
          const scene = await sceneIn(db);
          await runInContext(scene.ctx, async () => {
            for (const item of before) await clearOne(scene, item);
          });

          const expectedCleared = sum(before.map((item) => item.amount));
          const session = await runInContext(scene.ctx, () =>
            createReconciliationSession({
              bankAccountId: scene.bankAccountUuid,
              endDate: END,
              statementClosingBalance: expectedCleared.toString(),
            }),
          );
          await runInContext(scene.ctx, () => finaliseReconciliationSession(session.id));

          const sessionId = uuidToBuffer(session.id);
          const frozen = await runInContext(scene.ctx, () => getReconciliationSession(session.id));
          const frozenLedgerPortion = await ledgerClearedPortion(
            db.app,
            scene.bankLedger.id,
            sessionId,
          );

          // Later activity: more clearings, in the same window, entered *after* the
          // session was finalised. They are unstamped, so the finalised session — which
          // reads its membership from the stamp — cannot see them (D-51).
          await runInContext(scene.ctx, async () => {
            for (const item of later) await clearOne(scene, item);
          });

          const after = await runInContext(scene.ctx, () => getReconciliationSession(session.id));

          // The frozen figures are invariant: same cleared balance, same counted set.
          expect(after.balances.clearedBalance).toBe(frozen.balances.clearedBalance);
          expect(after.balances.clearedBalance).toBe(expectedCleared.toString());
          expect(after.clearedLineCount).toBe(frozen.clearedLineCount);
          expect(after.clearedLineCount).toBe(before.length);
          // And the ledger's view of the counted set has not moved either.
          expect(await ledgerClearedPortion(db.app, scene.bankLedger.id, sessionId)).toBe(
            frozenLedgerPortion,
          );
          expect(frozenLedgerPortion).toBe(expectedCleared);
        },
      ),
      { numRuns: 8 },
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 3. Finalisation is exact (E5) — succeeds iff the balances agree, no rounding
// ---------------------------------------------------------------------------

describe('finalisation is exact (E5)', () => {
  it('succeeds iff clearedBalance === statementClosingBalance, refuses otherwise', async () => {
    let successSeen = 0;
    let mismatchSeen = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.array(clearedItemArb, { minLength: 1, maxLength: 3 }),
        // The offset the operator's stated closing balance is wrong by — zero often, so
        // both branches are exercised. A single minor unit must be enough to refuse.
        fc.oneof({ weight: 2, arbitrary: fc.constant(0n) }, { weight: 3, arbitrary: amountArb }),
        async (cleared, offset) => {
          const scene = await sceneIn(db);
          await runInContext(scene.ctx, async () => {
            for (const item of cleared) await clearOne(scene, item);
          });

          const expectedCleared = sum(cleared.map((item) => item.amount));
          const stated = expectedCleared + offset;

          const session = await runInContext(scene.ctx, () =>
            createReconciliationSession({
              bankAccountId: scene.bankAccountUuid,
              endDate: END,
              statementClosingBalance: stated.toString(),
            }),
          );

          // The open session already exposes the exact gap, in cents.
          const report = await runInContext(scene.ctx, () => getReconciliationReport(session.id));
          expect(report.balances.clearedBalance).toBe(expectedCleared.toString());
          // difference is statement − cleared, so it is the offset exactly.
          expect(report.balances.difference).toBe(offset.toString());
          expectCents(report.balances.difference);

          if (offset === 0n) {
            const finalised = await runInContext(scene.ctx, () =>
              finaliseReconciliationSession(session.id),
            );
            expect(finalised.state).toBe('finalised');
            expect(finalised.balances.difference).toBe('0');
            successSeen += 1;
          } else {
            let thrown: unknown;
            try {
              await runInContext(scene.ctx, () => finaliseReconciliationSession(session.id));
            } catch (error) {
              thrown = error;
            }
            expect(toWireError(thrown)).toMatchObject({
              code: 'precondition_failed',
              details: { precondition: 'reconciliation_session_balance_mismatch' },
            });
            mismatchSeen += 1;
          }
        },
      ),
      { numRuns: 16 },
    );

    expect(successSeen).toBeGreaterThan(0);
    expect(mismatchSeen).toBeGreaterThan(0);
  }, 180_000);
});
