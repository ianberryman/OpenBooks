import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import type { DB } from '../../src/db/generated';
import { clearBankStatementLine } from '../../src/modules/banking/clearing/clearing.service';
import { approveBill, createBill } from '../../src/modules/bills';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import {
  computePaymentTerm,
  createPaymentTerm,
  suggestDiscount,
} from '../../src/modules/payment-terms';
import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { updateDiscountAccounts } from '../../src/modules/settings';
import { entriesOf } from '../banking/clearing-support';
import type { AccountFixture } from '../db';
import { newUuid, uuidToBuffer } from '../db';
import { outstandingOf } from '../payments/support';
import type { ActorFixture } from './support';
import { actorIn, useServiceDatabase } from './support';

/**
 * The DISCOUNT half of the multi-entry clearing property + mutation suite
 * (OB-141b; ROADMAP D-79, D-106, D-107, D-108; acceptance I4, I6, I8).
 *
 * `clearing.multientry.property.test.ts` (OB-141a) proves the Σ/lockbox/undo
 * mechanics of a multi-entry clear — that suite is deliberately silent on
 * `discount`, which had not landed yet. This file is its other half: the
 * `suggestion.service.ts` arithmetic (OB-138), generalised past
 * `suggestion.service.test.ts`'s worked examples into a property, and the
 * `discount` clearing entry (OB-137/D-80) that a confirmed suggestion becomes,
 * proven with the same mutation-resistant, exact-direction discipline
 * `clearing.multientry.property.test.ts` uses for `post_entry`.
 *
 * Four claims, matching the ticket:
 *
 *  1. `suggestDiscount`'s amount is always exactly `computePaymentTerm`'s own
 *     figure, and it is non-null iff the term is rich *and* the asked-for date
 *     falls on or before the deadline (D-79's "suggested … never auto-posted").
 *  2. A suggested discount, accepted as a `discount` clearing entry alongside
 *     an `allocate_document` entry for the cash, brings the invoice's
 *     `outstanding` to exactly zero — a real journal (debit discount-given,
 *     credit the receivables control; the AP mirror credits discount-received)
 *     and a `discount`-kind allocation, checked by their *exact* debit/credit
 *     sides and accounts rather than by a net balance (CLAUDE.md's reversal-
 *     permutation lesson: a swapped side or a swapped account is invisible to
 *     any check that only reads an aggregate).
 *  3. The discount base is the document's *outstanding*, not its original
 *     total, once something has already been applied (D-79's "2/10" prices
 *     off the face amount only when nothing has touched the document yet).
 *  4. `suggestDiscount` alone posts nothing, ever (D-43, I8) — only the
 *     explicit `discount` clearing entry does.
 *
 * Real MySQL, a fresh org per run (spec §11) — `useServiceDatabase()`, from
 * `test/payment-terms/support.ts`, never a mock. `entriesOf`
 * (`test/banking/clearing-support.ts`) and `outstandingOf`
 * (`test/payments/support.ts`) are reused rather than re-derived, following
 * both files' own "duplicate the fixtures, not the derivation" convention —
 * the bank-account/statement-line scaffolding below is a third, self-
 * contained copy of that convention, because this suite's scene needs both a
 * `payment_terms`/discount-account setup (`test/payment-terms/support.ts`
 * does not have one) and a real bank account to clear against
 * (`test/banking/clearing-support.ts`'s own `Scene` shape does not carry a
 * discount-account nomination).
 */

const db = useServiceDatabase();

function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

// ---------------------------------------------------------------------------
// Scenes: an org with an open period, the AR or AP accounts a term/discount/
// clear needs, and a real bank account to post a statement line against.
// ---------------------------------------------------------------------------

interface ArScene {
  readonly actor: ActorFixture;
  readonly orgId: Buffer;
  readonly income: AccountFixture;
  readonly discountGiven: AccountFixture;
  readonly receivable: AccountFixture;
  readonly bankLedger: AccountFixture;
  readonly bankAccountId: Buffer;
  readonly bankAccountUuid: string;
  readonly importId: Buffer;
  readonly date: string;
}

