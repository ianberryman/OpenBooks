import type { AgingLedger } from '@openbooks/shared-types';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { createAccount } from '../../src/modules/accounts';
import { createContact } from '../../src/modules/contacts';
import type { SubledgerSide } from '../../src/modules/settings';
import { getAccountBalances } from '../../src/modules/reports';
import { getAging } from '../../src/modules/reports/aging.service';
import { createTaxRate } from '../../src/modules/tax';
import { SYSTEM_ROLE_UUIDS, useTestDatabase, type TestDatabase } from '../db';

/**
 * The scene the OB-071 properties are asserted over (spec §11; M3 C2–C9).
 *
 * ## Why every fixture here goes through a service
 *
 * `test/reports/aging.test.ts` and `test/payments/support.ts` both insert their
 * documents directly, and both say why: OB-062, OB-063, OB-064 and OB-065 were
 * being written in the same wave, so a fixture that imported them would have made
 * each suite a test of somebody else's service. That reason expired when wave 1
 * landed, and for this ticket it inverts.
 *
 * C2 is the claim that the subledger and the ledger agree. A fixture that inserted
 * `ar_documents` rows beside hand-posted journals would be asserting that *the
 * fixture* kept them in step — the two sides would agree because one file wrote
 * both, and the property would survive any defect in `approveArDocument`'s posting.
 * So nothing below writes a subledger table or a journal: documents are created and
 * approved, payments recorded, allocations applied, and voids taken through the
 * real services, and the only rows in the database are the ones those services
 * produced.
 *
 * ## The chart, and why it has two of several things
 *
 * Two income and two expense accounts, and two tax rates per side, so a document
 * can spread its lines across accounts and rates. A single-account document makes
 * a posting that credited the wrong account indistinguishable from a correct one
 * whenever the control-account line is the only one checked — which is exactly what
 * C2 checks.
 *
 * The tax accounts are separate from the income accounts for the same reason, and
 * separate from each other because sales tax collected and purchase tax reclaimable
 * are different balances (D-35). Neither is a control account, so tax landing in
 * the receivable account by mistake is a failure C2 can see.
 *
 * ## The fiscal year never starts in January
 *
 * `createSubledgerScene` takes a start month and the generator never offers 1.
 * Aging and `getAccountBalances` do not read it, so on their own properties it is
 * inert — but C6 reads the balance sheet, whose two derived equity lines are scoped
 * to the fiscal year containing the report date (D-20), and a credit note that
 * nets an invoice to zero must net it to zero there too. Under a January start a
 * wrong fiscal-year resolution is invisible, which is `balance-sheet-support.ts`'s
 * argument arriving in a different suite.
 */
export function useSubledgerDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

/**
 * Runs `body` inside the context scope.
 *
 * Not optional for anything that approves or records: `assertPostable`, reached
 * through `postJournal`, takes no context and reads the ambient one, because spec
 * §4 forbids threading `orgId` through signatures.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

/**
 * The calendar years every generated date falls in.
 *
 * Three, and the reason is the aging buckets rather than the reports: the oldest
 * bucket is "more than 90 days past due", so a plan whose documents and whose `asOf`
 * all sat inside one year could still reach it, but a void or an allocation dated
 * after the report date — the as-at cases D-40 is about — needs room on the far
 * side. Periods are opened over calendar years even where the fiscal year is not
 * one, for `balance-sheet-support.ts`'s reason: a period exists to make a date
 * postable (A4), and nothing in these reports reads `fiscal_periods` at all.
 */
export const CALENDAR_YEARS = [2025, 2026, 2027] as const;

/** Every generated offset is measured in days from here. */
export const EPOCH = '2026-01-05';

export interface SceneAccounts {
  readonly bank: string;
  readonly receivable: string;
  readonly payable: string;
  readonly income: string;
  readonly secondIncome: string;
  readonly expense: string;
  readonly secondExpense: string;
  readonly salesTax: string;
  readonly purchaseTax: string;
}

