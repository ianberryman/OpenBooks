import type { CreateAutomationRequest, CreateDraftRequest } from '@openbooks/shared-types';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext } from '../../src/context';
import type { RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AppConnection, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the Q suites (initiative Q, agent work queue, MCP-only; OB-200…210;
 * ROADMAP D-99/D-100/D-118/D-119).
 *
 * Duplicates `test/payments/support.ts`'s scaffolding — `useServiceDatabase`,
 * `contextFor`, the concurrency helpers — rather than importing it, following the
 * convention that file's own header states: two tickets' fixtures should not
 * break when the other's helper changes.
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

export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

export interface Org {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
}

/**
 * An org and an Owner member. `createAutomation`'s `requireAuthor` needs a real
 * user to attribute the automation to (`automations.service.ts`'s own header:
 * "an automation is authored by a user"), so every scene here carries one.
 */
export async function orgIn(db: TestDatabase): Promise<Org> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId('owner') });

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid),
  };
}

export interface LedgerOrg extends Org {
  readonly periodStart: string;
  readonly debitAccountUuid: string;
  readonly creditAccountUuid: string;
}

/** As `orgIn`, plus an open period and a debit/credit account pair a draft can post against. */
export async function ledgerOrgIn(db: TestDatabase): Promise<LedgerOrg> {
  const org = await orgIn(db);
  const period = await db.factories.fiscalPeriod({ orgId: org.orgId });
  const [debit, credit] = await Promise.all([
    db.factories.account({ orgId: org.orgId, type: 'expense', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.orgId, type: 'liability', normalBalance: 'credit' }),
  ]);

  return {
    ...org,
    periodStart: period.startDate,
    debitAccountUuid: debit.uuid,
    creditAccountUuid: credit.uuid,
  };
}

/** A balanced two-line draft input, postable in `o`'s own open period. */
export function balancedDraftInput(o: LedgerOrg, amountMinor = '5000'): CreateDraftRequest {
  return {
    entryDate: o.periodStart,
    lines: [
      { accountId: o.debitAccountUuid, side: 'debit', amount: amountMinor },
      { accountId: o.creditAccountUuid, side: 'credit', amount: amountMinor },
    ],
  };
}

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

/**
 * A single-`agent_task` automation request — one `runAutomation` firing enqueues
 * exactly one work item, which is what every queue suite here wants to control.
 */
export function agentTaskAutomationInput(
  prompt: string,
  sourceKind = 'test',
): CreateAutomationRequest {
  return {
    name: `Automation — ${prompt.slice(0, 40)}`,
    trigger: { type: 'manual' },
    actions: [{ type: 'agent_task', prompt, sourceKind }],
  };
}

export async function journalCount(db: TestDatabase, orgId: Buffer): Promise<number> {
  const row = await db.app
    .selectFrom('journals')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function draftCount(db: TestDatabase, orgId: Buffer): Promise<number> {
  const row = await db.app
    .selectFrom('journal_drafts')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

// ---------------------------------------------------------------------------
// Concurrency scaffolding — `test/payments/support.ts`'s own copy, restated for
// the same reason: Q10's single-grant lease claim (`FOR UPDATE SKIP LOCKED`)
// needs the same genuinely-concurrent, two-connection proof A9/D-14's races do
// (CLAUDE.md: "prove contention, don't assume it").
// ---------------------------------------------------------------------------

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

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

/** A call in flight, with settlement observable without consuming the promise. */
export interface Attempt<T> {
  readonly promise: Promise<T>;
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