interface ApScene {
  readonly actor: ActorFixture;
  readonly orgId: Buffer;
  readonly expense: AccountFixture;
  readonly discountReceived: AccountFixture;
  readonly payable: AccountFixture;
  readonly bankLedger: AccountFixture;
  readonly bankAccountId: Buffer;
  readonly bankAccountUuid: string;
  readonly importId: Buffer;
  readonly date: string;
}

interface RegisteredBankAccount {
  readonly bankAccountId: Buffer;
  readonly bankAccountUuid: string;
  readonly importId: Buffer;
}

/** Registers a real `bank_accounts` row plus the `bank_statement_imports` row a line needs. */
async function registerBankAccount(
  orgId: Buffer,
  userId: Buffer,
  bankLedger: AccountFixture,
): Promise<RegisteredBankAccount> {
  const bankAccountUuid = newUuid();
  const bankAccountId = uuidToBuffer(bankAccountUuid);
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: bankAccountId,
      org_id: orgId,
      account_id: bankLedger.id,
      name: 'Current account',
    })
    .execute();

  const importId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: importId,
      org_id: orgId,
      bank_account_id: bankAccountId,
      format: 'csv',
      filename: 'statement.csv',
      file_hash: 'a'.repeat(64),
      status: 'complete',
      lines_read: 0,
      lines_duplicate: 0,
      imported_by_user_id: userId,
    })
    .execute();

  return { bankAccountId, bankAccountUuid, importId };
}

/** Everything an approved invoice, a discount-given nomination and a clear need. */
async function arScene(): Promise<ArScene> {
  const actor = await actorIn(db);
  const period = await db.factories.fiscalPeriod({ orgId: actor.orgId });
  const [receivable, income, discountGiven, bankLedger] = await Promise.all([
    db.factories.account({
      orgId: actor.orgId,
      code: '1100',
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '5000',
      name: 'Sales discounts given',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '1010',
      name: 'Bank',
      type: 'asset',
      normalBalance: 'debit',
    }),
  ]);
  await db.factories.controlAccounts({ orgId: actor.orgId, receivableId: receivable.id });
  await updateDiscountAccounts({ discountGivenAccountId: discountGiven.uuid }, actor.ctx);
  const bankAccount = await registerBankAccount(actor.orgId, actor.userId, bankLedger);

  return {
    actor,
    orgId: actor.orgId,
    receivable,
    income,
    discountGiven,
    bankLedger,
    ...bankAccount,
    date: period.startDate,
  };
}

/** Everything an approved bill, a discount-received nomination and a clear need. */
async function apScene(): Promise<ApScene> {
  const actor = await actorIn(db);
  const period = await db.factories.fiscalPeriod({ orgId: actor.orgId });
  const [payable, expense, discountReceived, bankLedger] = await Promise.all([
    db.factories.account({
      orgId: actor.orgId,
      code: '2010',
      name: 'Accounts payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '6000',
      name: 'Office supplies',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '4500',
      name: 'Purchase discounts received',
      type: 'revenue',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '1010',
      name: 'Bank',
      type: 'asset',
      normalBalance: 'debit',
    }),
  ]);
  await db.factories.controlAccounts({ orgId: actor.orgId, payableId: payable.id });
  await updateDiscountAccounts({ discountReceivedAccountId: discountReceived.uuid }, actor.ctx);
  const bankAccount = await registerBankAccount(actor.orgId, actor.userId, bankLedger);

  return {
    actor,
    orgId: actor.orgId,
    payable,
    expense,
    discountReceived,
    bankLedger,
    ...bankAccount,
    date: period.startDate,
  };
}

async function insertContact(
  orgId: Buffer,
  input: {
    readonly displayName: string;
    readonly isCustomer?: boolean;
    readonly isVendor?: boolean;
    readonly defaultPaymentTermId?: string;
  },
): Promise<string> {
  const uuid = newUuid();
  await db.app
    .insertInto('contacts')
    .values({
      id: uuidToBuffer(uuid),
      org_id: orgId,
      display_name: input.displayName,
      is_customer: input.isCustomer === true ? 1 : 0,
      is_vendor: input.isVendor === true ? 1 : 0,
      default_payment_term_id:
        input.defaultPaymentTermId === undefined ? null : uuidToBuffer(input.defaultPaymentTermId),
    })
    .execute();
  return uuid;
}

