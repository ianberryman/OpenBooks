import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AccountFixture, AppConnection, SystemRoleName, TestDatabase } from '../db';
import {
  newUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  systemRoleId,
  useTestDatabase,
  uuidToBuffer,
} from '../db';

/**
 * Support for the OB-064 suites.
 *
 * ## Why the documents are built here rather than through the module that owns them
 *
 * Allocation points at invoices, credit notes, bills and vendor credits, and those
 * modules (OB-062, OB-063) were being written in the same wave as this one. A
 * fixture that imported them would make this suite fail whenever either of them was
 * mid-edit, and would make an allocation test a test of somebody else's document
 * service. So the documents are inserted directly, as the **app** user — which is
 * the stronger position and not a shortcut: a missing grant on `ar_documents`
 * surfaces here rather than in production, exactly as `contactIn` in
 * `test/drafts/support.ts` argues.
 *
 * The one thing the fixtures do not fake is the ledger. An approved document's
 * journal is a real journal, posted through `factories.journal` with the lines the
 * document would have posted — receivable against revenue, payable against
 * expense — so the subledger and the ledger agree in the fixture the way OB-071
 * will require them to agree in the product.
 *
 * ## Two harnesses, and choosing the wrong one makes a test prove nothing
 *
 *  - `useServiceDatabase` initializes the *process* pool, because the payments
 *    repository reaches data through `tenantDb()`. Ordinary service tests use it.
 *  - `useTestDatabase` alone, which the race suite uses, deliberately does not:
 *    with no process pool, a query that escaped the ambient transaction throws
 *    rather than quietly running on a third connection, where it would see neither
 *    side's uncommitted state and the race would appear to pass having proved
 *    nothing.
 *
 * The helpers below the fixtures are deliberate duplicates of
 * `test/drafts/support.ts`, following the convention those files state: reaching
 * sideways into another suite's support file means this suite breaks when that one
 * is edited.
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
 * The codes the shipped chart template uses for the two control accounts.
 *
 * Nothing resolves an account by them since OB-066a — the scene *nominates* the
 * two accounts in the org's settings, which is what makes them control accounts.
 * They are still fixed here so a chart in a test reads like a chart.
 */
export const RECEIVABLE_CODE = '1100';
export const PAYABLE_CODE = '2010';

export interface ContactFixture {
  readonly id: Buffer;
  readonly uuid: string;
}

export interface Scene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
  readonly date: string;
  readonly periodId: Buffer;
  readonly bank: AccountFixture;
  readonly receivable: AccountFixture;
  readonly payable: AccountFixture;
  readonly revenue: AccountFixture;
  readonly expense: AccountFixture;
  /** Marked as both, so one contact can carry an invoice and a bill. */
  readonly contact: ContactFixture;
  /** A second party, for the refusals that are about crossing between them. */
  readonly other: ContactFixture;
}

/**
 * An org with an open period, both control accounts nominated, a bank account, and
 * two contacts.
 *
 * The role is the caller's to choose because half of what this module has to prove
 * is who may do what. `owner` is the default; `bookkeeper` behaves identically for
 * every operation here.
 */
export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [bank, receivable, payable, revenue, expense] = await Promise.all([
    db.factories.account({ orgId: org.id, code: '1010', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({
      orgId: org.id,
      code: RECEIVABLE_CODE,
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: org.id,
      code: PAYABLE_CODE,
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({ orgId: org.id, code: '4000', type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.id, code: '5000', type: 'expense', normalBalance: 'debit' }),
  ]);

  await db.factories.controlAccounts({
    orgId: org.id,
    receivableId: receivable.id,
    payableId: payable.id,
  });

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    periodId: period.id,
    bank,
    receivable,
    payable,
    revenue,
    expense,
    contact: await contactIn(db, org.id, 'Acme Ltd'),
    other: await contactIn(db, org.id, 'Beta Ltd'),
  };
}

/**
 * A second member of an existing org, holding one of the six seeded roles.
 *
 * Separate from `sceneIn(db, role)`, which builds a whole org around one role:
 * several assertions need a scene set up by someone who *can* record a payment and
 * then read by someone who may only read one side of it, and re-roling the
 * original member would change the authority of the rows already written.
 */
export async function memberIn(
  db: TestDatabase,
  scene: Scene,
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

export async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  displayName: string,
): Promise<ContactFixture> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);

  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: displayName,
      // Both, so one fixture contact can hold an invoice and a bill at once.
      is_customer: 1,
      is_vendor: 1,
    })
    .execute();

  return { id, uuid };
}

