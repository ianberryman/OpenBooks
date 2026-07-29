import { createHmac } from 'node:crypto';

import type { LightMyRequestResponse } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import type { NormalizedProcessorEvent, ProcessorKind } from '@openbooks/plugin-api';
import type { ProcessorConnection } from '@openbooks/shared-types';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import {
  connectProcessor,
  recordNormalizedEvent,
  type HandleWebhookResult,
} from '../../src/modules/payments-processing';
import { createLocalSecretsProvider, setSecretsProvider } from '../../src/providers';
import type { App } from '../../src/transport';
import type { AccountFixture, AppConnection, SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, newUuid, systemRoleId, useTestDatabase, uuidToBuffer } from '../db';
import { buildTestApp } from '../transport/harness';

/**
 * Support for the OB-152 payment-processing property/enforcement suites.
 *
 * Follows the register `test/payments/support.ts` and `test/invoices/support.ts` set:
 * fixtures built directly as the **app** user or through the exported service
 * functions this suite is meant to prove (`connectProcessor`, `createInvoice`,
 * `approveInvoice`, `recordNormalizedEvent`), never re-implemented, and a scene per
 * test rather than a shared one.
 *
 * ## Why this file also builds a real Fastify app
 *
 * F9's replay collapse and J5's signature check are properties of the *wire*
 * receiver (`POST /public/processing/:connectionId/webhook`), not only of
 * `recordNormalizedEvent` underneath it — `handleProcessorWebhook` is what verifies
 * the `x-fake-signature` header, and that only runs behind the route. So this harness
 * is `useV1App`'s shape (`test/transport/v1-support.ts`), trimmed to what payment
 * processing actually touches: no storage or outbound-mail adapter, because nothing
 * here sends a delivery email or stores a file.
 *
 * ## The one thing `useV1App`'s own suites never had to solve
 *
 * `connections.service.ts`'s `loadConnectionProvider` — reached by every webhook
 * delivery, never only by `connectProcessor` — calls the **process-wide**
 * `getConfig()` unconditionally, for `appBaseUrl`. That is a different config object
 * from the one `buildTestApp` was handed (`src/config/index.ts`'s singleton reads
 * `process.env` directly and is deliberately not settable by argument — importing
 * config must not validate the environment as a side effect). No existing suite
 * reaches that call path: `cross-org.test.ts`'s own comment installs the secrets
 * provider directly for the identical reason `secretsProvider()` would otherwise
 * touch the singleton too, but that sidesteps only `secretsProvider()`'s own
 * `getConfig()` call, not this bare one in `loadConnectionProvider`. This suite is the
 * first to actually delivery a webhook end to end, so it is the first to need this —
 * filling only the gaps (`??=`-shaped) so a real environment is never overridden.
 */

const CONFIG_ENV_FALLBACKS: Readonly<Record<string, string>> = {
  DATABASE_HOST: 'unused',
  DATABASE_USER: 'unused',
  DATABASE_PASSWORD: 'unused',
  DATABASE_NAME: 'unused',
  SESSION_SECRET: 's'.repeat(40),
  STORAGE_LOCAL_PATH: '/tmp/openbooks-test-payments-processing',
  EMAIL_FROM_ADDRESS: 'tests@example.invalid',
  SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
};

function ensureProcessEnvForConfig(): void {
  for (const [key, value] of Object.entries(CONFIG_ENV_FALLBACKS)) {
    process.env[key] ??= value;
  }
}

export interface PayHarness {
  readonly db: TestDatabase;
  /** Live from the first `beforeAll`. */
  app(): App;
}

export function usePayProcessingApp(): PayHarness {
  const db = useTestDatabase();
  let app: App | undefined;

  beforeAll(async () => {
    ensureProcessEnvForConfig();
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
    // `connectProcessor` writes through the secrets provider (D-101); installed
    // directly, the way `cross-org.test.ts` installs it, rather than through
    // `getConfig()` — this file's own process-wide config is never resolved for its
    // own sake.
    setSecretsProvider(
      createLocalSecretsProvider({ provider: 'local', encryptionKey: 'k'.repeat(32) }),
    );
    const built = await buildTestApp();
    app = built.app;
  });

  afterAll(async () => {
    await app?.close();
    app = undefined;
    setSecretsProvider(undefined);
    await destroyDatabase();
  });

  return {
    db,
    app: () => {
      if (app === undefined) throw new Error('usePayProcessingApp() builds in beforeAll.');
      return app;
    },
  };
}

// ---------------------------------------------------------------------------
// Scene: an org, its owner, an open period, and the four accounts a
// clearing-account posting model touches (D-82, D-103, D-104).
// ---------------------------------------------------------------------------