let lineCounter = 0;

interface BankScene {
  readonly orgId: Buffer;
  readonly bankAccountId: Buffer;
  readonly importId: Buffer;
  readonly date: string;
}

/** A statement line on one of the scenes above, ready to clear. */
async function statementLineIn(
  scene: BankScene,
  amountMinor: bigint,
): Promise<{ readonly id: Buffer; readonly uuid: string }> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  lineCounter += 1;
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id,
      org_id: scene.orgId,
      bank_account_id: scene.bankAccountId,
      import_id: scene.importId,
      posted_date: scene.date,
      description: `Line ${String(lineCounter)}`,
      amount_minor: amountMinor,
      fingerprint: `f${String(lineCounter).padStart(63, '0')}`,
      occurrence_index: 0,
    })
    .execute();
  return { id, uuid };
}

/** `YYYY-MM-DD` plus `n` calendar days, UTC — mirrors `compute-term.ts`'s own arithmetic. */
function addDays(date: string, n: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + n));
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reading back: journal lines, and the discount-kind allocation D-106 writes.
// ---------------------------------------------------------------------------

interface StoredJournalLine {
  readonly account_id: Buffer;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
}

async function journalLinesOf(
  appDb: Kysely<DB>,
  journalId: Buffer,
): Promise<readonly StoredJournalLine[]> {
  return appDb
    .selectFrom('journal_lines')
    .select(['account_id', 'debit_minor', 'credit_minor'])
    .where('journal_id', '=', journalId)
    .execute();
}

