import { sql, type Kysely } from 'kysely';

import type { OpenBooksEventInput } from '@openbooks/plugin-api';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import {
  createReconciliationSession,
  finaliseReconciliationSession,
} from '../../src/modules/banking/reconciliation/reconciliation.service';
import { approveBill, createBill } from '../../src/modules/bills';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import { recordPayment } from '../../src/modules/payments';
import type { AccountFixture, AppConnection, SystemRoleName, TestDatabase } from '../db';
import {
  bufferToUuid,
  newUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  systemRoleId,
  uuidToBuffer,
} from '../db';

/**
 * Shared scaffolding for OB-107's outbox / change-feed / external-refs suites.
 *
 * A deliberate duplicate of `test/enforcement/support.ts` and `test/invoices/support.ts`
 * in its harness and race scaffolding, following the convention those files state:
 * reaching sideways into another ticket's support file means this suite breaks when
 * that one is edited. This one is local to OB-107 and shared only across this
 * ticket's own three files (`event-outbox.property.test.ts`,
 * `change-feed.property.test.ts`, `external-refs.property.test.ts`), the way
 * `test/properties/subledger-support.ts` is shared across OB-071's own files and no
 * others.
 *
 * Every file that imports this uses `useTestDatabase()` alone — never
 * `useServiceDatabase()` / `initializeDatabase()`. The process pool is deliberately
 * left uninitialized so a service call that escapes the ambient transaction this file
 * pins it to throws "Database not initialized" rather than quietly running on a third
 * connection, where it would see neither side's uncommitted state and a contention
 * proof would pass having proved nothing (`test/enforcement/support.ts`'s header
 * states this at length; it applies here unchanged). That discipline costs nothing on
 * the non-concurrent properties either, so it is applied uniformly rather than only on
 * the races.
 */

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
 * in `permissions.service.ts` is a `WeakMap` keyed on the frozen context object, so a
 * literal would be a different kind of key from the one the request path produces.
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

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

// ---------------------------------------------------------------------------
// Two-connection race scaffolding — a duplicate of `test/enforcement/support.ts`
// ---------------------------------------------------------------------------

/** A call in flight, with settlement observable without consuming the promise. */
export interface Attempt<T> {
  readonly promise: Promise<T>;
  /** The contention probe: a statement waiting on another transaction's lock has not settled. */
  hasSettled(): boolean;
}

/** An attempt held open after its body finished, still holding every lock it took. */
export interface ParkedAttempt<T> extends Attempt<T> {
  /** Resolves once `body` has returned and the transaction is parked, still uncommitted. */
  readonly parked: Promise<T>;
  /** Commits the parked transaction. `promise` then resolves with the body's value. */
  commit(): void;
  /** Rolls the parked transaction back. `promise` then rejects with `reason`. */
  rollback(reason: Error): void;
}

/**
 * Runs `body` in its own transaction on `connection`, inside `ctx`'s scope.
 *
 * `emitEvent`, and every service this file drives, take no database handle — they
 * reach data through `tenantDb()`, which consults `ambientTransaction()`
 * (`transaction-scope.ts`). Opening a transaction on a chosen connection and
 * entering its scope is therefore how a call is pinned to that connection, and it
 * is not a test-only contrivance: it is the exact shape
 * `withIdempotency(spec, () => approveInvoice(id))` has in production, where the
 * outer transaction belongs to the idempotency layer and the write joins it.
 */
export function transactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Attempt<T> {
  return watch(runScoped(connection, ctx, body));
}

/** As `transactionOn`, but pauses after `body` resolves and holds the transaction open. */
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

// ---------------------------------------------------------------------------
// Orgs and scenes
// ---------------------------------------------------------------------------

/** A date inside the default fiscal period (`2026-01-01`..`2026-12-31`). */
export const OP_DATE = '2026-03-10';

export interface OrgCtx {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly ctx: RequestContext;
}

/** An org with a member user and no ledger of its own — all `emitEvent` needs (F8). */
export async function orgIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<OrgCtx> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}

/** Everything the four real emit sites (F7) need to exist, approve, and post. */
export interface Scene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly ctx: RequestContext;
  readonly receivable: AccountFixture;
  readonly payable: AccountFixture;
  readonly bankLedger: AccountFixture;
  readonly revenue: AccountFixture;
  readonly expense: AccountFixture;
  /** The `bank_accounts` row's own id — what `createReconciliationSession` names. */
  readonly bankAccountUuid: string;
  /** Both a customer and a vendor, so one scene can raise an invoice and a bill. */
  readonly contactUuid: string;
}

export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<Scene> {
  const org = await orgIn(db, role);
  await db.factories.fiscalPeriod({ orgId: org.orgId });

  const [receivable, payable, bankLedger, revenue, expense] = await Promise.all([
    db.factories.account({ orgId: org.orgId, type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.orgId, type: 'liability', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.orgId, type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.orgId, type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.orgId, type: 'expense', normalBalance: 'debit' }),
  ]);

  await db.factories.controlAccounts({
    orgId: org.orgId,
    receivableId: receivable.id,
    payableId: payable.id,
  });

  const bankAccountUuid = newUuid();
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: uuidToBuffer(bankAccountUuid),
      org_id: org.orgId,
      account_id: bankLedger.id,
      name: 'Current account',
    })
    .execute();

  const contactId = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id: contactId,
      org_id: org.orgId,
      display_name: 'Acme Co',
      is_customer: 1,
      is_vendor: 1,
    })
    .execute();

  return {
    orgId: org.orgId,
    orgUuid: org.orgUuid,
    ctx: org.ctx,
    receivable,
    payable,
    bankLedger,
    revenue,
    expense,
    bankAccountUuid,
    contactUuid: bufferToUuid(contactId),
  };
}

