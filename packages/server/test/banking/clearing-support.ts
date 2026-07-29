import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import type { AccountFixture, SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, newUuid, systemRoleId, useTestDatabase, uuidToBuffer } from '../db';

/**
 * Fixtures for the OB-081 clearing suites.
 *
 * Built directly as the **app** user, following `test/banking/support.ts` and
 * `test/payments/support.ts`: a suite that imported another wave-2 module's fixtures
 * (the match engine, the rules) would fail whenever either was mid-edit, and building
 * as the app user is the stronger position — a missing grant surfaces here rather than
 * in production. The documents' journals are *real* journals, so the subledger and the
 * ledger agree in the fixture the way OB-071 requires them to in the product.
 *
 * Two harnesses, as in `test/payments/support.ts`:
 *  - `useServiceDatabase` initializes the process pool, for ordinary service tests.
 *  - `useTestDatabase` alone, for the race suite, so a query that escaped the ambient
 *    transaction throws rather than quietly running on a third connection.
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
  /** The ledger asset account the bank account is (D-46). */
  readonly bankLedger: AccountFixture;
  readonly bankAccountId: Buffer;
  readonly bankAccountUuid: string;
  readonly importId: Buffer;
  readonly receivable: AccountFixture;
  readonly payable: AccountFixture;
  readonly revenue: AccountFixture;
  readonly expense: AccountFixture;
  /** An expense account a bank charge posts to. */
  readonly charges: AccountFixture;
  readonly contact: ContactFixture;
}

let lineCounter = 0;

export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [bankLedger, receivable, payable, revenue, expense, charges] = await Promise.all([
    db.factories.account({ orgId: org.id, code: '1010', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '1100', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({
      orgId: org.id,
      code: '2010',
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({ orgId: org.id, code: '4000', type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: org.id, code: '5000', type: 'expense', normalBalance: 'debit' }),
    db.factories.account({ orgId: org.id, code: '5900', type: 'expense', normalBalance: 'debit' }),
  ]);

  await db.factories.controlAccounts({
    orgId: org.id,
    receivableId: receivable.id,
    payableId: payable.id,
  });

  const bankAccountUuid = newUuid();
  const bankAccountId = uuidToBuffer(bankAccountUuid);
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: bankAccountId,
      org_id: org.id,
      account_id: bankLedger.id,
      name: 'Current account',
    })
    .execute();

  const importId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: importId,
      org_id: org.id,
      bank_account_id: bankAccountId,
      format: 'csv',
      filename: 'statement.csv',
      file_hash: 'a'.repeat(64),
      status: 'complete',
      lines_read: 0,
      lines_duplicate: 0,
      imported_by_user_id: user.id,
    })
    .execute();

  const contact = await contactIn(db, org.id);

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    periodId: period.id,
    bankLedger,
    bankAccountId,
    bankAccountUuid,
    importId,
    receivable,
    payable,
    revenue,
    expense,
    charges,
    contact,
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

/** A second member of an existing org, holding one of the seeded roles. */
export async function memberIn(
  db: TestDatabase,
  scene: Scene,
  role: SystemRoleName,
): Promise<RequestContext> {
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: scene.orgId, userId: user.id, roleId: systemRoleId(role) });
  return contextFor(scene.orgUuid, SYSTEM_ROLE_UUIDS[role], user.uuid);
}

async function contactIn(db: TestDatabase, orgId: Buffer): Promise<ContactFixture> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: 'Acme Ltd', is_customer: 1, is_vendor: 1 })
    .execute();
  return { id, uuid };
}

// ---------------------------------------------------------------------------
// A statement line
// ---------------------------------------------------------------------------

export interface StatementLineOptions {
  readonly amountMinor: bigint;
  readonly postedDate?: string;
  readonly bankAccountId?: Buffer;
  readonly importId?: Buffer;
}

export interface StatementLineFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly amountMinor: bigint;
}

