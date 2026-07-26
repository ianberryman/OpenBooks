import type {
  Account,
  AccountType,
  ListAccountsQuery,
  NormalBalance,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import {
  bufferToUuid,
  isUuid,
  newUuidBuffer,
  tenantDb,
  tryUuidToBuffer,
  uuidToBuffer,
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

/** mysql2 `errno` for `ER_DUP_ENTRY` — a unique index rejected the row. */
const DUPLICATE_ENTRY_ERRNO = 1062;

/**
 * mysql2 `errno` for `ER_ROW_IS_REFERENCED_2` — a foreign key with `ON DELETE
 * RESTRICT` refused the delete.
 */
const ROW_IS_REFERENCED_ERRNO = 1451;

/** The columns every read in this module selects, so one mapper covers them all. */
const ACCOUNT_COLUMNS = [
  'id',
  'code',
  'name',
  'type',
  'normal_balance',
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
  readonly description: string | null;
}

export interface AccountPatch {
  readonly code?: string;
  readonly name?: string;
  readonly type?: AccountType;
  readonly normalBalance?: NormalBalance;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

/**
 * The org-scoped handle for the current operation.
 *
 * `ctx.orgId` is a UUID string and `tenantDb` takes the `BINARY(16)` form, so the
 * conversion happens here. A malformed one is an `InternalError`, not a
 * `ValidationError`: the context is host-built from a session or an API key, so a
 * non-UUID org id is a wiring bug in whoever opened the scope and not something a
 * caller could have sent. This is the same reasoning — and the third copy of the
 * same six lines — as `src/modules/idempotency/ids.ts` and
 * `permissions.repository.ts`. It wants to be `orgScope(ctx)` in `src/db/`; that
 * module is not this ticket's to edit, and the note is in the OB-018 report.
 */
export function orgScope(ctx: RequestContext): TenantDatabase {
  if (!isUuid(ctx.orgId)) {
    throw new InternalError(
      'Request context carries an orgId that is not a UUID; the context was built from an ' +
        'untrusted value or the wrong field.',
    );
  }
  return tenantDb(uuidToBuffer(ctx.orgId));
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
        // Written explicitly rather than left to the column's implicit NULL. The
        // column ships in M1 and the API does not accept it (see the decision
        // block in `packages/shared-types/src/accounts/accounts.ts`), so stating
        // the value makes the omission a fact of the write path. `Insertable`
        // requires it anyway, which is the schema helping.
        parent_account_id: null,
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
 * Only `updateAccount` uses it, and only because it has a check to protect — see
 * the has-postings commentary there. `accounts` is in `0004_app_grants`'s mutable
 * allowlist, so the app user may take a locking read on it; the journal tables are
 * not, which is why nothing in this codebase locks a journal row.
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
 * Ordered by `code`, which is a lexical sort and not a numeric one.
 *
 * That is the right answer for a chart of accounts rather than a limitation:
 * codes are strings (`1000`, `1000-A`, `COGS`) and the convention that makes them
 * useful is fixed width, under which lexical and numeric order agree. Sorting
 * numerically would need a parse that fails on every non-numeric code.
 */
export async function selectAccounts(
  db: TenantDatabase,
  filters: ListAccountsQuery,
): Promise<readonly AccountRow[]> {
  let query = db.selectFrom('accounts').select(ACCOUNT_COLUMNS);

  if (filters.type !== undefined) query = query.where('type', '=', filters.type);
  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  return query.orderBy('code', 'asc').execute();
}

export async function updateAccountRow(
  db: TenantDatabase,
  id: Buffer,
  patch: AccountPatch,
): Promise<void> {
  try {
    await db
      .updateTable('accounts')
      .set({
        ...(patch.code === undefined ? {} : { code: patch.code }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.type === undefined ? {} : { type: patch.type }),
        ...(patch.normalBalance === undefined ? {} : { normal_balance: patch.normalBalance }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
      })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateDuplicateCode(error, patch.code);
  }

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
    if (!hasErrno(error, ROW_IS_REFERENCED_ERRNO)) throw error;
    throw accountReferencedError();
  }
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
function translateDuplicateCode(error: unknown, code: string | undefined): unknown {
  if (!hasErrno(error, DUPLICATE_ENTRY_ERRNO)) return error;

  const named = code === undefined ? 'that code' : `code ${JSON.stringify(code)}`;
  return new ConflictError(
    `An account with ${named} already exists in this organization. Codes are compared ` +
      'case-insensitively, so a code differing only in case is the same code.',
    code === undefined ? undefined : { code },
  );
}

function hasErrno(error: unknown, errno: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { readonly errno?: unknown }).errno === errno
  );
}