export interface SubledgerScene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly startMonth: number;
  readonly accounts: SceneAccounts;
  /** Sales rates first, then purchase rates. Indexed by the generator. */
  readonly rates: readonly string[];
  readonly contacts: readonly string[];
}

export interface SceneOptions {
  /** 1–12. The generator never offers 1 — see the file header. */
  readonly startMonth: number;
  readonly contacts: number;
}

/**
 * Percentages chosen so that both roundings D-35 names actually happen.
 *
 * `20` divides most cents evenly and is the boring case; `8.875` is the rate
 * `taxPercentageSchema` cites as the one basis points cannot express, and at three
 * fraction digits almost every line it touches rounds. A rate list that only held
 * round percentages would let a tax computed from an unrounded product pass, which
 * is one of the two mutations this project has already been caught by.
 */
const SALES_PERCENTAGES = ['20', '8.875'] as const;
const PURCHASE_PERCENTAGES = ['5', '17.5'] as const;

export async function createSubledgerScene(
  db: TestDatabase,
  options: SceneOptions,
): Promise<SubledgerScene> {
  const org = await db.factories.org();

  // Through the migrator handle because the org factory has no override for the
  // column, and this suite must not widen a shared fixture that four other suites
  // build on.
  await db.migrator
    .updateTable('orgs')
    .set({ fiscal_year_start_month: options.startMonth })
    .where('id', '=', org.id)
    .execute();

  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id });

  for (const year of CALENDAR_YEARS) {
    await db.factories.fiscalPeriod({
      orgId: org.id,
      name: `Year ${String(year)}`,
      startDate: `${String(year)}-01-01`,
      endDate: `${String(year)}-12-31`,
    });
  }

  const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);

  const accounts = await withContext(ctx, async () => ({
    bank: await accountIn(ctx, '1000', 'asset', 'debit'),
    receivable: await accountIn(ctx, '1100', 'asset', 'debit'),
    payable: await accountIn(ctx, '2000', 'liability', 'credit'),
    salesTax: await accountIn(ctx, '2100', 'liability', 'credit'),
    purchaseTax: await accountIn(ctx, '1300', 'asset', 'debit'),
    income: await accountIn(ctx, '4000', 'revenue', 'credit'),
    secondIncome: await accountIn(ctx, '4100', 'revenue', 'credit'),
    expense: await accountIn(ctx, '5000', 'expense', 'debit'),
    secondExpense: await accountIn(ctx, '5100', 'expense', 'debit'),
  }));

  // Nominated rather than found by code: since OB-066a nothing resolves a control
  // account from the chart's numbering, and the nomination is what makes these two
  // accounts the ones C2 is about.
  await db.factories.controlAccounts({
    orgId: org.id,
    receivableId: await idBytes(db, org.id, '1100'),
    payableId: await idBytes(db, org.id, '2000'),
  });

  const rates = await withContext(ctx, async () => {
    const created: string[] = [];
    for (const [index, percentage] of SALES_PERCENTAGES.entries()) {
      const rate = await createTaxRate(
        {
          name: `Sales ${percentage}% (${String(index)})`,
          percentage,
          accountId: accounts.salesTax,
          appliesTo: 'sales',
        },
        ctx,
      );
      created.push(rate.id);
    }
    for (const [index, percentage] of PURCHASE_PERCENTAGES.entries()) {
      const rate = await createTaxRate(
        {
          name: `Purchase ${percentage}% (${String(index)})`,
          percentage,
          accountId: accounts.purchaseTax,
          appliesTo: 'purchases',
        },
        ctx,
      );
      created.push(rate.id);
    }
    return created;
  });

  const contacts = await withContext(ctx, async () => {
    const created: string[] = [];
    for (let index = 0; index < options.contacts; index += 1) {
      const contact = await createContact(
        {
          // Both flags, so one contact can hold an invoice and a bill — which is
          // what makes a bug that mixed the two sides visible on one contact's row
          // rather than only in a total.
          displayName: `Party ${String(index)}`,
          isCustomer: true,
          isVendor: true,
        },
        ctx,
      );
      created.push(contact.id);
    }
    return created;
  });

  return {
    ctx,
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    startMonth: options.startMonth,
    accounts,
    rates,
    contacts,
  };

  async function accountIn(
    scope: RequestContext,
    code: string,
    type: 'asset' | 'liability' | 'revenue' | 'expense',
    normalBalance: 'debit' | 'credit',
  ): Promise<string> {
    const account = await createAccount(
      { code, name: `Account ${code}`, type, normalBalance },
      scope,
    );
    return account.id;
  }
}

