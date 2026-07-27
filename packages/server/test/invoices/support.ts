import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AppConnection, SystemRoleName, TestDatabase } from '../db';
import {
  bufferToUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  systemRoleId,
  useTestDatabase,
} from '../db';

/**
 * Support for the OB-062 suites.
 *
 * The harness helpers are deliberate duplicates of `test/drafts/support.ts`,
 * following the convention that file states: reaching sideways into another
 * suite's fixtures means this suite breaks when that one is edited.
 *
 * Two harnesses, and choosing the wrong one makes a test prove nothing:
 *
 *  - `useServiceDatabase` initializes the *process* pool, because the repository
 *    reaches data through `tenantDb()` and that reads the module-private client.
 *    Ordinary service tests use it.
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

/** How long a blocked statement is given to prove it is blocked. */
export const CONTENTION_WAIT_MS = 750;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * A request context for an `(org, role, user)` triple.
 *
 * Through `createRequestContext` rather than an object literal: the permission memo
 * is a `WeakMap` keyed on the frozen context object, so a literal would be a
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
 * Not optional for anything that approves: `assertPostable`, reached through
 * `postJournal`, takes no context and reads the ambient one, because spec §4 forbids
 * threading `orgId` through signatures.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

export async function actorIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<ActorFixture> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}

/**
 * Everything an AR document needs before it can be approved.
 *
 * The receivables account is *nominated* rather than given a magic code: since
 * OB-066a the service reads the org's accounting settings, so what makes this
 * account the control account is `factories.controlAccounts` below and nothing
 * about its code. `refusesWithoutControlAccount` in `invoices.service.test.ts`
 * covers the org that has nominated nothing.
 */
export interface Scene {
  readonly actor: ActorFixture;
  /** The receivables control account, as nominated in the org's settings. */
  readonly receivable: string;
  readonly income: string;
  readonly secondIncome: string;
  readonly taxLiability: string;
  readonly contact: string;
  readonly contactId: Buffer;
  /** 20%, exclusive or inclusive depending on the document. */
  readonly vat: string;
  readonly vatId: Buffer;
  readonly date: string;
  readonly periodEnd: string;
}

export async function scene(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<Scene> {
  const actor = await actorIn(db, role);
  const [period, receivable, income, secondIncome, taxLiability] = await Promise.all([
    db.factories.fiscalPeriod({ orgId: actor.orgId }),
    db.factories.account({
      orgId: actor.orgId,
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({ orgId: actor.orgId, type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: actor.orgId, type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: actor.orgId, type: 'liability', normalBalance: 'credit' }),
  ]);

  await db.factories.controlAccounts({ orgId: actor.orgId, receivableId: receivable.id });

  const contactId = await contactIn(db, actor.orgId);
  const vatId = await taxRateIn(db, actor.orgId, 'VAT 20%', 200_000, taxLiability.id);

  return {
    actor,
    receivable: receivable.uuid,
    income: income.uuid,
    secondIncome: secondIncome.uuid,
    taxLiability: taxLiability.uuid,
    contact: bufferToUuid(contactId),
    contactId,
    vat: bufferToUuid(vatId),
    vatId,
    date: period.startDate,
    periodEnd: period.endDate,
  };
}

/**
 * A contact, inserted as the **app** user.
 *
 * The stronger position: a missing grant surfaces here rather than in production.
 * Written here rather than added to `test/db/factories.ts` because contacts are
 * OB-036's and their factory belongs with the service that owns the table.
 */
export async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  name = 'Acme Ltd',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_customer: 1 })
    .execute();
  return id;
}

/** A tax rate, in parts per million (`200_000` is 20%). OB-066 owns the service. */
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

  return { dimensionId, valueIds };
}

/**
 * An allocation against a document, written directly.
 *
 * OB-064 owns `createAllocations`; this suite needs the *effect* of one — a document
 * with something applied to it — to assert that `status` and `settlement` are
 * derived (D-34, D-38) and that voiding an allocated document is refused.
 */
export async function allocationIn(
  db: TestDatabase,
  orgId: Buffer,
  input: {
    readonly invoiceId: Buffer;
    readonly creditNoteId?: Buffer;
    readonly paymentId?: Buffer;
    readonly amountMinor: bigint;
    readonly allocatedOn: string;
    readonly userId: Buffer;
  },
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('ar_allocations')
    .values({
      id,
      org_id: orgId,
      invoice_id: input.invoiceId,
      credit_note_id: input.creditNoteId ?? null,
      payment_id: input.paymentId ?? null,
      amount_minor: input.amountMinor,
      allocated_on: input.allocatedOn,
      created_by_user_id: input.userId,
    })
    .execute();
  return id;
}

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
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

/**
 * Everything about one org's AR documents and ledger that a half-applied approval
 * would disturb.
 *
 * D-38's claim is that allocating the number, posting the journal and recording both
 * are one transaction, and the claim is negative in both directions: after a
 * successful approval there is a journal, a number and a document that names them,
 * and after a failed one there are none of the three. Neither is provable from a
 * count of journals alone, so they are always read together, from a connection that
 * is not one of the racing pair.
 */
export interface ArLedgerState {
  readonly documents: number;
  readonly documentLines: number;
  readonly journals: number;
  readonly journalLines: number;
  readonly documentNumbers: readonly string[];
  readonly journalIds: readonly string[];
  readonly nextInvoiceNumber: string | null;
}

export async function readArState(db: Kysely<DB>, orgId: Buffer): Promise<ArLedgerState> {
  const count = async (
    table: 'ar_document_lines' | 'ar_documents' | 'journal_lines' | 'journals',
  ): Promise<number> => {
    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE org_id = ${orgId}
    `.execute(db);
    return Number(rows[0]?.count ?? 0);
  };

  const documents = await db
    .selectFrom('ar_documents')
    .select(['sequence_number', 'journal_id'])
    .where('org_id', '=', orgId)
    .orderBy('created_at')
    .execute();

  const counter = await db
    .selectFrom('document_sequences')
    .select('next_value')
    .where('org_id', '=', orgId)
    .where('document_type', '=', 'invoice')
    .executeTakeFirst();

  return {
    documents: await count('ar_documents'),
    documentLines: await count('ar_document_lines'),
    journals: await count('journals'),
    journalLines: await count('journal_lines'),
    documentNumbers: documents
      .map((row) => row.sequence_number)
      .filter((value): value is bigint => value !== null)
      .map(String),
    journalIds: documents
      .map((row) => row.journal_id)
      .filter((value): value is Buffer => value !== null)
      .map((value) => bufferToUuid(value)),
    nextInvoiceNumber: counter === undefined ? null : String(counter.next_value),
  };
}