export interface Scene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
  readonly date: string;
  readonly periodId: Buffer;
  /** Where a charge clears into immediately (D-82). */
  readonly clearing: AccountFixture;
  /** Where the processor's per-charge fee posts (D-104). */
  readonly fee: AccountFixture;
  /** The nominated AR control account (D-23). */
  readonly receivable: AccountFixture;
  readonly income: AccountFixture;
  readonly contactId: string;
}

export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [clearing, fee, receivable, income] = await Promise.all([
    db.factories.account({ orgId: org.id, code: '1050', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '5900', type: 'expense', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '1100', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '4000', type: 'revenue', normalBalance: 'credit' }),
  ]);

  await db.factories.controlAccounts({ orgId: org.id, receivableId: receivable.id });

  const contactUuid = newUuid();
  await db.app
    .insertInto('contacts')
    .values({
      id: uuidToBuffer(contactUuid),
      org_id: org.id,
      display_name: 'Acme Ltd',
      is_customer: 1,
    })
    .execute();

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    periodId: period.id,
    clearing,
    fee,
    receivable,
    income,
    contactId: contactUuid,
  };
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
 * The context every processor-driven write actually runs under — `runAsAutomation`'s
 * own shape (`modules/scheduling/automation.ts`), rebuilt rather than called, because
 * `runAsAutomation` also resolves the owner's user id off `systemDb()` and invokes the
 * body immediately; the scene already knows its own owner (it is the only member
 * `sceneIn` creates), so this is that same context, available to hand to
 * `parkedTransactionOn`/`transactionOn` before any transaction opens.
 */
export function automationCtxFor(scene: Scene, actorId: string): RequestContext {
  return createRequestContext({
    orgId: scene.orgUuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: scene.userUuid,
    actorType: 'automation',
    actorId,
  });
}

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

// ---------------------------------------------------------------------------
// A connected `fake` processor
// ---------------------------------------------------------------------------

export interface FakeConnection {
  readonly connection: ProcessorConnection;
  readonly webhookSecret: string;
}

let connectionCounter = 0;

/** Connects `fake` to the scene's clearing and fee accounts (D-82, D-103). */
export async function connectFakeProcessor(scene: Scene): Promise<FakeConnection> {
  connectionCounter += 1;
  const n = connectionCounter;
  const webhookSecret = `whsec_test_${String(n)}`;

  const connection = await withContext(scene.ctx, () =>
    connectProcessor(
      {
        processor: 'fake',
        clearingAccountId: scene.clearing.uuid,
        feeAccountId: scene.fee.uuid,
        secretKey: `sk_test_${String(n)}`,
        webhookSecret,
      },
      scene.ctx,
    ),
  );

  return { connection, webhookSecret };
}

// ---------------------------------------------------------------------------
// An approved invoice, sized to settle exactly one charge (createInvoice +
// approveInvoice — the real service, never a raw insert).
// ---------------------------------------------------------------------------

export interface InvoiceFixture {
  readonly id: string;
  readonly contactId: string;
}

export async function invoiceIn(scene: Scene, grossMinor: bigint): Promise<InvoiceFixture> {
  return withContext(scene.ctx, async () => {
    const created = await createInvoice(
      {
        contactId: scene.contactId,
        issueDate: scene.date,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitAmount: grossMinor.toString(),
            accountId: scene.income.uuid,
          },
        ],
      },
      scene.ctx,
    );
    const approved = await approveInvoice(created.id, scene.ctx);
    return { id: approved.id, contactId: approved.contactId };
  });
}

/**
 * Dispatches one normalized event exactly as the webhook route does
 * (`recordNormalizedEvent`), inside the ambient context scope every call that
 * reaches `postJournal` needs — `assertPostable` (`modules/periods`) reads
 * `getContext()` directly rather than a threaded parameter, so a bare call to
 * `recordNormalizedEvent` outside `runInContext` throws `ContextUnavailableError`
 * the moment a charge, refund or chargeback tries to post. The one caller that must
 * *not* go through this helper is a `parkedTransactionOn`/`transactionOn` body
 * (`test/payments/support.ts`'s own concurrency shape): `runScoped` already wraps the
 * body in `runInContext`, and this would only nest it redundantly.
 */
export function recordEvent(
  ctx: RequestContext,
  connectionId: string,
  processor: ProcessorKind,
  event: NormalizedProcessorEvent,
): Promise<HandleWebhookResult> {
  return withContext(ctx, () => recordNormalizedEvent(connectionId, processor, event, ctx));
}

