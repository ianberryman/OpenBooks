import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { runInContext } from '../../../context';
import { bufferToUuid } from '../../../db';
import type { DB } from '../../../db/generated';
import { toWireError } from '../../../errors';
import { newUuid, uuidToBuffer } from '../../../../test/db';
import type { TestDatabase } from '../../../../test/db';
import {
  accountBalance,
  allocationsForInvoice,
  billIn,
  clearingOf,
  entriesOf,
  invoiceIn,
  journalCount,
  journalStillExists,
  reversalsOf,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
  type StoredClearingEntry,
} from '../../../../test/banking/clearing-support';
import { outstandingOf } from '../../../../test/payments/support';

import {
  assertClearingBalances,
  clearBankStatementLine,
  removeBankLineClearing,
} from './clearing.service';
import type {
  BankLineClearingEntry,
  ClearBankStatementLineRequest,
  ClearingEntry,
} from '@openbooks/shared-types';

/**
 * The multi-entry clearing property + mutation suite (OB-141; ROADMAP D-80, D-105,
 * D-106; acceptance I2, I3, I7, I8).
 *
 * `clearing.e4.test.ts` proves E4 with every entry kind as the *sole* entry — the
 * shape every pre-D-80 caller used. This file is D-80's own generalisation: an
 * **array** of `post_entry`/`allocate_document` entries, generated rather than
 * enumerated, because a two- or three-entry example suite is exactly the kind of
 * suite CLAUDE.md warns produces "of unknown value" — mutation-tested elsewhere in
 * this codebase, two mutations survived an entire example suite and were caught
 * only by a property that varied the shape the examples never tried.
 *
 * `discount` and the terms-driven suggestion are deliberately absent (OB-136/138,
 * not yet built); this suite is the multi-entry *mechanism*, not the suggestion.
 * `link_entry` is likewise absent — its contribution to Σ is a fact read off an
 * existing journal, not a magnitude a generator constructs, and `clearing.e4.test.ts`
 * already covers it as a sole entry.
 *
 * Real MySQL, a fresh org per run (spec §11) — `useServiceDatabase()`, never a mock.
 */

const db = useServiceDatabase();

function run<T>(scene: Scene, fn: () => Promise<T>): Promise<T> {
  return runInContext(scene.ctx, fn);
}

// ---------------------------------------------------------------------------
// Generating a line-summing set of entries
//
// Rather than fix a line amount and decompose it into N shares (which needs
// division and a remainder correction to land exactly), the parts are generated
// first and the line amount is their sum — Σ(parts) + difference, signed by the
// line's own direction. The equation holds by construction, the same way
// `clearing.service.ts` itself derives `differenceAmount` from what the entries
// already add up to, never the other way round.
// ---------------------------------------------------------------------------

type Kind = 'post_entry' | 'allocate_document';

interface EntryPlan {
  readonly kind: Kind;
  readonly magnitude: bigint;
}

interface Plan {
  readonly lineSign: 1 | -1;
  readonly entries: readonly EntryPlan[];
  readonly differenceMagnitude: bigint;
}

const magnitudeArb: fc.Arbitrary<bigint> = fc.integer({ min: 100, max: 50_000 }).map(BigInt);
const kindArb: fc.Arbitrary<Kind> = fc.constantFrom<Kind>('post_entry', 'allocate_document');
const entryPlanArb: fc.Arbitrary<EntryPlan> = fc.record({ kind: kindArb, magnitude: magnitudeArb });

/** N from 1..5, a mix of `post_entry` and `allocate_document`, in and out. */
const planArb: fc.Arbitrary<Plan> = fc.record({
  lineSign: fc.constantFrom<1 | -1>(1, -1),
  entries: fc.array(entryPlanArb, { minLength: 1, maxLength: 5 }),
  differenceMagnitude: fc.integer({ min: 0, max: 20_000 }).map(BigInt),
});

/** Monotonic, high-range account codes for generated `post_entry` targets (see below). */
let nextGeneratedAccountCode = 900_000;

interface MaterialisedEntry {
  readonly request: ClearingEntry;
  readonly signedAmount: bigint;
  readonly matchAccountId?: string;
  readonly matchTargetId?: string;
  readonly documentKind?: 'invoice' | 'bill';
  readonly documentId?: Buffer;
}

