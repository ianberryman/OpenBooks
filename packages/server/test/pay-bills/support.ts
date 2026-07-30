import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { createBankAccount } from '../../src/modules/banking';
import type { Check, CheckOutput } from '../../src/modules/pay-bills';
import { updateControlAccounts, updateDiscountAccounts } from '../../src/modules/settings';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AccountFixture, AppConnection, SystemRoleName, TestDatabase } from '../db';
import {
  newUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  bufferToUuid,
  systemRoleId,
  useTestDatabase,
  uuidToBuffer,
} from '../db';

/**
 * Support for OB-117, the Pay Bills server verification suite.
 *
 * A deliberate duplicate of `test/bills/support.ts` and `test/payments/support.ts`
 * in its harness and race scaffolding, following the convention those files state:
 * reaching sideways into another suite's support means this suite breaks when that
 * one is edited.
 *
 * ## Two scenes, because the tests need two different things from the database
 *
 *  - `serviceSceneIn` nominates the chart through the real settings/banking
 *    services (`updateControlAccounts`, `updateDiscountAccounts`,
 *    `createBankAccount`) and is for `issue.test.ts`'s end-to-end happy path,
 *    which runs on `useServiceDatabase()` (the process pool initialized) — every
 *    pay-bills service call it makes reaches `tenantDb()` through `rawDb()`.
 *  - `sceneIn` builds the identical chart directly against `db.app`, the way
 *    `test/bills/support.ts`'s `sceneIn` does, and is for the contention and
 *    invariants suites: `queue-contention.race.test.ts` deliberately runs on a bare
 *    `useTestDatabase()` with no process pool, so setup cannot call a service
 *    outside a transaction scope — it would throw "Database not initialized",
 *    which is the harness doing its job (see `test/db/harness.ts`).
 */
export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

export const CONTENTION_WAIT_MS = 750;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export async function vendorIn(db: TestDatabase, orgId: Buffer, name: string): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_vendor: 1, is_active: 1 })
    .execute();
  return id;
}

async function insertBankAccountRow(
  db: TestDatabase,
  orgId: Buffer,
  ledgerAccountId: Buffer,
  name: string,
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('bank_accounts')
    .values({ id, org_id: orgId, account_id: ledgerAccountId, name })
    .execute();
  return id;
}

// ---------------------------------------------------------------------------
// The raw, factory-built scene — for the race and invariants suites
// ---------------------------------------------------------------------------

/** Everything a pending payment needs to build and issue, built with no service call. */
export interface PbScene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
  /** A date inside the open period. */
  readonly date: string;
  readonly periodId: Buffer;
  readonly vendorId: Buffer;
  readonly vendorUuid: string;
  /** The bank's own ledger (asset) account. */
  readonly bank: AccountFixture;
  /** The `bank_accounts` registration over `bank`. */
  readonly bankAccountId: Buffer;
  readonly bankAccountUuid: string;
  /** The liability account nominated as the payables control account. */
  readonly payable: AccountFixture;
  /** The expense account a bill line debits. */
  readonly expense: AccountFixture;
}

/**
 * An org with an open period, a vendor, a nominated payables control account, a
 * registered bank account, and no discount nomination — the race and invariants
 * suites do not need one. Everything is built directly against `db.app`
 * (`factories.controlAccounts`'s own reasoning): a missing grant on
 * `org_accounting_settings` or `bank_accounts` surfaces here rather than in
 * production, and — for `sceneIn` specifically — reaching for a service instead
 * would need a transaction scope this function does not have (it runs in
 * `beforeEach`, outside any `transactionOn`).
 */
export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<PbScene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [bank, payable, expense] = await Promise.all([
    db.factories.account({ orgId: org.id, code: '1010', name: 'Checking', type: 'asset' }),
    db.factories.account({
      orgId: org.id,
      code: '2010',
      name: 'Accounts payable',
      type: 'liability',
    }),
    db.factories.account({ orgId: org.id, code: '5000', name: 'Office supplies', type: 'expense' }),
  ]);

  await db.factories.controlAccounts({ orgId: org.id, payableId: payable.id });
  const bankAccountId = await insertBankAccountRow(db, org.id, bank.id, 'Checking');
  const vendorId = await vendorIn(db, org.id, 'Acme Supplies');

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    periodId: period.id,
    vendorId,
    vendorUuid: bufferToUuid(vendorId),
    bank,
    bankAccountId,
    bankAccountUuid: bufferToUuid(bankAccountId),
    payable,
    expense,
  };
}

export type ApDocKind = 'bill' | 'vendor_credit';