// ---------------------------------------------------------------------------
// Normalized-event builders (plugin-api `NormalizedProcessorEvent`)
// ---------------------------------------------------------------------------

const DEFAULT_OCCURRED_AT = '2026-01-15T00:00:00.000Z';

export interface ChargeEventInput {
  readonly invoiceId: string | null;
  readonly externalObjectId: string;
  readonly externalEventId: string;
  readonly grossMinor: string;
  readonly feeMinor?: string | null;
  readonly occurredAt?: string;
}

export function chargeEvent(input: ChargeEventInput): NormalizedProcessorEvent {
  return {
    kind: 'charge',
    externalEventId: input.externalEventId,
    externalObjectId: input.externalObjectId,
    invoiceId: input.invoiceId,
    grossMinor: input.grossMinor,
    feeMinor: input.feeMinor ?? null,
    netMinor: null,
    occurredAt: input.occurredAt ?? DEFAULT_OCCURRED_AT,
  };
}

export interface RefundEventInput {
  readonly invoiceId?: string | null;
  readonly externalObjectId: string;
  readonly externalEventId: string;
  readonly grossMinor: string;
  readonly occurredAt?: string;
}

export function refundEvent(input: RefundEventInput): NormalizedProcessorEvent {
  return {
    kind: 'refund',
    externalEventId: input.externalEventId,
    externalObjectId: input.externalObjectId,
    invoiceId: input.invoiceId ?? null,
    grossMinor: input.grossMinor,
    feeMinor: null,
    netMinor: null,
    occurredAt: input.occurredAt ?? DEFAULT_OCCURRED_AT,
  };
}

export interface PayoutEventInput {
  readonly externalObjectId: string;
  readonly externalEventId: string;
  readonly netMinor: string;
  readonly occurredAt?: string;
}

export function payoutEvent(input: PayoutEventInput): NormalizedProcessorEvent {
  return {
    kind: 'payout',
    externalEventId: input.externalEventId,
    externalObjectId: input.externalObjectId,
    invoiceId: null,
    grossMinor: input.netMinor,
    feeMinor: null,
    netMinor: input.netMinor,
    occurredAt: input.occurredAt ?? DEFAULT_OCCURRED_AT,
  };
}

export interface DisputeEventInput {
  readonly externalObjectId: string;
  readonly externalEventId: string;
  readonly grossMinor: string;
  readonly occurredAt?: string;
}

export function disputeEvent(input: DisputeEventInput): NormalizedProcessorEvent {
  return {
    kind: 'dispute',
    externalEventId: input.externalEventId,
    externalObjectId: input.externalObjectId,
    invoiceId: null,
    grossMinor: input.grossMinor,
    feeMinor: null,
    netMinor: null,
    occurredAt: input.occurredAt ?? DEFAULT_OCCURRED_AT,
  };
}

// ---------------------------------------------------------------------------
// Signing and delivering a `fake` webhook over HTTP
// ---------------------------------------------------------------------------

/**
 * `fake.ts`'s own scheme, reproduced: `HMAC-SHA256(webhookSecret, rawBody)` hex,
 * the header `x-fake-signature` (`SIGNATURE_HEADER_BY_PROCESSOR.fake`,
 * `transport/routes/processing-webhook.ts`).
 */