async function journalCount(appDb: Kysely<DB>, orgId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE org_id = ${orgId}
  `.execute(appDb);
  return Number(rows[0]?.count ?? 0);
}

/**
 * The discount-kind allocation `applyAllocations` writes (D-106):
 * `ar_allocations`/`ap_allocations.discount_journal_id`, the third,
 * exclusively-nullable source column `0005_subledger` added for it. Raw SQL
 * with `sql.table`/`sql.ref` for the dynamic table/column, following
 * `test/payments/support.ts`'s own `outstandingOf`.
 */
async function discountAllocationAmount(
  appDb: Kysely<DB>,
  kind: 'invoice' | 'bill',
  documentId: Buffer,
  journalId: Buffer,
): Promise<bigint | undefined> {
  const table = kind === 'invoice' ? 'ar_allocations' : 'ap_allocations';
  const column = kind === 'invoice' ? 'invoice_id' : 'bill_id';
  const { rows } = await sql<{ amount_minor: string }>`
    SELECT amount_minor FROM ${sql.table(table)}
    WHERE ${sql.ref(column)} = ${documentId} AND discount_journal_id = ${journalId}
  `.execute(appDb);
  return rows[0] === undefined ? undefined : BigInt(rows[0].amount_minor);
}

async function allocationCountFor(
  appDb: Kysely<DB>,
  kind: 'invoice' | 'bill',
  documentId: Buffer,
): Promise<number> {
  const table = kind === 'invoice' ? 'ar_allocations' : 'ap_allocations';
  const column = kind === 'invoice' ? 'invoice_id' : 'bill_id';
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE ${sql.ref(column)} = ${documentId}
  `.execute(appDb);
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// 1. The suggestion computes from the term (I4/I6)
// ---------------------------------------------------------------------------

interface TermPlan {
  readonly netDays: number;
  readonly hasDiscount: boolean;
  readonly discountRatePpm: number;
  readonly discountWindowDays: number;
  readonly documentTotalMinor: bigint;
  readonly asOfOffsetDays: number;
}

const termPlanArb: fc.Arbitrary<TermPlan> = fc.record({
  netDays: fc.integer({ min: 0, max: 90 }),
  hasDiscount: fc.boolean(),
  // 0.1%..50% — wide enough to catch a rounding regression, never so extreme
  // the arithmetic itself is in question (that is `compute-term.test.ts`'s job).
  discountRatePpm: fc.integer({ min: 1_000, max: 500_000 }),
  discountWindowDays: fc.integer({ min: 0, max: 45 }),
  documentTotalMinor: fc.integer({ min: 100, max: 500_000 }).map(BigInt),
  asOfOffsetDays: fc.integer({ min: -5, max: 80 }),
});

describe('suggestDiscount computes from the term (I4/I6)', () => {
  it('matches computePaymentTerm exactly, non-null iff rich and in-window', async () => {
    let simpleSeen = 0;
    let inWindowSeen = 0;
    let outOfWindowSeen = 0;

    await fc.assert(
      fc.asyncProperty(termPlanArb, async (plan) => {
        const s = await arScene();
        const term = await createPaymentTerm(
          plan.hasDiscount
            ? {
                name: `Term ${newUuid()}`,
                netDays: plan.netDays,
                discountRatePpm: plan.discountRatePpm,
                discountWindowDays: plan.discountWindowDays,
              }
            : { name: `Term ${newUuid()}`, netDays: plan.netDays },
          s.actor.ctx,
        );
        const contactId = await insertContact(s.actor.orgId, {
          displayName: 'Acme Ltd',
          isCustomer: true,
          defaultPaymentTermId: term.id,
        });

        const invoice = await withContext(s.actor.ctx, () =>
          createInvoice(
            {
              contactId,
              issueDate: s.date,
              taxMode: 'exclusive',
              lines: [
                {
                  description: 'Consulting',
                  quantity: '1',
                  unitAmount: plan.documentTotalMinor.toString(),
                  accountId: s.income.uuid,
                },
              ],
            },
            s.actor.ctx,
          ),
        );
        await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

        const asOfDate = addDays(s.date, plan.asOfOffsetDays);
        const suggestion = await suggestDiscount(s.actor.ctx, {
          targetType: 'invoice',
          targetId: invoice.id,
          asOfDate,
        });
        const expected = computePaymentTerm(term, s.date, plan.documentTotalMinor.toString());

        if (!plan.hasDiscount) {
          // A simple term never has a discount to compute, on any date.
          expect(expected.discountAmountMinor).toBeNull();
          expect(suggestion).toBeNull();
          simpleSeen += 1;
          return;
        }

        expect(expected.discountAmountMinor).not.toBeNull();
        expect(expected.discountDeadline).not.toBeNull();
        const inWindow = asOfDate <= (expected.discountDeadline as string);

        if (inWindow) {
          inWindowSeen += 1;
          expect(suggestion).not.toBeNull();
          // The one figure `computePaymentTerm` produces — this file re-derives
          // nothing.
          expect(suggestion?.discountAmountMinor).toBe(expected.discountAmountMinor);
          expect(suggestion?.deadline).toBe(expected.discountDeadline);
          expect(suggestion?.accountId).toBe(s.discountGiven.uuid);
        } else {
          outOfWindowSeen += 1;
          expect(suggestion).toBeNull();
        }
      }),
      { numRuns: 20 },
    );

    // The generator has to actually reach every branch the property is about,
    // matching `clearing.multientry.property.test.ts`'s own coverage discipline.
    expect(simpleSeen).toBeGreaterThan(0);
    expect(inWindowSeen).toBeGreaterThan(0);
    expect(outOfWindowSeen).toBeGreaterThan(0);
  }, 180_000);
});

describe('the discount window boundary is inclusive (mutation trap on `>` vs `>=`)', () => {
  it('suggests on the deadline itself and refuses the very next day', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: `Term ${newUuid()}`, netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      s.actor.ctx,
    );
    const contactId = await insertContact(s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'Line', quantity: '1', unitAmount: '100000', accountId: s.income.uuid },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const deadline = computePaymentTerm(term, s.date, '100000').discountDeadline;
    if (deadline === null) throw new Error('a 2/10 term always computes a deadline');

    const onDeadline = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: deadline,
    });
    expect(onDeadline).not.toBeNull();

    const afterDeadline = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: addDays(deadline, 1),
    });
    expect(afterDeadline).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The discount base is outstanding, not the original total, once partially
//    settled — the base rule `suggestion.service.ts` itself states.
// ---------------------------------------------------------------------------