export interface ApDocumentFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly amountMinor: bigint;
}

const documentNumbers = new Map<string, bigint>();

function nextDocumentNumber(orgId: Buffer, kind: ApDocKind): bigint {
  const key = `${orgId.toString('hex')}:${kind}`;
  const next = (documentNumbers.get(key) ?? 0n) + 1n;
  documentNumbers.set(key, next);
  return next;
}

/**
 * An approved bill or vendor credit with one line and a real journal — the AP-only
 * twin of `test/payments/support.ts`'s `documentIn`, restricted to the two
 * document types Pay Bills settles. A bill credits the payables control account
 * and debits the expense account; a vendor credit is the mirror (`journalSides`'s
 * direction, restated in `vendor-credits.service.ts`'s header).
 *
 * Inserted directly rather than through `createBill`/`approveBill`, matching
 * `test/bills/approve-race.test.ts`'s own reasoning: these suites are about the
 * pending-payment queue's own locking, not about bill approval, and — for the
 * contention suite specifically — a service call from `beforeEach` would have no
 * transaction to join and no process pool to fall back to.
 */
export async function documentIn(
  db: TestDatabase,
  scene: PbScene,
  kind: ApDocKind,
  amountMinor = 100_000n,
): Promise<ApDocumentFixture> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  // A vendor credit debits payable and credits expense; a bill is the mirror.
  const controlDebits = kind === 'vendor_credit';

  const journal = await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: scene.date,
    actorId: scene.userId,
    source: kind,
    lines: controlDebits
      ? [
          { accountId: scene.payable.id, debitMinor: amountMinor },
          { accountId: scene.expense.id, creditMinor: amountMinor },
        ]
      : [
          { accountId: scene.expense.id, debitMinor: amountMinor },
          { accountId: scene.payable.id, creditMinor: amountMinor },
        ],
  });

  await db.app
    .insertInto('ap_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: kind,
      sequence_number: nextDocumentNumber(scene.orgId, kind),
      contact_id: scene.vendorId,
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

  await db.app
    .insertInto('ap_document_lines')
    .values({
      org_id: scene.orgId,
      document_id: id,
      line_number: 1,
      description: `${kind} line`,
      quantity_micros: 1_000_000n,
      unit_amount_minor: amountMinor,
      account_id: scene.expense.id,
      tax_rate_id: null,
      line_amount_minor: amountMinor,
      tax_amount_minor: 0n,
    })
    .execute();

  return { id, uuid, amountMinor };
}

// ---------------------------------------------------------------------------
// The service-built scene — for the happy-path issue suite
// ---------------------------------------------------------------------------

/** Everything the end-to-end issue test needs, nominated through the real services. */
export interface ServiceScene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly ctx: RequestContext;
  readonly date: string;
  readonly vendorUuid: string;
  readonly bank: AccountFixture;
  readonly bankAccountUuid: string;
  readonly payable: AccountFixture;
  readonly expense: AccountFixture;
  readonly discountReceived: AccountFixture;
}

/**
 * An org whose chart is nominated exactly the way a real setup flow nominates it:
 * `updateControlAccounts` for the payables control account, `updateDiscountAccounts`
 * for the discount-received account, `createBankAccount` to register the bank
 * ledger account. Requires `useServiceDatabase()` — every one of those calls
 * reaches `tenantDb()` through `rawDb()`, the initialized process pool.
 */
export async function serviceSceneIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<ServiceScene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });
  const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid);

  const [bank, payable, expense, discountReceived] = await Promise.all([
    db.factories.account({ orgId: org.id, code: '1010', name: 'Checking', type: 'asset' }),
    db.factories.account({
      orgId: org.id,
      code: '2010',
      name: 'Accounts payable',
      type: 'liability',
    }),
    db.factories.account({ orgId: org.id, code: '5000', name: 'Office supplies', type: 'expense' }),
    db.factories.account({
      orgId: org.id,
      code: '4900',
      name: 'Purchase discounts',
      type: 'revenue',
    }),
  ]);

  await updateControlAccounts({ payableControlAccountId: payable.uuid }, ctx);
  await updateDiscountAccounts({ discountReceivedAccountId: discountReceived.uuid }, ctx);
  const bankAccount = await createBankAccount({ accountId: bank.uuid, name: 'Checking' }, ctx);

  const vendorId = await vendorIn(db, org.id, 'Acme Supplies');

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    ctx,
    date: period.startDate,
    vendorUuid: bufferToUuid(vendorId),
    bank,
    bankAccountUuid: bankAccount.id,
    payable,
    expense,
    discountReceived,
  };
}

