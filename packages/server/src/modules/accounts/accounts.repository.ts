import type {
  Account,
  AccountType,
  ListAccountsQuery,
  NormalBalance,
} from '@openbooks/shared-types';
import { ACCOUNT_CODE_MAX_LENGTH } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  isDuplicateEntryError,
  isStillReferencedError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  textKey,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { ConflictError, InternalError, PreconditionFailedError } from '../../errors';

/**
 * Data access for the chart of accounts.
 *
 * Everything here goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate (OB-013). That is what makes A7 a
 * property of the queries rather than of the service's care: a cross-org id
 * simply matches nothing, and the service's `assertFound` turns that into the one
 * error a miss is allowed to produce.
 *
 * The other job of this file is to make sure no driver error escapes it. MySQL
 * answers a duplicate code with errno 1062 and a delete of a referenced row with
 * errno 1451; both are the client's situation, not a fault, and both would
 * otherwise reach `toWireError` unrecognised and become an opaque 500.
 */

/**
 * The resource token every miss in this module reports (A7).
 *
 * Here rather than in the service because `hierarchy.ts` raises the same 404 for
 * an unresolvable parent, and two copies of the token are two things that can
 * drift — which for `NotFoundError` means two distinguishable answers to what has
 * to be one.
 */
export const ACCOUNT_RESOURCE = 'account';

/** The columns every read in this module selects, so one mapper covers them all. */
const ACCOUNT_COLUMNS = [
  'id',
  'code',
  'name',
  'type',
  'normal_balance',
  'parent_account_id',
  'description',
  'is_active',
  'created_at',
  'updated_at',
] as const;

interface AccountRow {
  readonly id: Buffer;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normal_balance: NormalBalance;
  readonly parent_account_id: Buffer | null;
  readonly description: string | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewAccountRow {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  readonly parentAccountId: Buffer | null;
  readonly description: string | null;
}

/**
 * `code` is absent: an account code is immutable once created (D-27), so there is
 * no shape here through which one could be changed. `null` on `parentAccountId`
 * detaches the account and makes it top-level.
 */
export interface AccountPatch {
  readonly name?: string;
  readonly type?: AccountType;
  readonly normalBalance?: NormalBalance;
  readonly parentAccountId?: Buffer | null;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

/**
 * The org-scoped handle for the current operation.
 *
 * The conversion this used to open-code now lives in `src/db/org-scope.ts`, which
 * arrived after OB-018 wrote the fourth copy of it. What stays here is only the
 * shape the rest of this module wants — a `TenantDatabase` from a context — so
 * that no function below takes an org as a parameter (spec §4).
 */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied account id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service can route a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A `400` here would be
 * a distinguishable answer for a class of ids, which is the shape A7 rules out —
 * the same argument `tryUuidToBuffer` makes in `src/db/uuid.ts`.
 */
export function accountIdBytes(accountId: string): Buffer | undefined {
  return tryUuidToBuffer(accountId);
}

export async function insertAccount(db: TenantDatabase, input: NewAccountRow): Promise<AccountRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('accounts')
      .values({
        id,
        code: input.code,
        name: input.name,
        type: input.type,
        normal_balance: input.normalBalance,
        description: input.description,
        parent_account_id: input.parentAccountId,
      })
      .execute();
  } catch (error) {
    throw translateDuplicateCode(error, input.code);
  }