export async function statementLineIn(
  db: TestDatabase,
  scene: Scene,
  options: StatementLineOptions,
): Promise<StatementLineFixture> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  lineCounter += 1;
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id,
      org_id: scene.orgId,
      bank_account_id: options.bankAccountId ?? scene.bankAccountId,
      import_id: options.importId ?? scene.importId,
      posted_date: options.postedDate ?? scene.date,
      description: `Line ${String(lineCounter)}`,
      amount_minor: options.amountMinor,
      fingerprint: `f${String(lineCounter).padStart(63, '0')}`,
      occurrence_index: 0,
    })
    .execute();
  return { id, uuid, amountMinor: options.amountMinor };
}

// ---------------------------------------------------------------------------
// Approved subledger documents, with real journals
// ---------------------------------------------------------------------------

const documentNumbers = new Map<string, bigint>();

function nextNumber(orgId: Buffer, kind: string): bigint {
  const key = `${orgId.toString('hex')}:${kind}`;
  const next = (documentNumbers.get(key) ?? 0n) + 1n;
  documentNumbers.set(key, next);
  return next;
}

export interface DocumentFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly contactId: Buffer;
  readonly amountMinor: bigint;
}

export async function invoiceIn(
  db: TestDatabase,
  scene: Scene,
  amountMinor: bigint,
): Promise<DocumentFixture> {
  return documentIn(db, scene, 'invoice', amountMinor);
}

export async function billIn(
  db: TestDatabase,
  scene: Scene,
  amountMinor: bigint,
): Promise<DocumentFixture> {
  return documentIn(db, scene, 'bill', amountMinor);
}

async function documentIn(
  db: TestDatabase,
  scene: Scene,
  kind: 'invoice' | 'bill',
  amountMinor: bigint,
): Promise<DocumentFixture> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  const receivable = kind === 'invoice';
  const control = receivable ? scene.receivable : scene.payable;
  const other = receivable ? scene.revenue : scene.expense;

  const journal = await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: scene.date,
    actorId: scene.userId,
    source: kind,
    // Invoice: DR receivable, CR revenue. Bill: DR expense, CR payable.
    lines: receivable
      ? [
          { accountId: control.id, debitMinor: amountMinor },
          { accountId: other.id, creditMinor: amountMinor },
        ]
      : [
          { accountId: other.id, debitMinor: amountMinor },
          { accountId: control.id, creditMinor: amountMinor },
        ],
  });

  const header = {
    id,
    org_id: scene.orgId,
    sequence_number: nextNumber(scene.orgId, kind),
    contact_id: scene.contact.id,
    issue_date: scene.date,
    due_date: scene.date,
    tax_mode: 'exclusive' as const,
    reference: null,
    memo: null,
    journal_id: journal.id,
    void_journal_id: null,
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

  if (receivable) {
    await db.app
      .insertInto('ar_documents')
      .values({ ...header, document_type: 'invoice' })
      .execute();
    await db.app.insertInto('ar_document_lines').values(line).execute();
  } else {
    await db.app
      .insertInto('ap_documents')
      .values({ ...header, document_type: 'bill' })
      .execute();
    await db.app.insertInto('ap_document_lines').values(line).execute();
  }

  return { id, uuid, contactId: scene.contact.id, amountMinor };
}

/**
 * A plain balanced journal moving the bank ledger account by `signed`.
 *
 * `entryDate` defaults to the scene's date; OB-083's report tests pass one to place a
 * movement outside a session's window and prove it does not reach the as-at report.
 */
export async function bankJournalIn(
  db: TestDatabase,
  scene: Scene,
  signed: bigint,
  counterAccount: AccountFixture,
  entryDate: string = scene.date,
): Promise<{ readonly id: Buffer; readonly uuid: string }> {
  const magnitude = signed < 0n ? -signed : signed;
  const bankDebit = signed > 0n;
  const journal = await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate,
    actorId: scene.userId,
    lines: bankDebit
      ? [
          { accountId: scene.bankLedger.id, debitMinor: magnitude },
          { accountId: counterAccount.id, creditMinor: magnitude },
        ]
      : [
          { accountId: counterAccount.id, debitMinor: magnitude },
          { accountId: scene.bankLedger.id, creditMinor: magnitude },
        ],
  });
  return { id: journal.id, uuid: journal.uuid };
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

export interface StoredClearing {
  readonly id: Buffer;
  readonly cleared_amount_minor: bigint;
  readonly difference_amount_minor: bigint;
  readonly difference_account_id: Buffer | null;
  readonly difference_journal_id: Buffer | null;
}