async function idBytes(db: TestDatabase, orgId: Buffer, code: string): Promise<Buffer> {
  const row = await db.app
    .selectFrom('accounts')
    .select('id')
    .where('org_id', '=', orgId)
    .where('code', '=', code)
    .executeTakeFirst();

  if (row === undefined) throw new Error(`The scene has no account ${code}.`);
  return row.id;
}

/**
 * The **ledger** side of C2, computed exactly as OB-065's report says to compute it.
 *
 * `closing.balance` over a range with no lower bound, narrowed to the one account.
 * Nothing about the subledger is read here, and that is the whole discipline of the
 * property: taking the control balance from the documents would prove that a number
 * equals itself.
 *
 * The narrowing is the `accountIds` back door rather than a filter applied to the
 * result, because it is the path `getGeneralLedger` uses and the one no other
 * property in this directory reaches for a *single* account.
 */
export async function controlBalance(
  ctx: RequestContext,
  accountId: string,
  asOf: string,
): Promise<bigint> {
  const balances = await withContext(ctx, () =>
    getAccountBalances({ to: asOf }, ctx, { accountIds: [accountId] }),
  );

  const group = balances.groups[0];
  if (group === undefined) {
    throw new Error('An ungrouped balances report returned no group, which cannot happen.');
  }

  return group.totals.closing.balance;
}

/**
 * The signed amount a side's control account should hold.
 *
 * `debits − credits` is what `closing.balance` means, so a receivable — a
 * debit-normal asset — carries what is owed as a positive number and a payable
 * carries what is owed as a negative one. Aging reports both as positives, because
 * "what you owe your suppliers" is not a negative quantity to the person reading it.
 * The flip lives here, once, so a property never writes it inline and never gets
 * the direction from whichever side it happens to be looking at.
 */
export function signedFor(side: SubledgerSide, agingTotal: bigint): bigint {
  return side === 'receivable' ? agingTotal : -agingTotal;
}

export const LEDGER_OF: Readonly<Record<SubledgerSide, AgingLedger>> = {
  receivable: 'receivable',
  payable: 'payable',
};

export function controlAccountOf(scene: SubledgerScene, side: SubledgerSide): string {
  return side === 'receivable' ? scene.accounts.receivable : scene.accounts.payable;
}

/** The aging report for one side, as at a date, with detail rows. */
export function agingAt(
  ctx: RequestContext,
  side: SubledgerSide,
  asOf: string,
): ReturnType<typeof getAging> {
  return withContext(ctx, () =>
    getAging({ ledger: LEDGER_OF[side], asOf, detail: true, includeZero: true }, ctx),
  );
}

export const SUBLEDGER_SIDES: readonly SubledgerSide[] = ['receivable', 'payable'];

/** `YYYY-MM-DD`, `days` after `EPOCH`. Built in UTC, so no DST boundary is crossed. */
export function dateAfterEpoch(days: number): string {
  return shiftDate(EPOCH, days);
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Whole days between two calendar dates, `to − from`, written out here rather than
 * imported from `aging.service.ts`.
 *
 * The oracle for "which bucket is this in" must not be the code that chose the
 * bucket. `daysBetween` is not exported and importing it would make the bucket
 * property agree with the service for any boundary at all, including a mutated one.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
