import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AppConnection, SystemRoleName, TestDatabase } from '../db';
import {
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  bufferToUuid,
  systemRoleId,
  useTestDatabase,
} from '../db';

/**
 * Support for the OB-063 suites.
 *
 * A deliberate duplicate of `test/drafts/support.ts` in its harness and race
 * scaffolding, following the convention that file states: those are another
 * ticket's fixtures, and reaching sideways into another suite's support means this
 * suite breaks when that one is edited.
 *
 * Two harnesses, and choosing the wrong one makes a test prove nothing:
 *
 *  - `useServiceDatabase` initializes the *process* pool, because the AP
 *    repository reaches data through `tenantDb()` and that reads the
 *    module-private client. Ordinary service tests use it.
 *  - `useTestDatabase` alone, which the concurrency suite uses, deliberately does
 *    **not**. With no process pool, a query that escaped the ambient transaction
 *    throws "Database not initialized" rather than quietly running on a third
 *    connection — where it would see neither side's uncommitted state and the race
 *    would appear to pass having proved nothing.
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

/**
 * How long a blocked statement is given to prove it is blocked.
 *
 * One-directional, as in `test/drafts/support.ts`: every assertion taken after
 * this wait is about a state that must *hold*, so a too-short wait cannot turn a
 * failing test into a passing one — it can only fail to catch a mutation.
 */
export const CONTENTION_WAIT_MS = 750;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A request context for an `(org, role, user)` triple.
 *
 * Through `createRequestContext` rather than an object literal: the permission
 * memo is a `WeakMap` keyed on the frozen context object, so a literal would be a
 * different kind of key from the one the request path produces.
 */
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
 * Not optional for anything that approves: the services accept a context
 * *parameter*, but `assertPostable` — reached through `postJournal` — takes none
 * and reads the ambient one, because spec §4 forbids threading `orgId` through
 * signatures.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

/** Everything an AP document needs to exist, approve, and post. */
export interface ApScene {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
  /** A date inside the open period. */
  readonly date: string;
  readonly vendorUuid: string;
  readonly vendorId: Buffer;
  /** The expense account a bill line debits. */
  readonly expenseUuid: string;
  readonly expenseId: Buffer;
  /** The liability account nominated as the payables control account (OB-066a). */
  readonly payableUuid: string;
  readonly payableId: Buffer;
  /** The liability account a tax rate posts to. */
  readonly taxAccountUuid: string;
  readonly taxAccountId: Buffer;
  /** 20%. */
  readonly taxRateUuid: string;
  readonly taxRateId: Buffer;
}

let codeSequence = 0;

/**
 * An org with an open period, a vendor, a nominated payables control account, and
 * a rate.
 *
 * The accounts, the contact and the rate are inserted as the **app** user, which
 * is the stronger position: a missing grant surfaces here rather than in
 * production. `factories.account` runs as the app user for the same reason.
 */
export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<ApScene> {
  const seq = (codeSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [expense, payable, taxAccount] = await Promise.all([
    db.factories.account({
      orgId: org.id,
      code: `6${String(seq).padStart(3, '0')}`,
      name: 'Office supplies',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: org.id,
      code: `20${String(seq).padStart(2, '0')}`,
      name: 'Accounts payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: org.id,
      code: `22${String(seq).padStart(2, '0')}`,
      name: 'VAT on purchases',
      type: 'liability',
      normalBalance: 'credit',
    }),
  ]);

  // What makes this the control account is the nomination, not its code (OB-066a).
  await db.factories.controlAccounts({ orgId: org.id, payableId: payable.id });

  const vendorId = await vendorIn(db, org.id, `Acme Supplies ${String(seq)}`);
  const taxRateId = await taxRateIn(db, org.id, `VAT 20 #${String(seq)}`, 200_000, taxAccount.id);

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    vendorUuid: bufferToUuid(vendorId),
    vendorId,
    expenseUuid: expense.uuid,
    expenseId: expense.id,
    payableUuid: payable.uuid,
    payableId: payable.id,
    taxAccountUuid: taxAccount.uuid,
    taxAccountId: taxAccount.id,
    taxRateUuid: bufferToUuid(taxRateId),
    taxRateId,
  };
}

/**
 * A second member of the *same* org, holding a different seeded role.
 *
 * The permission suite needs this rather than a second `sceneIn`: two scenes are
 * two orgs, and a cross-org call is a 404 by construction (A7), which would hide
 * whichever permission answer the test was actually about.
 */
export async function memberOf(
  db: TestDatabase,
  scene: ApScene,
  role: SystemRoleName,
): Promise<RequestContext> {
  const user = await db.factories.user();
  await db.factories.orgMember({
    orgId: scene.orgId,
    userId: user.id,
    roleId: systemRoleId(role),
  });

  return contextFor(scene.orgUuid, SYSTEM_ROLE_UUIDS[role], user.uuid);
}

export async function vendorIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
  flags: { readonly isVendor?: boolean; readonly isActive?: boolean } = {},
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: name,
      is_vendor: flags.isVendor === false ? 0 : 1,
      is_active: flags.isActive === false ? 0 : 1,
    })
    .execute();
  return id;
}