/** The parent `bank_line_clearings` row (D-105) — see `entriesOf` for its children. */
export async function clearingOf(
  db: Kysely<DB>,
  lineId: Buffer,
): Promise<StoredClearing | undefined> {
  return db
    .selectFrom('bank_line_clearings')
    .select([
      'id',
      'cleared_amount_minor',
      'difference_amount_minor',
      'difference_account_id',
      'difference_journal_id',
    ])
    .where('statement_line_id', '=', lineId)
    .executeTakeFirst();
}

export interface StoredClearingEntry {
  readonly entry_type: string;
  readonly cleared_journal_id: Buffer;
  readonly payment_id: Buffer | null;
  readonly account_id: Buffer | null;
  readonly target_type: string | null;
  readonly target_id: Buffer | null;
  readonly entry_amount_minor: bigint;
}

/** Every `bank_line_clearing_entries` row belonging to one line's clearing (D-105). */
export async function entriesOf(
  db: Kysely<DB>,
  lineId: Buffer,
): Promise<readonly StoredClearingEntry[]> {
  return db
    .selectFrom('bank_line_clearing_entries')
    .innerJoin('bank_line_clearings', (join) =>
      join.onRef('bank_line_clearings.id', '=', 'bank_line_clearing_entries.clearing_id'),
    )
    .where('bank_line_clearings.statement_line_id', '=', lineId)
    .select([
      'bank_line_clearing_entries.entry_type',
      'bank_line_clearing_entries.cleared_journal_id',
      'bank_line_clearing_entries.payment_id',
      'bank_line_clearing_entries.account_id',
      'bank_line_clearing_entries.target_type',
      'bank_line_clearing_entries.target_id',
      'bank_line_clearing_entries.entry_amount_minor',
    ])
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

export async function journalCount(db: Kysely<DB>, orgId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE org_id = ${orgId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

/** How many reversals point at a journal — proves undo reversed rather than deleted. */
export async function reversalsOf(db: Kysely<DB>, journalId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE reverses_journal_id = ${journalId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

export async function journalStillExists(db: Kysely<DB>, journalId: Buffer): Promise<boolean> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE id = ${journalId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function allocationsForInvoice(db: Kysely<DB>, invoiceId: Buffer): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM ar_allocations WHERE invoice_id = ${invoiceId}
  `.execute(db);
  return Number(rows[0]?.count ?? 0);
}

/** A finalised reconciliation session covering lines up to `endDate`. */
export async function finalisedSessionIn(
  db: TestDatabase,
  scene: Scene,
  endDate: string,
  closingBalanceMinor: bigint,
): Promise<void> {
  const id = uuidToBuffer(newUuid());
  await db.app
    .insertInto('reconciliation_sessions')
    .values({
      id,
      org_id: scene.orgId,
      bank_account_id: scene.bankAccountId,
      end_date: endDate,
      statement_closing_balance_minor: closingBalanceMinor,
      state: 'finalised',
      finalised_at: new Date(),
      created_by_user_id: scene.userId,
    })
    .execute();
  await db.app
    .insertInto('reconciliation_session_events')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: scene.orgId,
      session_id: id,
      event_type: 'finalised',
      asserted_balance_minor: closingBalanceMinor,
      created_by_user_id: scene.userId,
    })
    .execute();
  // D-51: finalising freezes membership by stamping the session id onto the clearings
  // it counted — the clearings on this account whose line is dated on or before the
  // session's end date. The undo refusal reads this stamp, so the helper must set it
  // for a finalised session to actually "count" a line, exactly as the real
  // `finaliseReconciliationSession` does.
  await db.app
    .updateTable('bank_line_clearings')
    .set({ reconciliation_session_id: id })
    .where('org_id', '=', scene.orgId)
    .where('reconciliation_session_id', 'is', null)
    .where((eb) =>
      eb(
        'statement_line_id',
        'in',
        eb
          .selectFrom('bank_statement_lines')
          .select('id')
          .where('bank_account_id', '=', scene.bankAccountId)
          .where('posted_date', '<=', endDate),
      ),
    )
    .execute();
}