/**
 * Turns one generated `EntryPlan` into a real fixture and the matching request
 * entry: `post_entry` gets a freshly created GL account (so N of them in one clear
 * never collide on the same account, the way split-coding across several accounts
 * — I7 — never would), `allocate_document` gets a document created for exactly its
 * magnitude, so the clear settles it in full.
 */
async function materialiseEntry(
  testDb: TestDatabase,
  scene: Scene,
  lineSign: 1 | -1,
  plan: EntryPlan,
): Promise<MaterialisedEntry> {
  const signedAmount = plan.magnitude * BigInt(lineSign);

  if (plan.kind === 'post_entry') {
    // A code in a high range the scene fixtures never use: the factory's default
    // `1000 + seq` code would, after ~100 accounts across fast-check's samples,
    // collide with a fixed scene account code (uq_accounts_org_code) — a flake that
    // only surfaces deep into a property run.
    const account = await testDb.factories.account({
      orgId: scene.orgId,
      type: 'expense',
      code: String(nextGeneratedAccountCode++),
    });
    return {
      request: { method: 'post_entry', accountId: account.uuid, amount: plan.magnitude.toString() },
      signedAmount,
      matchAccountId: account.uuid,
    };
  }

  const documentKind: 'invoice' | 'bill' = lineSign === 1 ? 'invoice' : 'bill';
  const document =
    documentKind === 'invoice'
      ? await invoiceIn(testDb, scene, plan.magnitude)
      : await billIn(testDb, scene, plan.magnitude);
  return {
    request: {
      method: 'allocate_document',
      targetType: documentKind,
      targetId: document.uuid,
      amount: plan.magnitude.toString(),
    },
    signedAmount,
    matchTargetId: document.uuid,
    documentKind,
    documentId: document.id,
  };
}

/**
 * Finds a materialised entry's own row in the clearing response by its declared
 * account/document — never by array position (`selectEntriesForClearing` orders by
 * `created_at, id`, not request order) and never by amount alone (two entries of
 * equal magnitude would be indistinguishable that way — see the mutation-resistance
 * suite below for why that ambiguity is exactly the case worth generating).
 */
function findResponseEntry(
  entries: readonly BankLineClearingEntry[],
  entry: MaterialisedEntry,
): BankLineClearingEntry {
  const found = entries.find((candidate) =>
    entry.matchAccountId !== undefined
      ? candidate.accountId === entry.matchAccountId
      : candidate.targetId === entry.matchTargetId,
  );
  if (found === undefined) {
    throw new Error('materialised entry missing from the clearing response');
  }
  return found;
}

/** The same lookup against the independently-queried `bank_line_clearing_entries` rows. */
function findStoredEntry(
  rows: readonly StoredClearingEntry[],
  entry: MaterialisedEntry,
): StoredClearingEntry {
  const found = rows.find((row) => {
    if (entry.matchAccountId !== undefined) {
      return row.account_id !== null && bufferToUuid(row.account_id) === entry.matchAccountId;
    }
    return row.target_id !== null && bufferToUuid(row.target_id) === entry.matchTargetId;
  });
  if (found === undefined) {
    throw new Error('materialised entry missing from the stored clearing_entries rows');
  }
  return found;
}

interface BuiltRequest {
  readonly request: ClearBankStatementLineRequest;
  readonly materialised: readonly MaterialisedEntry[];
}

async function buildRequest(testDb: TestDatabase, scene: Scene, plan: Plan): Promise<BuiltRequest> {
  const materialised: MaterialisedEntry[] = [];
  for (const entryPlan of plan.entries) {
    materialised.push(await materialiseEntry(testDb, scene, plan.lineSign, entryPlan));
  }
  return {
    request: {
      entries: materialised.map((entry) => entry.request),
      differenceAccountId: scene.charges.uuid,
    },
    materialised,
  };
}

// ---------------------------------------------------------------------------
// 1. Σ-to-line, generalised (E4 / D-105) — I2
// ---------------------------------------------------------------------------