interface PartialPlan {
  readonly documentTotalMinor: bigint;
  readonly discountRatePpm: number;
  /** Paid = total * paidTenths / 10 — in (0, total) given `documentTotalMinor >= 1_000`. */
  readonly paidTenths: number;
}

const partialPlanArb: fc.Arbitrary<PartialPlan> = fc.record({
  documentTotalMinor: fc.integer({ min: 1_000, max: 500_000 }).map(BigInt),
  discountRatePpm: fc.integer({ min: 10_000, max: 300_000 }),
  paidTenths: fc.integer({ min: 1, max: 9 }),
});

describe('the discount base is the outstanding amount once something is applied (D-79)', () => {
  it('prices the discount off what remains, across generated partial payments', async () => {
    await fc.assert(
      fc.asyncProperty(partialPlanArb, async (plan) => {
        const s = await arScene();
        const term = await createPaymentTerm(
          {
            name: `Term ${newUuid()}`,
            netDays: 30,
            discountRatePpm: plan.discountRatePpm,
            discountWindowDays: 30,
          },
          s.actor.ctx,
        );
        const contactId = await insertContact(s.actor.orgId, {
          displayName: 'Acme Ltd',
          isCustomer: true,
          defaultPaymentTermId: term.id,
        });

        const invoice = await withContext(s.actor.ctx, () =>
          createInvoice(
            {
              contactId,
              issueDate: s.date,
              taxMode: 'exclusive',
              lines: [
                {
                  description: 'Line',
                  quantity: '1',
                  unitAmount: plan.documentTotalMinor.toString(),
                  accountId: s.income.uuid,
                },
              ],
            },
            s.actor.ctx,
          ),
        );
        await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

        const paidAmount = (plan.documentTotalMinor * BigInt(plan.paidTenths)) / 10n;
        // Guaranteed 0 < paidAmount < documentTotalMinor by construction: total >=
        // 1_000 and paidTenths in [1, 9].
        const payment = await withContext(s.actor.ctx, () =>
          recordPayment(
            {
              direction: 'received',
              contactId,
              date: s.date,
              amount: paidAmount.toString(),
              accountId: s.bankLedger.uuid,
            },
            s.actor.ctx,
          ),
        );
        await withContext(s.actor.ctx, () =>
          allocatePayment(
            payment.id,
            {
              allocations: [
                { targetType: 'invoice', targetId: invoice.id, amount: paidAmount.toString() },
              ],
            },
            s.actor.ctx,
          ),
        );

        const outstanding = plan.documentTotalMinor - paidAmount;
        const suggestion = await suggestDiscount(s.actor.ctx, {
          targetType: 'invoice',
          targetId: invoice.id,
          asOfDate: s.date,
        });
        const expectedOnOutstanding = computePaymentTerm(term, s.date, outstanding.toString());

        expect(suggestion?.discountAmountMinor).toBe(expectedOnOutstanding.discountAmountMinor);

        // Mutation trap: the pre-D-79 bug this rule guards against — pricing off
        // the original total instead of what remains. Only asserted when the two
        // bases actually diverge (they always do here: rate >= 1%, outstanding
        // strictly less than total), so this never passes by coincidence.
        const expectedOnTotal = computePaymentTerm(
          term,
          s.date,
          plan.documentTotalMinor.toString(),
        );
        expect(expectedOnTotal.discountAmountMinor).not.toBe(
          expectedOnOutstanding.discountAmountMinor,
        );
        expect(suggestion?.discountAmountMinor).not.toBe(expectedOnTotal.discountAmountMinor);
      }),
      { numRuns: 10 },
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. Never auto-posted (I8, D-43)
// ---------------------------------------------------------------------------

describe('never auto-posted (I8, D-43): suggestDiscount alone posts nothing', () => {
  it('a suggestion — even a repeated one — changes no row', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: `Term ${newUuid()}`, netDays: 30, discountRatePpm: 20_000, discountWindowDays: 30 },
      s.actor.ctx,
    );
    const contactId = await insertContact(s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'Line', quantity: '1', unitAmount: '100000', accountId: s.income.uuid },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const before = await journalCount(db.app, s.actor.orgId);

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });
    expect(suggestion).not.toBeNull();

    // Calling it again is still just a read.
    await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });

    expect(await journalCount(db.app, s.actor.orgId)).toBe(before);
    expect(await outstandingOf(db.app, 'invoice', uuidToBuffer(invoice.id))).toBe(100_000n);
    expect(await allocationCountFor(db.app, 'invoice', uuidToBuffer(invoice.id))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Accepting a suggested discount settles the invoice exactly (D-106)
// ---------------------------------------------------------------------------

interface PostingPlan {
  readonly documentTotalMinor: bigint;
  readonly discountRatePpm: number;
}

const postingPlanArb: fc.Arbitrary<PostingPlan> = fc.record({
  documentTotalMinor: fc.integer({ min: 1_000, max: 200_000 }).map(BigInt),
  // 1%..30% — always leaves a strictly positive cash portion.
  discountRatePpm: fc.integer({ min: 10_000, max: 300_000 }),
});

describe('a confirmed discount settles the invoice exactly (D-106)', () => {
  it('brings outstanding to zero and posts debit discount-given / credit AR control', async () => {
    await fc.assert(
      fc.asyncProperty(postingPlanArb, async (plan) => {
        const s = await arScene();
        const term = await createPaymentTerm(
          {
            name: `Term ${newUuid()}`,
            netDays: 30,
            discountRatePpm: plan.discountRatePpm,
            discountWindowDays: 30,
          },
          s.actor.ctx,
        );
        const contactId = await insertContact(s.actor.orgId, {
          displayName: 'Acme Ltd',
          isCustomer: true,
          defaultPaymentTermId: term.id,
        });

        const invoice = await withContext(s.actor.ctx, () =>
          createInvoice(
            {
              contactId,
              issueDate: s.date,
              taxMode: 'exclusive',
              lines: [
                {
                  description: 'Line',
                  quantity: '1',
                  unitAmount: plan.documentTotalMinor.toString(),
                  accountId: s.income.uuid,
                },
              ],
            },
            s.actor.ctx,
          ),
        );
        await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

        const suggestion = await suggestDiscount(s.actor.ctx, {
          targetType: 'invoice',
          targetId: invoice.id,
          asOfDate: s.date,
        });
        if (suggestion === null) {
          throw new Error('a fresh, in-window, rich term always suggests a discount here');
        }
        const discountAmount = BigInt(suggestion.discountAmountMinor);
        const cashAmount = plan.documentTotalMinor - discountAmount;
        expect(cashAmount).toBeGreaterThan(0n);

        const line = await statementLineIn(s, cashAmount);
        const result = await withContext(s.actor.ctx, () =>
          clearBankStatementLine(line.uuid, {
            entries: [
              {
                method: 'allocate_document',
                targetType: 'invoice',
                targetId: invoice.id,
                amount: cashAmount.toString(),
              },
              {
                method: 'discount',
                accountId: suggestion.accountId,
                targetType: 'invoice',
                targetId: invoice.id,
                amount: discountAmount.toString(),
              },
            ],
          }),
        );

        // I8/D-43's own equation, generalised for `discount`: the non-discount
        // entries alone sum to the line (the discount is funded off-line, D-106).
        expect(BigInt(result.clearedAmount)).toBe(cashAmount);
        expect(BigInt(result.differenceAmount)).toBe(0n);

        expect(await outstandingOf(db.app, 'invoice', uuidToBuffer(invoice.id))).toBe(0n);

        const discountEntry = result.entries.find((entry) => entry.entryType === 'discount');
        expect(discountEntry).toBeDefined();
        const discountJournalId = uuidToBuffer(discountEntry!.clearedJournalId);

        // Exact debit/credit sides and accounts — not a net balance, which a
        // swapped side or a swapped account would still satisfy (CLAUDE.md).
        const lines = await journalLinesOf(db.app, discountJournalId);
        expect(lines).toHaveLength(2);
        expect(lines).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              account_id: s.discountGiven.id,
              debit_minor: discountAmount,
              credit_minor: 0n,
            }),
            expect.objectContaining({
              account_id: s.receivable.id,
              debit_minor: 0n,
              credit_minor: discountAmount,
            }),
          ]),
        );
        expect(
          lines.some((row) => row.account_id.equals(s.receivable.id) && row.debit_minor > 0n),
        ).toBe(false);
        expect(
          lines.some((row) => row.account_id.equals(s.discountGiven.id) && row.credit_minor > 0n),
        ).toBe(false);

        // The discount-kind allocation D-106 requires: outstanding = total −
        // Σallocations only reaches zero because this row exists.
        const allocated = await discountAllocationAmount(
          db.app,
          'invoice',
          uuidToBuffer(invoice.id),
          discountJournalId,
        );
        expect(allocated).toBe(discountAmount);

        // The stored entry, independently queried — not merely the response
        // echoed back (`clearing.multientry.property.test.ts`'s own discipline).
        const stored = await entriesOf(db.app, line.id);
        const storedDiscount = stored.find((entry) => entry.entry_type === 'discount');
        expect(storedDiscount).toBeDefined();
        expect(storedDiscount!.entry_amount_minor).toBe(discountAmount);
        expect(storedDiscount!.account_id?.equals(s.discountGiven.id)).toBe(true);
        expect(storedDiscount!.target_id?.equals(uuidToBuffer(invoice.id))).toBe(true);
      }),
      { numRuns: 10 },
    );
  }, 150_000);
});