export async function taxRateIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
  ratePpm: number,
  taxAccountId: Buffer,
  isActive = true,
  /** D-35's restriction. Omitted means the column's default, `both`. */
  appliesTo: 'sales' | 'purchases' | 'both' = 'both',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('tax_rates')
    .values({
      id,
      org_id: orgId,
      name,
      rate_ppm: ratePpm,
      tax_account_id: taxAccountId,
      applies_to: appliesTo,
      is_active: isActive ? 1 : 0,
    })
    .execute();
  return id;
}

export interface DimensionFixture {
  readonly dimensionId: Buffer;
  readonly valueIds: readonly Buffer[];
  readonly valueUuids: readonly string[];
}

export async function dimensionIn(
  db: TestDatabase,
  orgId: Buffer,
  code: string,
  valueCodes: readonly string[],
): Promise<DimensionFixture> {
  const dimensionId = newUuidBuffer();
  await db.app
    .insertInto('dimensions')
    .values({ id: dimensionId, org_id: orgId, code, name: code })
    .execute();

  const valueIds = valueCodes.map(() => newUuidBuffer());
  await db.app
    .insertInto('dimension_values')
    .values(
      valueCodes.map((valueCode, index) => ({
        id: valueIds[index] ?? newUuidBuffer(),
        org_id: orgId,
        dimension_id: dimensionId,
        code: valueCode,
        name: valueCode,
      })),
    )
    .execute();

  return { dimensionId, valueIds, valueUuids: valueIds.map((id) => bufferToUuid(id)) };
}

// ---------------------------------------------------------------------------
// Observing the ledger
// ---------------------------------------------------------------------------

/**
 * The **signed** balance of one account: debits minus credits.
 *
 * Signed, and that is the point of this helper rather than a count of lines. A
 * journal posted with its sides swapped still balances and still sums to zero
 * across the trial balance; the only assertion it fails is one that reads the
 * direction of a single account. See `direction.test.ts`.
 */
export async function accountBalance(
  db: Kysely<DB>,
  orgId: Buffer,
  accountId: Buffer,
): Promise<bigint> {
  const { rows } = await sql<{ debits: string | null; credits: string | null }>`
    SELECT SUM(debit_minor) AS debits, SUM(credit_minor) AS credits
      FROM journal_lines
     WHERE org_id = ${orgId} AND account_id = ${accountId}
  `.execute(db);

  const row = rows[0];
  return BigInt(row?.debits ?? '0') - BigInt(row?.credits ?? '0');
}

export interface ApLedgerState {
  readonly documents: number;
  readonly documentLines: number;
  readonly documentTags: number;
  readonly journals: number;
  readonly journalLines: number;
  readonly documentNumbers: readonly string[];
  readonly journalSequenceNumbers: readonly string[];
}

/**
 * Everything about one org's AP documents and ledger that a half-applied approval
 * would disturb.
 *
 * D-38's claim is that numbering a document and posting its journal are one
 * transaction, and the claim is negative in both directions: after a successful
 * approval there is a journal *and* a number, and after a failed one there is
 * neither. Neither is provable from a count of journals alone, so the two are
 * always read together, from a connection that is not one of the racing pair.
 */
export async function readApLedgerState(db: Kysely<DB>, orgId: Buffer): Promise<ApLedgerState> {
  const count = async (
    table:
      | 'ap_documents'
      | 'ap_document_lines'
      | 'ap_document_line_dimensions'
      | 'journals'
      | 'journal_lines',
  ): Promise<number> => {
    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE org_id = ${orgId}
    `.execute(db);
    return Number(rows[0]?.count ?? 0);
  };

  const documents = await db
    .selectFrom('ap_documents')
    .select('sequence_number')
    .where('org_id', '=', orgId)
    .where('sequence_number', 'is not', null)
    .orderBy('sequence_number')
    .execute();

  const journals = await db
    .selectFrom('journals')
    .select('sequence_number')
    .where('org_id', '=', orgId)
    .orderBy('sequence_number')
    .execute();

  return {
    documents: await count('ap_documents'),
    documentLines: await count('ap_document_lines'),
    documentTags: await count('ap_document_line_dimensions'),
    journals: await count('journals'),
    journalLines: await count('journal_lines'),
    documentNumbers: documents.map((row) => String(row.sequence_number)),
    journalSequenceNumbers: journals.map((row) => String(row.sequence_number)),
  };
}

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

// ---------------------------------------------------------------------------
// Two-connection race scaffolding (a duplicate of test/drafts/support.ts)
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

/**
 * Runs `body` in its own transaction on `connection`, inside `ctx`'s scope.
 *
 * Opening the transaction here and entering its scope is how a service call is
 * pinned to a chosen connection — the services take no handle and consult
 * `ambientTransaction()`. Not a test-only contrivance: it is the shape
 * `withIdempotency(spec, () => approveBill(id))` has in production.
 */
export function transactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Attempt<T> {
  return watch(runScoped(connection, ctx, body));
}

/** As `transactionOn`, but holds the transaction open until `commit()` or `rollback()`. */
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