/**
 * A real, small `CheckOutput` (spec §11: "no mocks" applied to this seam means a
 * real implementation the test wrote, not a stubbed return value) that records
 * what it was asked to emit instead of rendering a PDF through `storageProvider`.
 *
 * `check-output.ts`'s own header names this exact shape as the intended use of
 * `setCheckOutput`: "a suite exercising `issuePendingPayment` installs an
 * implementation it also holds a reference to, so it can assert what `emit` was
 * called with." The default implementation needs a fully configured
 * `storageProvider`/logger (`getConfig()`), which this suite's environment does
 * not set up — install this before any check-rail issue.
 */
export interface CapturingCheckOutput extends CheckOutput {
  readonly emitted: Check[];
}

export function capturingCheckOutput(): CapturingCheckOutput {
  const emitted: Check[] = [];
  return {
    emitted,
    emit: (check: Check) => {
      emitted.push(check);
      return Promise.resolve({});
    },
  };
}

// ---------------------------------------------------------------------------
// Observing the ledger and the queue
// ---------------------------------------------------------------------------

/** One account's `debits - credits` across every posted journal — signed, `direction.test.ts`'s reason. */
export async function accountBalance(db: Kysely<DB>, accountId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ debits: string | null; credits: string | null }>`
    SELECT SUM(debit_minor) AS debits, SUM(credit_minor) AS credits
      FROM journal_lines WHERE account_id = ${accountId}
  `.execute(db);

  const row = rows[0];
  return BigInt(row?.debits ?? '0') - BigInt(row?.credits ?? '0');
}

export async function countJournals(db: Kysely<DB>, orgId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE org_id = ${orgId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

/** What a bill has left, computed the way `settlementOf` computes it (D-34). */
export async function outstandingOfBill(db: Kysely<DB>, billId: Buffer): Promise<bigint> {
  const { rows: totals } = await sql<{ total: string }>`
    SELECT COALESCE(SUM(line_amount_minor + tax_amount_minor), 0) AS total
      FROM ap_document_lines WHERE document_id = ${billId}
  `.execute(db);

  const { rows: applied } = await sql<{ total: string }>`
    SELECT COALESCE(SUM(amount_minor), 0) AS total
      FROM ap_allocations WHERE bill_id = ${billId}
  `.execute(db);

  return BigInt(totals[0]?.total ?? '0') - BigInt(applied[0]?.total ?? '0');
}

/** Σ `pay_amount_minor` over a bill's `open` pending intents — D-68's `committed`, read fresh. */
export async function committedForBillDirect(db: Kysely<DB>, billId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ total: string | null }>`
    SELECT SUM(ppi.pay_amount_minor) AS total
      FROM pending_payment_intents ppi
      JOIN pending_payments pp
        ON pp.id = ppi.pending_payment_id AND pp.org_id = ppi.org_id
     WHERE ppi.bill_id = ${billId} AND pp.status = 'open'
  `.execute(db);

  return BigInt(rows[0]?.total ?? '0');
}

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

// ---------------------------------------------------------------------------
// Two-connection race scaffolding (a deliberate duplicate of `test/bills/support.ts`)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A call in flight, with settlement observable without consuming the promise. */
export interface Attempt<T> {
  readonly promise: Promise<T>;
  /** The contention probe: a statement waiting on a row lock cannot have settled. */
  hasSettled(): boolean;
}

/** An attempt held open after its body finished, still holding every lock it took. */
export interface ParkedAttempt<T> extends Attempt<T> {
  readonly parked: Promise<T>;
  commit(): void;
  rollback(reason: Error): void;
}

export function transactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Attempt<T> {
  return watch(runScoped(connection, ctx, body));
}

export function parkedTransactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): ParkedAttempt<T> {
  const parked = deferred<T>();
  const release = deferred<void>();

  const promise = runScoped(connection, ctx, async () => {
    const value = await body();
    parked.resolve(value);
    // Rejecting `release` throws from here, which is what rolls the transaction
    // back — the same mechanism a real downstream failure uses.
    await release.promise;
    return value;
  });

  promise.catch((error: unknown) => {
    parked.reject(error);
  });

  return {
    ...watch(promise),
    parked: parked.promise,
    commit: () => {
      release.resolve();
    },
    rollback: (reason: Error) => {
      release.reject(reason);
    },
  };
}

function runScoped<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Promise<T> {
  return connection.db
    .transaction()
    .execute((trx) => runInTransactionScope(trx, () => runInContext(ctx, body)));
}

function watch<T>(promise: Promise<T>): Attempt<T> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void promise.then(mark, mark);
  return { promise, hasSettled: () => settled };
}
