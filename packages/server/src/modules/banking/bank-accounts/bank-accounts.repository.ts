import { BANKING_RESOURCES } from '@openbooks/shared-types';
import type { BankAccount, ListBankAccountsQuery } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../../db';
import { InternalError } from '../../../errors';

/**
 * Data access for `bank_accounts` (OB-084; ROADMAP D-46).
 *
 * The read/create surface the banking transport needs and that no earlier wave built:
 * waves 1–3 only ever *read* a bank account by id to validate an import, a clearing or
 * a session against it, so the register/list/get/update surface arrives here with the
 * routes. Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate — a cross-org id is a miss, not a leak
 * (E9), and the service's `assertFound` turns the miss into the one 404 it may produce.
 */

export const BANK_ACCOUNT_RESOURCE = BANKING_RESOURCES.BANK_ACCOUNT;

/**
 * The token a register request answers with when its `accountId` names no ledger
 * account (A7, E9). `'account'` is the chart module's own token, restated so a client
 * branches on one spelling whichever module answered.
 */
export const LEDGER_ACCOUNT_RESOURCE = 'account';

const BANK_ACCOUNT_COLUMNS = [
  'id',
  'account_id',
  'name',
  'institution_name',
  'external_account_id',
  'feed_source',
  'is_active',
  'created_at',
  'updated_at',
] as const;

interface BankAccountRow {
  readonly id: Buffer;
  readonly account_id: Buffer;
  readonly name: string;
  readonly institution_name: string | null;
  readonly external_account_id: string | null;
  readonly feed_source: 'file';
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewBankAccountRow {
  readonly accountId: Buffer;
  readonly name: string;
  readonly institutionName: string | null;
  readonly externalAccountId: string | null;
}

/**
 * `accountId` is absent: a bank account never repoints at a different ledger account
 * (`updateBankAccountRequestSchema` argues why), so there is no shape to change it.
 * `null` clears a nullable text field, `undefined` leaves it.
 */
export interface BankAccountPatch {
  readonly name?: string;
  readonly institutionName?: string | null;
  readonly externalAccountId?: string | null;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

export function bankAccountIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

/** The ledger account's id if it exists in this org, for the register pre-check's `assertFound`. */
export async function selectLedgerAccountId(
  db: TenantDatabase,
  id: Buffer,
): Promise<Buffer | undefined> {
  const row = await db.selectFrom('accounts').select('id').where('id', '=', id).executeTakeFirst();
  return row?.id;
}

export async function insertBankAccount(
  db: TenantDatabase,
  input: NewBankAccountRow,
): Promise<BankAccountRow> {
  const id = newUuidBuffer();

  await db
    .insertInto('bank_accounts')
    .values({
      id,
      account_id: input.accountId,
      name: input.name,
      institution_name: input.institutionName,
      external_account_id: input.externalAccountId,
    })
    .execute();

  const row = await selectBankAccountById(db, id);
  if (row === undefined) {
    throw new InternalError('The bank account inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectBankAccountById(
  db: TenantDatabase,
  id: Buffer,
): Promise<BankAccountRow | undefined> {
  return db
    .selectFrom('bank_accounts')
    .select(BANK_ACCOUNT_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function updateBankAccountRow(
  db: TenantDatabase,
  id: Buffer,
  patch: BankAccountPatch,
): Promise<void> {
  await db
    .updateTable('bank_accounts')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.institutionName === undefined ? {} : { institution_name: patch.institutionName }),
      ...(patch.externalAccountId === undefined
        ? {}
        : { external_account_id: patch.externalAccountId }),
    })
    .where('id', '=', id)
    .execute();

  // The affected-row count is not consulted, for `updateAccountRow`'s reason: mysql2
  // reports zero affected on an UPDATE that changed nothing, so existence is
  // established by the caller's read instead.
}

/**
 * Flips `is_active` (OB-095). Its own function rather than a member of `BankAccountPatch`,
 * because the patch a human edit builds deliberately has no way to reach `is_active`
 * (its comment argues why) — deactivation is a distinct operation carrying a guard the
 * rename does not, so the two do not share a write path.
 */
export async function setBankAccountActiveRow(
  db: TenantDatabase,
  id: Buffer,
  isActive: boolean,
): Promise<void> {
  await db
    .updateTable('bank_accounts')
    .set({ is_active: isActive ? 1 : 0 })
    .where('id', '=', id)
    .execute();
}

/**
 * Whether this bank account carries an *open* reconciliation session (OB-095, deferred
 * from OB-084; E6, D-45). A session is open exactly when `state = 'in_progress'` — the
 * same condition the `open_marker` unique key generates from, so at most one such row can
 * exist per account (`reconciliation.repository.ts`).
 *
 * Read straight off `reconciliation_sessions` rather than reaching through the
 * reconciliation service: the guard is the bank-account deactivation's, so it lives with
 * the operation that makes it. `tenantDb` scopes the row to the caller's org before this
 * predicate is added, so a session in another org's account is invisible here — which is
 * correct, because a cross-org id has already resolved to no bank account and 404'd.
 */
export async function hasOpenReconciliationSession(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<boolean> {
  const row = await db
    .selectFrom('reconciliation_sessions')
    .select('id')
    .where('bank_account_id', '=', bankAccountId)
    .where('state', '=', 'in_progress')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * `(created_at, id)` — the default this API's lists use (D-21). `name` is what a user
 * would sort on and is editable, and a keyset over a mutable column silently drops the
 * rows that moved behind the cursor.
 */
const BANK_ACCOUNT_KEYSET: KeysetOrdering<BankAccountRow> = [
  instantKey('bank_accounts.created_at', (row) => row.created_at),
  uuidKey('bank_accounts.id', (row) => row.id),
];

export async function selectBankAccountsPage(
  db: TenantDatabase,
  filters: ListBankAccountsQuery,
  limit: number,
): Promise<KeysetPage<BankAccountRow>> {
  let query = db.selectFrom('bank_accounts').select(BANK_ACCOUNT_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  const rows = await applyKeyset(query, BANK_ACCOUNT_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, BANK_ACCOUNT_KEYSET, limit);
}

export function toBankAccount(row: BankAccountRow): BankAccount {
  return {
    id: bufferToUuid(row.id),
    accountId: bufferToUuid(row.account_id),
    name: row.name,
    institutionName: row.institution_name,
    externalAccountId: row.external_account_id,
    feedSource: row.feed_source,
    isActive: row.is_active !== 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