describe('exact discount attribution catches a swapped account (CLAUDE.md)', () => {
  it('two discount entries of equal magnitude never swap their declared account', async () => {
    const s = await arScene();
    // An explicit code outside the scene's own fixed range (1010/1100/4000/5000):
    // the account-code sequence is a single global counter shared by every
    // fixture in the file (`test/db/factories.ts`), so an omitted code risks
    // eventually colliding with one of those fixed codes in a fresh org, the way
    // `clearing.multientry.property.test.ts` found the hard way.
    const altDiscountAccount = await db.factories.account({
      orgId: s.actor.orgId,
      type: 'expense',
      code: '5100',
    });

    const term = await createPaymentTerm(
      { name: `Term ${newUuid()}`, netDays: 30, discountRatePpm: 20_000, discountWindowDays: 30 },
      s.actor.ctx,
    );
    const contactA = await insertContact(s.actor.orgId, {
      displayName: 'A Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    const contactB = await insertContact(s.actor.orgId, {
      displayName: 'B Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });

    const invoiceA = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId: contactA,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'A', quantity: '1', unitAmount: '100000', accountId: s.income.uuid },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoiceA.id, s.actor.ctx));
    const invoiceB = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId: contactB,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'B', quantity: '1', unitAmount: '100000', accountId: s.income.uuid },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoiceB.id, s.actor.ctx));

    // 2% of 100000 = 2000 on each — deliberately equal magnitudes: a mutation
    // permuting which entry's discount attaches to which account is invisible
    // to any check that only reads the line's total or either account's net
    // balance, since both come out identical either way.
    const line = await statementLineIn(s, 196_000n);

    const result = await withContext(s.actor.ctx, () =>
      clearBankStatementLine(line.uuid, {
        entries: [
          {
            method: 'allocate_document',
            targetType: 'invoice',
            targetId: invoiceA.id,
            amount: '98000',
          },
          {
            method: 'discount',
            accountId: s.discountGiven.uuid,
            targetType: 'invoice',
            targetId: invoiceA.id,
            amount: '2000',
          },
          {
            method: 'allocate_document',
            targetType: 'invoice',
            targetId: invoiceB.id,
            amount: '98000',
          },
          {
            method: 'discount',
            accountId: altDiscountAccount.uuid,
            targetType: 'invoice',
            targetId: invoiceB.id,
            amount: '2000',
          },
        ],
      }),
    );

    const discountEntries = result.entries.filter((entry) => entry.entryType === 'discount');
    expect(discountEntries).toHaveLength(2);
    const entryA = discountEntries.find((entry) => entry.accountId === s.discountGiven.uuid);
    const entryB = discountEntries.find((entry) => entry.accountId === altDiscountAccount.uuid);
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();

    const linesA = await journalLinesOf(db.app, uuidToBuffer(entryA!.clearedJournalId));
    expect(linesA).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: s.discountGiven.id,
          debit_minor: 2000n,
          credit_minor: 0n,
        }),
        expect.objectContaining({
          account_id: s.receivable.id,
          debit_minor: 0n,
          credit_minor: 2000n,
        }),
      ]),
    );
    expect(linesA.some((row) => row.account_id.equals(altDiscountAccount.id))).toBe(false);

    const linesB = await journalLinesOf(db.app, uuidToBuffer(entryB!.clearedJournalId));
    expect(linesB).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: altDiscountAccount.id,
          debit_minor: 2000n,
          credit_minor: 0n,
        }),
        expect.objectContaining({
          account_id: s.receivable.id,
          debit_minor: 0n,
          credit_minor: 2000n,
        }),
      ]),
    );
    expect(linesB.some((row) => row.account_id.equals(s.discountGiven.id))).toBe(false);

    expect(await outstandingOf(db.app, 'invoice', uuidToBuffer(invoiceA.id))).toBe(0n);
    expect(await outstandingOf(db.app, 'invoice', uuidToBuffer(invoiceB.id))).toBe(0n);
  });
});