describe('a multi-entry clear sums to the line on any generated shape (E4, D-105)', () => {
  it('the stored parent + children satisfy Σ(entries) + difference === line.amount', async () => {
    let multiEntrySeen = 0;
    let mixedKindSeen = 0;
    let differenceSeen = 0;

    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const scene = await sceneIn(db);

        const entryMagnitudeSum = plan.entries.reduce(
          (total, entry) => total + entry.magnitude,
          0n,
        );
        const bankMovementTotal = entryMagnitudeSum * BigInt(plan.lineSign);
        const differenceAmount = plan.differenceMagnitude * BigInt(plan.lineSign);
        const lineAmount = bankMovementTotal + differenceAmount;

        // The invariant in isolation, on exactly the inputs the service is about to
        // construct — `clearing.e4.test.ts`'s own discipline, generalised to N.
        expect(() =>
          assertClearingBalances(bankMovementTotal, differenceAmount, lineAmount),
        ).not.toThrow();

        const line = await statementLineIn(db, scene, { amountMinor: lineAmount });
        const { request, materialised } = await buildRequest(db, scene, plan);

        const result = await run(scene, () => clearBankStatementLine(line.uuid, request));

        expect(result.entries).toHaveLength(plan.entries.length);
        expect(BigInt(result.clearedAmount)).toBe(bankMovementTotal);
        expect(BigInt(result.differenceAmount)).toBe(differenceAmount);
        expect(BigInt(result.clearedAmount) + BigInt(result.differenceAmount)).toBe(lineAmount);

        // And the stored row, independently queried — not merely the response echoed
        // back (`clearing.e4.test.ts`'s own phrase for the same discipline).
        const stored = await clearingOf(db.app, line.id);
        expect(stored).toBeDefined();
        expect(stored!.cleared_amount_minor).toBe(bankMovementTotal);
        expect(stored!.difference_amount_minor).toBe(differenceAmount);
        expect(stored!.cleared_amount_minor + stored!.difference_amount_minor).toBe(lineAmount);

        const storedEntries = await entriesOf(db.app, line.id);
        expect(storedEntries).toHaveLength(plan.entries.length);

        for (const entry of materialised) {
          const responseEntry = findResponseEntry(result.entries, entry);
          expect(BigInt(responseEntry.amount)).toBe(entry.signedAmount);

          const storedRow = findStoredEntry(storedEntries, entry);
          expect(storedRow.entry_amount_minor).toBe(entry.signedAmount);
        }

        if (plan.entries.length > 1) multiEntrySeen += 1;
        if (new Set(plan.entries.map((entry) => entry.kind)).size > 1) mixedKindSeen += 1;
        if (differenceAmount !== 0n) differenceSeen += 1;
      }),
      { numRuns: 12 },
    );

    // The generator has to actually reach the shapes the property is about, or it
    // asserts nothing — the coverage discipline `report.property.test.ts` keeps.
    expect(multiEntrySeen).toBeGreaterThan(0);
    expect(mixedKindSeen).toBeGreaterThan(0);
    expect(differenceSeen).toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 2. Lockbox — I3
// ---------------------------------------------------------------------------

async function customerIn(
  testDb: TestDatabase,
  orgId: Buffer,
  displayName: string,
): Promise<{ readonly id: Buffer; readonly uuid: string }> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  await testDb.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: displayName, is_customer: 1, is_vendor: 0 })
    .execute();
  return { id, uuid };
}

let customerInvoiceSequence = 0;

/**
 * An invoice for a *given* customer, unlike `clearing-support.ts`'s own `invoiceIn`
 * which always bills the scene's single shared contact — lockbox needs several
 * distinct customers on one deposit, so this mirrors that helper's AR branch with
 * `contactId` as a parameter instead.
 */
async function invoiceForCustomer(
  testDb: TestDatabase,
  scene: Scene,
  contactId: Buffer,
  amountMinor: bigint,
): Promise<{ readonly id: Buffer; readonly uuid: string }> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  customerInvoiceSequence += 1;

  const journal = await testDb.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: scene.date,
    actorId: scene.userId,
    source: 'invoice',
    lines: [
      { accountId: scene.receivable.id, debitMinor: amountMinor },
      { accountId: scene.revenue.id, creditMinor: amountMinor },
    ],
  });

  await testDb.app
    .insertInto('ar_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: 'invoice',
      sequence_number: BigInt(customerInvoiceSequence),
      contact_id: contactId,
      issue_date: scene.date,
      due_date: scene.date,
      tax_mode: 'exclusive',
      reference: null,
      memo: null,
      journal_id: journal.id,
      void_journal_id: null,
      created_by_user_id: scene.userId,
    })
    .execute();
  await testDb.app
    .insertInto('ar_document_lines')
    .values({
      org_id: scene.orgId,
      document_id: id,
      line_number: 1,
      description: 'invoice line',
      quantity_micros: 1_000_000n,
      unit_amount_minor: amountMinor,
      account_id: scene.revenue.id,
      tax_rate_id: null,
      line_amount_minor: amountMinor,
      tax_amount_minor: 0n,
    })
    .execute();

  return { id, uuid };
}