export type DocumentKind = 'invoice' | 'credit_note' | 'bill' | 'vendor_credit';

export interface DocumentOptions {
  /** The document's gross amount, spread over one line. Defaults to 100.00. */
  readonly amountMinor?: bigint;
  readonly contactId?: Buffer;
  readonly issueDate?: string;
  readonly dueDate?: string;
  /** No journal and no number, which is what `draft` means (D-38). */
  readonly draft?: boolean;
  /** A reversing journal recorded against it, which is what `void` means. */
  readonly voided?: boolean;
}

export interface DocumentFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly kind: DocumentKind;
  readonly amountMinor: bigint;
  readonly contactId: Buffer;
}

/** Per-org, per-type document numbering, mirroring `document_sequences` (D-36). */
const numbers = new Map<string, bigint>();

function nextNumber(orgId: Buffer, kind: DocumentKind): bigint {
  const key = `${orgId.toString('hex')}:${kind}`;
  const next = (numbers.get(key) ?? 0n) + 1n;
  numbers.set(key, next);
  return next;
}

/**
 * An approved (or draft, or voided) subledger document with one line.
 *
 * The journal is the document's real one: an invoice debits the receivables
 * control account and credits revenue, a credit note reverses that, and the
 * payables pair mirrors both. A fixture that posted an arbitrary balanced journal
 * would let an allocation test pass while the control account said something else
 * entirely, which is the one disagreement M3 exists to make impossible.
 */
export async function documentIn(
  db: TestDatabase,
  scene: Scene,
  kind: DocumentKind,
  options: DocumentOptions = {},
): Promise<DocumentFixture> {
  const amountMinor = options.amountMinor ?? 100_00n;
  const contactId = options.contactId ?? scene.contact.id;
  const issueDate = options.issueDate ?? scene.date;
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  const receivable = kind === 'invoice' || kind === 'credit_note';

  const control = receivable ? scene.receivable : scene.payable;
  const other = receivable ? scene.revenue : scene.expense;
  // An invoice and a vendor credit debit the control account; a credit note and a
  // bill credit it.
  const controlDebits = kind === 'invoice' || kind === 'vendor_credit';

  const journal = options.draft
    ? undefined
    : await db.factories.journal({
        orgId: scene.orgId,
        periodId: scene.periodId,
        entryDate: issueDate,
        actorId: scene.userId,
        source: kind,
        lines: controlDebits
          ? [
              { accountId: control.id, debitMinor: amountMinor },
              { accountId: other.id, creditMinor: amountMinor },
            ]
          : [
              { accountId: other.id, debitMinor: amountMinor },
              { accountId: control.id, creditMinor: amountMinor },
            ],
      });

  const voidJournal =
    options.voided === true && journal !== undefined
      ? await db.factories.journal({
          orgId: scene.orgId,
          periodId: scene.periodId,
          entryDate: issueDate,
          actorId: scene.userId,
          source: 'reversal',
          reversesJournalId: journal.id,
          lines: controlDebits
            ? [
                { accountId: other.id, debitMinor: amountMinor },
                { accountId: control.id, creditMinor: amountMinor },
              ]
            : [
                { accountId: control.id, debitMinor: amountMinor },
                { accountId: other.id, creditMinor: amountMinor },
              ],
        })
      : undefined;

  const header = {
    id,
    org_id: scene.orgId,
    // `chk_*_documents_approved` ties the number to the journal: both or neither.
    sequence_number: journal === undefined ? null : nextNumber(scene.orgId, kind),
    contact_id: contactId,
    issue_date: issueDate,
    due_date: options.dueDate ?? issueDate,
    tax_mode: 'exclusive' as const,
    reference: null,
    memo: null,
    journal_id: journal?.id ?? null,
    void_journal_id: voidJournal?.id ?? null,
    created_by_user_id: scene.userId,
  };

  const line = {
    org_id: scene.orgId,
    document_id: id,
    line_number: 1,
    description: `${kind} line`,
    quantity_micros: 1_000_000n,
    unit_amount_minor: amountMinor,
    account_id: other.id,
    tax_rate_id: null,
    line_amount_minor: amountMinor,
    tax_amount_minor: 0n,
  };

  if (kind === 'invoice' || kind === 'credit_note') {
    await db.app
      .insertInto('ar_documents')
      .values({ ...header, document_type: kind })
      .execute();
    await db.app.insertInto('ar_document_lines').values(line).execute();
  } else {
    await db.app
      .insertInto('ap_documents')
      .values({ ...header, document_type: kind })
      .execute();
    await db.app.insertInto('ap_document_lines').values(line).execute();
  }

  return { id, uuid, kind, amountMinor, contactId };
}