// ---------------------------------------------------------------------------
// Real emit sites (F7) — one committed operation each, pinned to `connection`
// ---------------------------------------------------------------------------

/** Approves a fresh, no-tax invoice for `amountMinor`. Two commits: create, then approve. */
export async function approveInvoiceOn(
  connection: AppConnection,
  scene: Scene,
  amountMinor: bigint,
): Promise<string> {
  const invoice = await transactionOn(connection, scene.ctx, () =>
    createInvoice({
      contactId: scene.contactUuid,
      issueDate: OP_DATE,
      taxMode: 'exclusive',
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitAmount: amountMinor.toString(),
          accountId: scene.revenue.uuid,
        },
      ],
    }),
  ).promise;

  await transactionOn(connection, scene.ctx, () => approveInvoice(invoice.id)).promise;
  return invoice.id;
}

/** Approves a fresh, no-tax bill for `amountMinor`. Two commits: create, then approve. */
export async function approveBillOn(
  connection: AppConnection,
  scene: Scene,
  amountMinor: bigint,
): Promise<string> {
  const bill = await transactionOn(connection, scene.ctx, () =>
    createBill({
      contactId: scene.contactUuid,
      issueDate: OP_DATE,
      taxMode: 'exclusive',
      lines: [
        {
          description: 'Supplies',
          quantity: '1',
          unitAmount: amountMinor.toString(),
          accountId: scene.expense.uuid,
        },
      ],
    }),
  ).promise;

  await transactionOn(connection, scene.ctx, () => approveBill(bill.id)).promise;
  return bill.id;
}

/** Records a payment for `amountMinor`. One commit. */
export async function recordPaymentOn(
  connection: AppConnection,
  scene: Scene,
  direction: 'received' | 'made',
  amountMinor: bigint,
): Promise<string> {
  const payment = await transactionOn(connection, scene.ctx, () =>
    recordPayment({
      direction,
      contactId: scene.contactUuid,
      date: OP_DATE,
      amount: amountMinor.toString(),
      accountId: scene.bankLedger.uuid,
    }),
  ).promise;
  return payment.id;
}

/**
 * Finalises a zero-balance reconciliation session on the scene's bank account.
 *
 * No statement lines are ever imported in this file, so the cleared balance is
 * always `0` (`openingBalance` and `clearedInWindow` both sum `bank_line_clearings`,
 * which stays empty) — a session asserting `statementClosingBalance: '0'` always
 * finalises, with no dependency on anything else the scene did. At most one call per
 * scene: a second session on the same account needs a *later* `endDate`
 * (`reconciliation_session_overlaps`), which this file does not attempt to sequence.
 */
export async function finaliseReconciliationOn(
  connection: AppConnection,
  scene: Scene,
): Promise<string> {
  const session = await transactionOn(connection, scene.ctx, () =>
    createReconciliationSession({
      bankAccountId: scene.bankAccountUuid,
      endDate: OP_DATE,
      statementClosingBalance: '0',
    }),
  ).promise;

  await transactionOn(connection, scene.ctx, () => finaliseReconciliationSession(session.id))
    .promise;
  return session.id;
}

// ---------------------------------------------------------------------------
// Direct, synthetic emits (F8) — the outbox mechanism, not a business event
// ---------------------------------------------------------------------------

/**
 * A syntactically valid `invoice.approved.v1` input, standing in for any committed
 * change (F8's ordering and replay properties are about `emitEvent`'s own mechanism —
 * `position` allocation and the change feed's keyset read over it — not about
 * invoicing, so a marker payload built directly rather than raised through
 * `approveInvoiceOn` above is the more direct proof and a lot cheaper per event).
 * `marker` is carried as `invoiceId` purely as a correlation handle a test can look
 * for on the way back out.
 */
export function markedInvoiceApprovedInput(
  orgUuid: string,
  ctx: RequestContext,
  marker: string,
  amountMinor: bigint,
): OpenBooksEventInput {
  return {
    name: 'invoice.approved.v1',
    orgId: orgUuid,
    actor: {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    },
    payload: {
      invoiceId: marker,
      contactId: newUuid(),
      journalId: newUuid(),
      total: amountMinor,
      date: OP_DATE,
    },
  };
}

// ---------------------------------------------------------------------------
// Observing the outbox
// ---------------------------------------------------------------------------

export interface EventLogRow {
  readonly id: Buffer;
  readonly position: bigint;
  readonly name: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly invocationMode: string | null;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

/** Every `event_log` row for `orgId`, oldest first — a direct read, not the feed. */
export async function readEventLog(db: Kysely<DB>, orgId: Buffer): Promise<readonly EventLogRow[]> {
  const rows = await db
    .selectFrom('event_log')
    .select([
      'id',
      'position',
      'name',
      'actor_type',
      'actor_id',
      'invocation_mode',
      'payload',
      'occurred_at',
    ])
    .where('org_id', '=', orgId)
    .orderBy('position', 'asc')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    name: row.name,
    actorType: row.actor_type,
    actorId: row.actor_id,
    invocationMode: row.invocation_mode,
    payload: row.payload,
    occurredAt: row.occurred_at,
  }));
}

export async function countExternalRefs(db: Kysely<DB>, orgId: Buffer): Promise<number> {
  const row = await db
    .selectFrom('external_refs')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