  const row = await selectAccountById(db, id);
  if (row === undefined) {
    throw new InternalError('The account inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectAccountById(
  db: TenantDatabase,
  id: Buffer,
): Promise<AccountRow | undefined> {
  return db.selectFrom('accounts').select(ACCOUNT_COLUMNS).where('id', '=', id).executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * Used wherever a check has to survive a concurrent writer: the has-postings rule
 * in `updateAccount`, the ancestor walk in `hierarchy.ts`, and the delete path's
 * children check. `accounts` is in `0004_app_grants`'s mutable allowlist, so the
 * app user may take a locking read on it; the journal tables are not, which is
 * why nothing in this codebase locks a journal row.
 */
export async function selectAccountByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<AccountRow | undefined> {
  return db
    .selectFrom('accounts')
    .select(ACCOUNT_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * `(code, id)` — the order an accountant reads a chart in (D-27).
 *
 * OB-031 could not use it. `code` was editable then, and a keyset over a mutable
 * column drops rows silently: rename an account and it moves behind a cursor that
 * has already passed it, so it appears on no page. That list therefore shipped
 * ordered by `(created_at, id)`, which is safe and is not what anyone wants from
 * a chart of accounts. D-27 removed the obstacle rather than the requirement —
 * `code` is immutable, so this ordering is now as stable as that one was.
 *
 * `uq_accounts_org_code` is the covering index for it at no cost, because a
 * secondary index leaf carries the primary key: `(org_id, code)` is scanned in
 * `(org_id, code, id)` order, which is exactly the tuple the predicate compares.
 * The `(created_at, id)` ordering had no such index and sorted every page.
 *
 * Ordering is textual and case-insensitive, under the column's
 * `utf8mb4_0900_ai_ci` collation — `'1100'` sorts before `'900'`. That is a
 * property of codes, not a defect: a chart is numbered so that its lexical order
 * *is* its statement order, which is why real charts use fixed-width codes.
 */
const ACCOUNT_KEYSET: KeysetOrdering<AccountRow> = [
  textKey('accounts.code', (row) => row.code, ACCOUNT_CODE_MAX_LENGTH),
  uuidKey('accounts.id', (row) => row.id),
];

export async function selectAccountsPage(
  db: TenantDatabase,
  filters: ListAccountsQuery,
  limit: number,
): Promise<KeysetPage<AccountRow>> {
  let query = db.selectFrom('accounts').select(ACCOUNT_COLUMNS);

  if (filters.type !== undefined) query = query.where('type', '=', filters.type);
  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  // The filters go on first so the keyset predicate composes with them rather than
  // with a different result set: a page of "assets only" has to end where the next
  // page of "assets only" begins, not where the unfiltered list did.
  const rows = await applyKeyset(query, ACCOUNT_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, ACCOUNT_KEYSET, limit);
}

/**
 * No error translation here, unlike `insertAccount`.
 *
 * Nothing this statement can set is covered by a unique key — `code` left the
 * patch shape with D-27 — so `ER_DUP_ENTRY` is no longer reachable from an
 * update. The foreign key on `parent_account_id` is reachable in principle, and
 * deliberately is not caught: the service resolves the parent through `tenantDb`
 * and `assertFound` before reaching this line, so an errno 1452 here would mean
 * the row vanished between the two statements inside one transaction — a fault,
 * not a client's situation, and it should surface as one.
 */
export async function updateAccountRow(
  db: TenantDatabase,
  id: Buffer,
  patch: AccountPatch,
): Promise<void> {
  await db
    .updateTable('accounts')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.type === undefined ? {} : { type: patch.type }),
      ...(patch.normalBalance === undefined ? {} : { normal_balance: patch.normalBalance }),
      ...(patch.parentAccountId === undefined ? {} : { parent_account_id: patch.parentAccountId }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
    })
    .where('id', '=', id)
    .execute();

  /**
   * The affected-row count is deliberately not consulted.
   *
   * mysql2 does not set `CLIENT_FOUND_ROWS`, so an `UPDATE` that matches a row and
   * changes nothing — renaming an account to the name it already has — reports zero
   * affected rows, exactly like an `UPDATE` that matched nothing. Deriving "no such
   * account" from that count would 404 a request that succeeded. Existence is
   * established by the caller's read instead, which it performs anyway.
   */
}

/**
 * Deletes the row, or refuses because something references it.
 *
 * The refusal is the database's, not this function's. `journal_lines.account_id`
 * and `accounts.parent_account_id` are both `ON DELETE RESTRICT` (`0002_ledger`),
 * so a referenced account cannot be deleted no matter what any caller believes
 * about it — which is what makes the service's pre-check a *message* rather than a
 * guarantee. See `deleteAccount` for why that distinction is the whole argument
 * for allowing deletion at all.
 */
export async function deleteAccountRow(db: TenantDatabase, id: Buffer): Promise<void> {
  try {
    await db.deleteFrom('accounts').where('id', '=', id).execute();
  } catch (error) {
    if (!isStillReferencedError(error)) throw error;
    throw accountReferencedError();
  }
}

/**
 * The ids of the accounts whose parent is one of `parentIds`.
 *
 * One level, not a subtree, and the caller iterates. A recursive CTE would read
 * better and cannot be written here: `TenantDatabase` exposes the four statement
 * builders and nothing else, so a `WITH RECURSIVE` would need the raw handle —
 * which is the path spec §4 requires not to exist. Iterating is bounded by
 * `ACCOUNT_MAX_DEPTH` anyway, so the CTE would buy a constant factor, not an
 * asymptote.
 *
 * Reads `idx_accounts_org_parent` (`0002_ledger`), which exists for this query
 * and for the delete path's `RESTRICT` check.
 */
export async function selectChildIds(
  db: TenantDatabase,
  parentIds: readonly Buffer[],
): Promise<readonly Buffer[]> {
  if (parentIds.length === 0) return [];

  const rows = await db
    .selectFrom('accounts')
    .select('id')
    .where('parent_account_id', 'in', parentIds)
    .execute();

  return rows.map((row) => row.id);
}

/**
 * Whether any journal line names this account.
 *
 * Existence, not a count: nothing needs the number, and `SELECT 1 … LIMIT 1`
 * stops at the first match on `idx_journal_lines_org_account` instead of scanning
 * every line an account has accumulated.
 */
export async function hasPostings(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('journal_lines')
    .select('id')
    .where('account_id', '=', id)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * The one error a referenced account produces, from both the pre-check and the
 * `RESTRICT` backstop, so the two cannot drift into two different messages for the
 * same situation.
 *
 * `PreconditionFailedError` and not `ConflictError`: the request is well-formed
 * and permitted, and it is the *state* that forbids it. `precondition` is a stable
 * token, so a client branches on `account_has_postings` rather than on prose.
 */
export function accountReferencedError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_has_postings',
    'This account is referenced by at least one journal line and cannot be deleted. Deleting ' +
      'it would remove an account the ledger still points at. Deactivate it instead: an ' +
      'inactive account keeps its history and cannot be selected for new postings.',
  );
}

export function toAccount(row: AccountRow): Account {
  return {
    id: bufferToUuid(row.id),
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
    parentAccountId: row.parent_account_id === null ? null : bufferToUuid(row.parent_account_id),
    description: row.description,
    isActive: row.is_active !== 0,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants and this is a lossless
    // rendering of one.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `uq_accounts_org_code` as a `ConflictError`.
 *
 * Free text is permitted on a conflict, unlike on a 404, and the reason is in
 * `src/errors/errors.ts`: the unique key is `(org_id, code)`, so the row this
 * collides with is inside the caller's own org and naming the code discloses
 * nothing they cannot already read. The same code in a different org is a
 * different key and is not a conflict at all.
 *
 * Any other driver error is rethrown untouched and becomes an opaque 500, which
 * is correct — this function knows about exactly one constraint and must not
 * guess about the rest.
 */
function translateDuplicateCode(error: unknown, code: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `An account with code ${JSON.stringify(code)} already exists in this organization. Codes ` +
      'are compared case-insensitively, so a code differing only in case is the same code. A ' +
      'code cannot be changed once created, so this one has to be picked at creation.',
    { code },
  );
}