describe('the AP mirror posts the opposite sides (D-106, D-108)', () => {
  it('debits the payables control and credits the discount-received account', async () => {
    const s = await apScene();
    const term = await createPaymentTerm(
      { name: `Term ${newUuid()}`, netDays: 30, discountRatePpm: 20_000, discountWindowDays: 30 },
      s.actor.ctx,
    );
    const vendorId = await insertContact(s.actor.orgId, {
      displayName: 'Supplier Co',
      isVendor: true,
      defaultPaymentTermId: term.id,
    });

    const bill = await withContext(s.actor.ctx, () =>
      createBill(
        {
          contactId: vendorId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'Paper', quantity: '1', unitAmount: '50000', accountId: s.expense.uuid },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveBill(bill.id, s.actor.ctx));

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'bill',
      targetId: bill.id,
      asOfDate: s.date,
    });
    expect(suggestion).not.toBeNull();
    const discountAmount = BigInt(suggestion!.discountAmountMinor);
    expect(discountAmount).toBe(1000n);
    const cashAmount = 50_000n - discountAmount;

    // Outbound: the line is negative, mirroring `paymentDirectionFor`'s 'made'.
    const line = await statementLineIn(s, -cashAmount);
    const result = await withContext(s.actor.ctx, () =>
      clearBankStatementLine(line.uuid, {
        entries: [
          {
            method: 'allocate_document',
            targetType: 'bill',
            targetId: bill.id,
            amount: cashAmount.toString(),
          },
          {
            method: 'discount',
            accountId: suggestion!.accountId,
            targetType: 'bill',
            targetId: bill.id,
            amount: discountAmount.toString(),
          },
        ],
      }),
    );

    expect(await outstandingOf(db.app, 'bill', uuidToBuffer(bill.id))).toBe(0n);

    const discountEntry = result.entries.find((entry) => entry.entryType === 'discount');
    expect(discountEntry).toBeDefined();
    const discountJournalId = uuidToBuffer(discountEntry!.clearedJournalId);

    const lines = await journalLinesOf(db.app, discountJournalId);
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: s.payable.id,
          debit_minor: discountAmount,
          credit_minor: 0n,
        }),
        expect.objectContaining({
          account_id: s.discountReceived.id,
          debit_minor: 0n,
          credit_minor: discountAmount,
        }),
      ]),
    );
    expect(
      lines.some((row) => row.account_id.equals(s.discountReceived.id) && row.debit_minor > 0n),
    ).toBe(false);
    expect(
      lines.some((row) => row.account_id.equals(s.payable.id) && row.credit_minor > 0n),
    ).toBe(false);

    const allocated = await discountAllocationAmount(
      db.app,
      'bill',
      uuidToBuffer(bill.id),
      discountJournalId,
    );
    expect(allocated).toBe(discountAmount);

    // Signed in the line's frame (negative, since the line itself is outbound) —
    // `bankLineClearingEntrySchema`'s own convention for every entry type.
    const stored = await entriesOf(db.app, line.id);
    const storedDiscount = stored.find((entry) => entry.entry_type === 'discount');
    expect(storedDiscount!.entry_amount_minor).toBe(-discountAmount);
  });
});