export function signFakeWebhook(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Delivers a normalized event to `POST /public/processing/:connectionId/webhook`,
 * signed the way `fake.ts` verifies (or, with `signature` overridden, signed wrong —
 * for the J5 refusal case). The body is built once, as a string, and both the
 * signature and the injected payload are computed over that exact string — never a
 * JSON object handed to `app.inject`, which would let Fastify re-serialize it and
 * silently desync the bytes the signature covers from the bytes the raw-body parser
 * receives.
 */
export async function deliverFakeWebhook(
  app: App,
  connectionId: string,
  webhookSecret: string,
  event: NormalizedProcessorEvent,
  options: { readonly signatureOverride?: string } = {},
): Promise<LightMyRequestResponse> {
  const rawBody = JSON.stringify(event);
  const signature = options.signatureOverride ?? signFakeWebhook(webhookSecret, rawBody);

  return app.inject({
    method: 'POST',
    url: `/public/processing/${connectionId}/webhook`,
    headers: { 'content-type': 'application/json', 'x-fake-signature': signature },
    payload: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Concurrency scaffolding — a deliberate duplicate of
// `test/payments/support.ts`'s (see that file's header for why).
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

/** The physical MySQL connection id — proves two `AppConnection` handles are genuinely separate. */
export async function mysqlConnectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

export interface Attempt<T> {
  readonly promise: Promise<T>;
  hasSettled(): boolean;
}

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
// Reading back
// ---------------------------------------------------------------------------

export async function paymentsCount(db: Kysely<DB>, orgId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM payments WHERE org_id = ${orgId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

export async function processorEventsCount(db: Kysely<DB>, orgId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM processor_events WHERE org_id = ${orgId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

export async function externalRefsCountFor(
  db: Kysely<DB>,
  orgId: Buffer,
  externalId: string,
): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM external_refs
    WHERE org_id = ${orgId} AND external_id = ${externalId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

export interface JournalRow {
  readonly id: Buffer;
  readonly actor_type: 'user' | 'automation' | 'agent';
  readonly actor_id: Buffer;
  readonly invocation_mode: 'interactive' | 'scheduled' | null;
}

export async function journalByMemo(
  db: Kysely<DB>,
  orgId: Buffer,
  memo: string,
): Promise<JournalRow> {
  return db
    .selectFrom('journals')
    .select(['id', 'actor_type', 'actor_id', 'invocation_mode'])
    .where('org_id', '=', orgId)
    .where('memo', '=', memo)
    .executeTakeFirstOrThrow();
}

export async function journalById(db: Kysely<DB>, id: Buffer): Promise<JournalRow> {
  return db
    .selectFrom('journals')
    .select(['id', 'actor_type', 'actor_id', 'invocation_mode'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** The journal a charge's settlement payment posted, found by its `reference` —
 * `recordProcessorCharge` passes the charge's own `externalObjectId` as the
 * payment's `reference` (`posting.service.ts`), so this is the one sanctioned way
 * to find that journal without threading a return value through
 * `recordNormalizedEvent`, whose own result discards it (`dispatch`'s `'charge'`
 * case returns a bare status). */
export async function paymentJournalIdByReference(
  db: Kysely<DB>,
  orgId: Buffer,
  reference: string,
): Promise<Buffer> {
  const row = await db
    .selectFrom('payments')
    .select('journal_id')
    .where('org_id', '=', orgId)
    .where('reference', '=', reference)
    .executeTakeFirstOrThrow();
  return row.journal_id;
}

export interface JournalLineRow {
  readonly account_id: Buffer;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
}

export async function linesOfJournal(
  db: Kysely<DB>,
  journalId: Buffer,
): Promise<readonly JournalLineRow[]> {
  return db
    .selectFrom('journal_lines')
    .select(['account_id', 'debit_minor', 'credit_minor'])
    .where('journal_id', '=', journalId)
    .orderBy('line_number')
    .execute();
}

/** One account's `debits - credits` across every posted journal in the org. */
export async function accountBalance(db: Kysely<DB>, accountId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ debits: string; credits: string }>`
    SELECT COALESCE(SUM(debit_minor), 0) AS debits, COALESCE(SUM(credit_minor), 0) AS credits
    FROM journal_lines WHERE account_id = ${accountId}
  `.execute(db);
  return BigInt(rows[0]?.debits ?? '0') - BigInt(rows[0]?.credits ?? '0');
}

/**
 * The clearing account's balance, computed a **second, independent way**: summing
 * `processor_events.payload` — a different table than `journal_lines`, populated by
 * a different write (`insertProcessorEventIfNew`, not `postJournal`) — rather than
 * re-deriving the ledger's own number from the ledger. The OB-088
 * `report.property.test.ts` discipline: two aggregations over different tables must
 * agree, or the property asserts nothing.
 *
 * Mirrors exactly what touches the clearing account per event kind (`posting.service.ts`):
 * a `charge` debits it by `grossMinor` and credits it by `feeMinor` when present; a
 * `refund` credits it by `grossMinor`; a `payout` posts no journal at all (D-82 — the
 * reconciling entry is a later, separate M4 clear); a `dispute`/chargeback credits it
 * too, but is not part of this suite's clearing-reconciliation generator (kept out so
 * the arithmetic below stays exactly "charges minus fees minus refunds").
 */
export async function clearingBalanceFromEventLog(db: Kysely<DB>, orgId: Buffer): Promise<bigint> {
  const rows = await db
    .selectFrom('processor_events')
    .select(['event_type', 'payload'])
    .where('org_id', '=', orgId)
    .execute();

  let total = 0n;
  for (const row of rows) {
    const payload = row.payload as unknown as NormalizedProcessorEvent;
    if (row.event_type === 'charge') {
      total += BigInt(payload.grossMinor);
      if (payload.feeMinor !== null) total -= BigInt(payload.feeMinor);
    } else if (row.event_type === 'refund') {
      total -= BigInt(payload.grossMinor);
    }
  }
  return total;
}