describe('lockbox (I3): one deposit clears three different customers’ invoices', () => {
  it('settles three customers in one action, each outstanding falling by its entry', async () => {
    const scene = await sceneIn(db);

    const acme = await customerIn(db, scene.orgId, 'Acme Ltd');
    const bright = await customerIn(db, scene.orgId, 'Bright Co');
    const cedar = await customerIn(db, scene.orgId, 'Cedar Inc');

    const invoiceAcme = await invoiceForCustomer(db, scene, acme.id, 10_000n);
    const invoiceBright = await invoiceForCustomer(db, scene, bright.id, 25_000n);
    const invoiceCedar = await invoiceForCustomer(db, scene, cedar.id, 15_000n);

    const deposit = 10_000n + 25_000n + 15_000n;
    const line = await statementLineIn(db, scene, { amountMinor: deposit });

    const result = await run(scene, () =>
      clearBankStatementLine(line.uuid, {
        entries: [
          {
            method: 'allocate_document',
            targetType: 'invoice',
            targetId: invoiceAcme.uuid,
            amount: '10000',
          },
          {
            method: 'allocate_document',
            targetType: 'invoice',
            targetId: invoiceBright.uuid,
            amount: '25000',
          },
          {
            method: 'allocate_document',
            targetType: 'invoice',
            targetId: invoiceCedar.uuid,
            amount: '15000',
          },
        ],
      }),
    );

    expect(result.entries).toHaveLength(3);
    expect(result.clearedAmount).toBe(deposit.toString());
    expect(result.differenceAmount).toBe('0');

    // Every customer's own invoice fell to zero — three settlements, not one payment
    // spread across a total.
    expect(await outstandingOf(db.app, 'invoice', invoiceAcme.id)).toBe(0n);
    expect(await outstandingOf(db.app, 'invoice', invoiceBright.id)).toBe(0n);
    expect(await outstandingOf(db.app, 'invoice', invoiceCedar.id)).toBe(0n);

    // One clearing, balancing to the whole deposit (D-105's parent stays one-per-line).
    const stored = await clearingOf(db.app, line.id);
    expect(stored!.cleared_amount_minor).toBe(deposit);
    expect(stored!.difference_amount_minor).toBe(0n);

    const storedEntries = await entriesOf(db.app, line.id);
    expect(storedEntries).toHaveLength(3);
    expect(storedEntries.every((entry) => entry.entry_type === 'allocate_document')).toBe(true);
    // Three distinct payments recorded — one per customer, not one reused thrice.
    const paymentIds = new Set(storedEntries.map((entry) => entry.payment_id?.toString('hex')));
    expect(paymentIds.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Split-coding subsumed — I7
// ---------------------------------------------------------------------------

describe('split-coding subsumed (I7): one line across several GL accounts', () => {
  it('is the same mechanism: three post_entry entries, three journals, accounts', async () => {
    const scene = await sceneIn(db);
    const cogs = await db.factories.account({ orgId: scene.orgId, type: 'expense' });

    // Outbound: paid out and coded across three cost accounts, exactly OB-094's
    // deferred shape.
    const line = await statementLineIn(db, scene, { amountMinor: -6000n });

    const before = await journalCount(db.app, scene.orgId);
    const result = await run(scene, () =>
      clearBankStatementLine(line.uuid, {
        entries: [
          { method: 'post_entry', accountId: scene.expense.uuid, amount: '2500' },
          { method: 'post_entry', accountId: scene.charges.uuid, amount: '1500' },
          { method: 'post_entry', accountId: cogs.uuid, amount: '2000' },
        ],
      }),
    );

    expect(result.entries).toHaveLength(3);
    expect(result.clearedAmount).toBe('-6000');
    expect(result.differenceAmount).toBe('0');

    // Three separate journals — one per coded account, as `post_entry` always posts.
    expect(await journalCount(db.app, scene.orgId)).toBe(before + 3);
    expect(await accountBalance(db.app, scene.expense.id)).toBe(2500n);
    expect(await accountBalance(db.app, scene.charges.id)).toBe(1500n);
    expect(await accountBalance(db.app, cogs.id)).toBe(2000n);
    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(-6000n);
  });
});

// ---------------------------------------------------------------------------
// 4. Mutation resistance
// ---------------------------------------------------------------------------

describe('assertClearingBalances refuses a broken equation, generalised over N entries', () => {
  it('closes on the constructed inputs and refuses any perturbation of the total', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<1 | -1>(1, -1),
        fc.array(magnitudeArb, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 20_000 }).map(BigInt),
        fc.integer({ min: 1, max: 10_000 }).map(BigInt),
        (lineSign, magnitudes, differenceMagnitude, perturbMagnitude) => {
          const magnitudeSum = magnitudes.reduce((total, m) => total + m, 0n);
          const bankMovementTotal = magnitudeSum * BigInt(lineSign);
          const differenceAmount = differenceMagnitude * BigInt(lineSign);
          const lineAmount = bankMovementTotal + differenceAmount;

          expect(() =>
            assertClearingBalances(bankMovementTotal, differenceAmount, lineAmount),
          ).not.toThrow();

          // Perturbed by a nonzero amount: the equation the service always constructs
          // to close no longer does, and this is the invariant that refuses it rather
          // than writing a clearing that does not add up.
          const brokenLineAmount = lineAmount + perturbMagnitude;
          let thrown: unknown;
          try {
            assertClearingBalances(bankMovementTotal, differenceAmount, brokenLineAmount);
          } catch (error) {
            thrown = error;
          }
          expect(toWireError(thrown)).toMatchObject({
            code: 'precondition_failed',
            details: { precondition: 'clearing_amount_mismatch' },
          });
        },
      ),
      { numRuns: 25 },
    );
  });
});

async function journalLinesOf(
  appDb: Kysely<DB>,
  journalId: Buffer,
): Promise<readonly { account_id: Buffer; debit_minor: bigint; credit_minor: bigint }[]> {
  return appDb
    .selectFrom('journal_lines')
    .select(['account_id', 'debit_minor', 'credit_minor'])
    .where('journal_id', '=', journalId)
    .execute();
}

describe('exact per-entry directions catch a permutation the net would not (CLAUDE.md)', () => {
  it('two equal-amount entries post to their own declared account, never swapped', async () => {
    const scene = await sceneIn(db);
    const accountA = await db.factories.account({ orgId: scene.orgId, type: 'expense' });
    const accountB = await db.factories.account({ orgId: scene.orgId, type: 'expense' });

    // Equal magnitudes, deliberately: CLAUDE.md's reversal-permutation lesson is that
    // a mutation permuting *which* entry attaches to *which* account is invisible to
    // any check that only reads aggregates — the line total and each account's own
    // balance come out identical either way when the two entries share an amount.
    // Only a check tied to one entry's own declared account tells them apart.
    const line = await statementLineIn(db, scene, { amountMinor: 4000n });

    const result = await run(scene, () =>
      clearBankStatementLine(line.uuid, {
        entries: [
          { method: 'post_entry', accountId: accountA.uuid, amount: '2000' },
          { method: 'post_entry', accountId: accountB.uuid, amount: '2000' },
        ],
      }),
    );

    const entryA = result.entries.find((entry) => entry.accountId === accountA.uuid);
    const entryB = result.entries.find((entry) => entry.accountId === accountB.uuid);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();

    // Entry A's own journal carries exactly the bank/coded pair for account A — and
    // never mentions account B, proving the attribution rather than assuming it.
    const linesA = await journalLinesOf(db.app, uuidToBuffer(entryA!.clearedJournalId));
    expect(linesA).toHaveLength(2);
    expect(linesA).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: scene.bankLedger.id,
          debit_minor: 2000n,
          credit_minor: 0n,
        }),
        expect.objectContaining({ account_id: accountA.id, debit_minor: 0n, credit_minor: 2000n }),
      ]),
    );
    expect(linesA.some((lineRow) => lineRow.account_id.equals(accountB.id))).toBe(false);

    const linesB = await journalLinesOf(db.app, uuidToBuffer(entryB!.clearedJournalId));
    expect(linesB).toHaveLength(2);
    expect(linesB).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: scene.bankLedger.id,
          debit_minor: 2000n,
          credit_minor: 0n,
        }),
        expect.objectContaining({ account_id: accountB.id, debit_minor: 0n, credit_minor: 2000n }),
      ]),
    );
    expect(linesB.some((lineRow) => lineRow.account_id.equals(accountA.id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Human-accepted — I8, D-43
// ---------------------------------------------------------------------------

describe('human-accepted (I8, D-43): nothing posts until the explicit accept call', () => {
  it('a fresh statement line carries no clearing and posts no journal on its own', async () => {
    const scene = await sceneIn(db);
    const before = await journalCount(db.app, scene.orgId);
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    // Creating the line is not accepting it. Nothing in the import/match pipeline
    // reaches the ledger except this one accepted keystroke.
    expect(await clearingOf(db.app, line.id)).toBeUndefined();
    expect(await journalCount(db.app, scene.orgId)).toBe(before);

    await run(scene, () =>
      clearBankStatementLine(line.uuid, {
        entries: [{ method: 'post_entry', accountId: scene.revenue.uuid, amount: '5000' }],
      }),
    );

    // Only now, after the explicit call, does the ledger move.
    expect(await clearingOf(db.app, line.id)).toBeDefined();
    expect(await journalCount(db.app, scene.orgId)).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// 6. Undo-as-unit
// ---------------------------------------------------------------------------

describe('undo-as-unit: removeBankLineClearing reverses every entry, restores outstanding', () => {
  it('leaves the ledger and every settled document as they were before the clear', async () => {
    let allocateSeen = 0;
    let postEntrySeen = 0;
    let differenceSeen = 0;

    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const scene = await sceneIn(db);

        const entryMagnitudeSum = plan.entries.reduce(
          (total, entry) => total + entry.magnitude,
          0n,
        );
        const bankMovementTotal = entryMagnitudeSum * BigInt(plan.lineSign);
        const differenceAmount = plan.differenceMagnitude * BigInt(plan.lineSign);
        const lineAmount = bankMovementTotal + differenceAmount;

        const line = await statementLineIn(db, scene, { amountMinor: lineAmount });
        const { request, materialised } = await buildRequest(db, scene, plan);

        const cleared = await run(scene, () => clearBankStatementLine(line.uuid, request));

        const beforeUndo = await clearingOf(db.app, line.id);
        expect(beforeUndo).toBeDefined();
        const differenceJournalId = beforeUndo!.difference_journal_id;

        // Every allocate_document entry actually settled its document, so the
        // restoration checked after undo is proving something real, not a no-op.
        for (const entry of materialised) {
          if (entry.documentKind !== undefined && entry.documentId !== undefined) {
            expect(await outstandingOf(db.app, entry.documentKind, entry.documentId)).toBe(0n);
          }
        }

        await run(scene, () => removeBankLineClearing(line.uuid, { date: scene.date }));

        // The parent and every child are gone, as a unit (D-105's undo unit).
        expect(await clearingOf(db.app, line.id)).toBeUndefined();
        expect(await entriesOf(db.app, line.id)).toHaveLength(0);

        for (const entry of materialised) {
          const responseEntry = findResponseEntry(cleared.entries, entry);
          const journalId = uuidToBuffer(responseEntry.clearedJournalId);

          // Reversed, never deleted (D-16): the original still exists and exactly one
          // reversal points at it.
          expect(await journalStillExists(db.app, journalId)).toBe(true);
          expect(await reversalsOf(db.app, journalId)).toBe(1);

          if (entry.documentKind !== undefined && entry.documentId !== undefined) {
            expect(await outstandingOf(db.app, entry.documentKind, entry.documentId)).toBe(
              entry.signedAmount < 0n ? -entry.signedAmount : entry.signedAmount,
            );
            if (entry.documentKind === 'invoice') {
              expect(await allocationsForInvoice(db.app, entry.documentId)).toBe(0);
            }
            allocateSeen += 1;
          } else {
            postEntrySeen += 1;
          }
        }

        if (differenceJournalId !== null) {
          expect(await reversalsOf(db.app, differenceJournalId)).toBe(1);
          differenceSeen += 1;
        }
      }),
      { numRuns: 10 },
    );

    expect(allocateSeen).toBeGreaterThan(0);
    expect(postEntrySeen).toBeGreaterThan(0);
    expect(differenceSeen).toBeGreaterThan(0);
  }, 180_000);
});