/**
 * What a document has left, computed exactly as the service computes it: the sum
 * of its lines minus the allocations against it (D-34).
 *
 * Written out here rather than read through the service, because the service that
 * publishes it is OB-062's and this suite must not depend on it. A second
 * implementation of a *derivation* is a real risk — but it is two `SUM`s over
 * columns that carry the whole meaning, and asserting against a number this file
 * computed the same way the module does would be asserting nothing.
 */
export async function outstandingOf(
  db: Kysely<DB>,
  kind: 'invoice' | 'bill',
  documentId: Buffer,
): Promise<bigint> {
  const linesTable = kind === 'invoice' ? 'ar_document_lines' : 'ap_document_lines';
  const allocationsTable = kind === 'invoice' ? 'ar_allocations' : 'ap_allocations';
  const targetColumn = kind === 'invoice' ? 'invoice_id' : 'bill_id';

  const { rows: totals } = await sql<{ total: string }>`
    SELECT COALESCE(SUM(line_amount_minor + tax_amount_minor), 0) AS total
    FROM ${sql.table(linesTable)} WHERE document_id = ${documentId}
  `.execute(db);

  const { rows: applied } = await sql<{ total: string }>`
    SELECT COALESCE(SUM(amount_minor), 0) AS total
    FROM ${sql.table(allocationsTable)} WHERE ${sql.ref(targetColumn)} = ${documentId}
  `.execute(db);

  return BigInt(totals[0]?.total ?? '0') - BigInt(applied[0]?.total ?? '0');
}

/** Everything about one org's ledger and allocations that a payment disturbs. */
export interface LedgerState {
  readonly journals: number;
  readonly journalLines: number;
  readonly payments: number;
  readonly arAllocations: number;
  readonly apAllocations: number;
}

export async function readLedgerState(db: Kysely<DB>, orgId: Buffer): Promise<LedgerState> {
  const count = async (
    table: 'journals' | 'journal_lines' | 'payments' | 'ar_allocations' | 'ap_allocations',
  ): Promise<number> => {
    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE org_id = ${orgId}
    `.execute(db);
    return Number(rows[0]?.count ?? 0);
  };

  return {
    journals: await count('journals'),
    journalLines: await count('journal_lines'),
    payments: await count('payments'),
    arAllocations: await count('ar_allocations'),
    apAllocations: await count('ap_allocations'),
  };
}

/** One account's `debits - credits` across every posted journal in the org. */
export async function accountBalance(db: Kysely<DB>, accountId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ debits: string; credits: string }>`
    SELECT COALESCE(SUM(debit_minor), 0) AS debits, COALESCE(SUM(credit_minor), 0) AS credits
    FROM journal_lines WHERE account_id = ${accountId}
  `.execute(db);

  return BigInt(rows[0]?.debits ?? '0') - BigInt(rows[0]?.credits ?? '0');
}

// ---------------------------------------------------------------------------
// Context and race scaffolding — duplicates of `test/drafts/support.ts`
// ---------------------------------------------------------------------------

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
 * Not optional for anything that posts: the services take a context parameter, but
 * `assertPostable` — reached through `postJournal` — reads the ambient one, because
 * spec §4 forbids threading `orgId` through signatures.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

/** A context whose user id names no row, for the "no author" refusal. */
export function contextWithoutUser(orgUuid: string, roleUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: null,
    actorType: 'automation',
    actorId: newUuid(),
  });
}

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

export function newId(): Buffer {
  return newUuidBuffer();
}
