import type { Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import type { ParsedStatement } from '../../src/modules/banking/parser';
import type { StatementParseFn } from '../../src/modules/banking/statements/service';
import type { Logger } from '../../src/logging';
import type { TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, newUuid, systemRoleId, useTestDatabase, uuidToBuffer } from '../db';

/**
 * Support for the OB-078 statement-import suites.
 *
 * The fixtures are built directly as the **app** user, following the convention
 * `test/payments/support.ts` states: a suite that imported another wave-1 module's
 * fixtures (the CSV/OFX parsers, OB-076/OB-077) would fail whenever either was
 * mid-edit. So an org, a ledger account, and a bank account are inserted here, and the
 * parser is *injected* — every import test drives a controlled `ParsedStatement`
 * through the real dedupe and the real async path, never a real file.
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

export interface Scene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
  readonly bankAccountId: Buffer;
  readonly bankAccountUuid: string;
  /** The bank account's own external identifier, for the account-match warning. */
  readonly externalAccountId: string | null;
}

export interface SceneOptions {
  readonly externalAccountId?: string | null;
  readonly isActive?: boolean;
}

/** An org with an owner and one bank account over a ledger asset account. */
export async function sceneIn(db: TestDatabase, options: SceneOptions = {}): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId('owner') });

  const account = await db.factories.account({
    orgId: org.id,
    code: '1010',
    type: 'asset',
    normalBalance: 'debit',
  });

  const bankAccountUuid = newUuid();
  const bankAccountId = uuidToBuffer(bankAccountUuid);
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: bankAccountId,
      org_id: org.id,
      account_id: account.id,
      name: 'Current account',
      external_account_id: options.externalAccountId ?? null,
      is_active: (options.isActive ?? true) ? 1 : 0,
    })
    .execute();

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: createRequestContext({
      orgId: org.uuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: user.uuid,
      actorType: 'user',
      actorId: user.uuid,
    }),
    bankAccountId,
    bankAccountUuid,
    externalAccountId: options.externalAccountId ?? null,
  };
}

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

// ---------------------------------------------------------------------------
// A controlled file and the fake parser that reads it
// ---------------------------------------------------------------------------

/** One transaction, as a test states it. `amount` is minor units. */
export interface FileRow {
  readonly postedDate: string;
  readonly valueDate?: string | null;
  readonly amount: bigint;
  readonly description: string;
  readonly counterparty?: string | null;
  readonly bankReference?: string | null;
}

export interface FileOptions {
  readonly closingBalance?: bigint | null;
  readonly externalAccountId?: string | null;
}

/**
 * Encodes rows as the "file" content the import carries.
 *
 * JSON, not CSV or OFX, because the parser is faked: the point of these suites is the
 * dedupe and the async lifecycle, not the format reading (OB-076/OB-077 own that).
 * `amount` is a string in the JSON — JSON has no bigint — and `fakeParse` restores it.
 */
export function fileContent(rows: readonly FileRow[], options: FileOptions = {}): string {
  return JSON.stringify({
    rows: rows.map((row) => ({
      postedDate: row.postedDate,
      valueDate: row.valueDate ?? null,
      amount: row.amount.toString(),
      description: row.description,
      counterparty: row.counterparty ?? null,
      bankReference: row.bankReference ?? null,
    })),
    closingBalance:
      options.closingBalance === undefined || options.closingBalance === null
        ? null
        : options.closingBalance.toString(),
    externalAccountId: options.externalAccountId ?? null,
  });
}

interface EncodedRow {
  readonly postedDate: string;
  readonly valueDate: string | null;
  readonly amount: string;
  readonly description: string;
  readonly counterparty: string | null;
  readonly bankReference: string | null;
}

/** Reads `fileContent` back into a `ParsedStatement`, standing in for a real parser. */
export const fakeParse: StatementParseFn = ({ raw }) => {
  const decoded = JSON.parse(new TextDecoder().decode(raw)) as {
    rows: EncodedRow[];
    closingBalance: string | null;
    externalAccountId: string | null;
  };
  return {
    rows: decoded.rows.map((row) => ({
      postedDate: row.postedDate,
      valueDate: row.valueDate,
      amount: BigInt(row.amount),
      description: row.description,
      counterparty: row.counterparty,
      bankReference: row.bankReference,
    })),
    closingBalance: decoded.closingBalance === null ? null : BigInt(decoded.closingBalance),
    externalAccountId: decoded.externalAccountId,
  } satisfies ParsedStatement;
};

/** A parser that always fails, for the `failed` lifecycle branch. */
export function throwingParse(message: string): StatementParseFn {
  return () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// The queue seam, installed per test
// ---------------------------------------------------------------------------

/** A logger that swallows everything — the suites assert on rows, not on log lines. */
export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Reading back what an import produced
// ---------------------------------------------------------------------------

export interface StoredLine {
  readonly fingerprint: string;
  readonly occurrence_index: number;
  readonly posted_date: string;
  readonly amount_minor: bigint;
  readonly description: string;
  readonly counterparty: string | null;
  readonly import_id: Buffer | null;
}

export async function linesOf(db: Kysely<DB>, bankAccountId: Buffer): Promise<StoredLine[]> {
  return db
    .selectFrom('bank_statement_lines')
    .select([
      'fingerprint',
      'occurrence_index',
      'posted_date',
      'amount_minor',
      'description',
      'counterparty',
      'import_id',
    ])
    .where('bank_account_id', '=', bankAccountId)
    .orderBy('fingerprint')
    .orderBy('occurrence_index')
    .execute();
}

export interface ImportRecord {
  readonly status: string;
  readonly lines_read: number | null;
  readonly lines_duplicate: number | null;
  readonly failure_reason: string | null;
  readonly closing_balance_minor: bigint | null;
  readonly external_account_id: string | null;
}

export async function importOf(
  db: Kysely<DB>,
  importId: string,
): Promise<ImportRecord | undefined> {
  return db
    .selectFrom('bank_statement_imports')
    .select([
      'status',
      'lines_read',
      'lines_duplicate',
      'failure_reason',
      'closing_balance_minor',
      'external_account_id',
    ])
    .where('id', '=', uuidToBuffer(importId))
    .executeTakeFirst();
}

/**
 * A stored line as a comparable string, including the supplementary fields.
 *
 * Not just `fingerprint:occurrence`, but the counterparty and amount too, so that the
 * shuffle-invariance property proves the *whole* stored row is the same under a
 * permutation — including which counterparty landed at which occurrence when two rows
 * share a fingerprint but differ in it.
 */
export function lineKey(line: StoredLine): string {
  return [
    line.fingerprint,
    line.occurrence_index,
    line.amount_minor.toString(),
    line.description,
    line.counterparty,
  ].join('|');
}
