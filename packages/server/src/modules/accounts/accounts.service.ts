import type {
  Account,
  AccountList,
  CreateAccountRequest,
  ListAccountsQuery,
  UpdateAccountRequest,
} from '@openbooks/shared-types';
import {
  createAccountRequestSchema,
  listAccountsQuerySchema,
  updateAccountRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { assertFound, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';
import type { AccountPatch } from './accounts.repository';
import {
  accountIdBytes,
  accountReferencedError,
  deleteAccountRow,
  hasPostings,
  insertAccount,
  orgScope,
  selectAccountById,
  selectAccountByIdForUpdate,
  selectAccounts,
  toAccount,
  updateAccountRow,
} from './accounts.repository';
import { parseInput } from './input';

/**
 * The chart of accounts (OB-018; spec §2.1).
 *
 * Read `index.ts` for the two decisions this module exists to record — hard
 * deletion, and `parent_account_id` — and
 * `packages/shared-types/src/accounts/accounts.ts` for the wire contract.
 *
 * Three things are uniform across every operation below and stated once here
 * rather than at each:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else; validating first would tell
 *    them which fields the operation accepts and how long each may be, which is a
 *    description of an API surface they are not entitled to. Enforcement is
 *    service-layer only (spec §2.4, §5) — no route may repeat or replace it.
 *
 * 2. **Every payload is parsed with a shared zod schema**, because the HTTP route
 *    is not the only caller (spec §12; see `input.ts`).
 *
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined the read to the context's org, so a cross-org id returns no
 *    row and reaches the same line a nonexistent id reaches (A7). There is no
 *    branch here that can tell the two apart, which is why there is no branch here
 *    that could leak the difference.
 */

/** The resource token for `NotFoundError`. Validated as an identifier by the class. */
const RESOURCE = 'account';

/**
 * Creates one account, active.
 *
 * `accounts.write` alone, not `accounts.write` plus `accounts.read`, even though
 * this returns the created row. Reading back what you just wrote is part of the
 * write — a caller who could create an account but not see the result would have to
 * guess its id — and requiring both would make every write role a read role for no
 * gain. The same reasoning covers `update`, `deactivate`, and `reactivate`.
 */
export async function createAccount(
  input: CreateAccountRequest,
  ctx: RequestContext,
): Promise<Account> {
  await requirePermission(ctx, 'accounts.write');
  const request = parseInput(createAccountRequestSchema, input);

  const row = await insertAccount(orgScope(ctx), {
    code: request.code,
    name: request.name,
    type: request.type,
    normalBalance: request.normalBalance,
    description: request.description ?? null,
  });

  return toAccount(row);
}

export async function getAccount(accountId: string, ctx: RequestContext): Promise<Account> {
  await requirePermission(ctx, 'accounts.read');

  const db = orgScope(ctx);
  const id = assertFound(accountIdBytes(accountId), RESOURCE);

  return toAccount(assertFound(await selectAccountById(db, id), RESOURCE));
}

export async function listAccounts(
  query: ListAccountsQuery,
  ctx: RequestContext,
): Promise<AccountList> {
  await requirePermission(ctx, 'accounts.read');
  const filters = parseInput(listAccountsQuerySchema, query);

  const rows = await selectAccounts(orgScope(ctx), filters);
  return { accounts: rows.map(toAccount) };
}

/**
 * Updates the mutable fields of one account.
 *
 * ## Why `type` and `normalBalance` are refused once the account has postings
 *
 * Those two fields are not labels, they are what every report means. `type`
 * decides whether an amount lands on the P&L or the balance sheet and
 * `normalBalance` decides its sign, so changing either on an account that has been
 * posted to silently restates history: last quarter's profit changes, and a filed
 * return stops reconciling to the ledger that produced it. That is the property
 * ROADMAP D-16 refuses to give up for transactions, and an account's type is a
 * cheaper way to lose it than editing a journal — no journal row changes, so
 * nothing in the append-only apparatus notices.
 *
 * The counter-argument is that a typo then cannot be fixed. It can: before the
 * first posting, freely; after it, by creating the account that was meant and
 * reversing and re-posting, which is the same answer the ledger gives to every
 * other mistake. An account with no postings has never appeared in the books, so
 * there is nothing to restate and the change is ordinary configuration.
 *
 * ## Why the check is taken under a row lock
 *
 * Read-then-check-then-write on data another transaction can change is a check
 * that only appears to hold, and unlike the delete path there is no foreign key to
 * fall back on — nothing in the schema ties an account's `type` to the lines that
 * reference it. So the read takes `FOR UPDATE`, and a concurrent posting's own
 * foreign-key check needs a shared lock on the same `accounts` row to insert its
 * line. The two therefore serialize, and the guarantee becomes exact rather than
 * probable: either the posting lands first and the type change is refused, or the
 * type change commits and the posting is made against the account as changed.
 * Neither order produces a posting that predates a change to its account's
 * meaning.
 */
export async function updateAccount(
  accountId: string,
  input: UpdateAccountRequest,
  ctx: RequestContext,
): Promise<Account> {
  await requirePermission(ctx, 'accounts.write');
  const request = parseInput(updateAccountRequestSchema, input);

  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const id = assertFound(accountIdBytes(accountId), RESOURCE);
    const current = assertFound(await selectAccountByIdForUpdate(trx, id), RESOURCE);

    // Compared against the current value rather than merely being present, so
    // re-sending an account's existing type is the no-op it looks like rather than
    // a refusal.
    const restatesHistory =
      (request.type !== undefined && request.type !== current.type) ||
      (request.normalBalance !== undefined && request.normalBalance !== current.normal_balance);

    if (restatesHistory && (await hasPostings(trx, id))) {
      throw accountTypeLockedError();
    }

    const patch: AccountPatch = {
      ...(request.code === undefined ? {} : { code: request.code }),
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.type === undefined ? {} : { type: request.type }),
      ...(request.normalBalance === undefined ? {} : { normalBalance: request.normalBalance }),
      // `null` clears, absent leaves alone. `.nullish()` makes both expressible and
      // only `undefined` means "absent" — JSON has no way to send `undefined`, so a
      // client wanting to clear the field sends `null` and gets exactly that.
      ...(request.description === undefined ? {} : { description: request.description }),
    };

    await updateAccountRow(trx, id, patch);
    return toAccount(assertFound(await selectAccountById(trx, id), RESOURCE));
  });
}

/**
 * Removes an account from circulation without removing it from the books.
 *
 * This is the only form of removal available to an account that has been posted
 * to, and it is the operation the delete path's error names. Idempotent: an
 * already-inactive account is returned unchanged rather than refused, because a
 * retry of a deactivation is a retry, not a conflict.
 */
export async function deactivateAccount(accountId: string, ctx: RequestContext): Promise<Account> {
  return setActive(accountId, false, ctx);
}

/**
 * The counterpart to `deactivateAccount`, and not an optional convenience.
 *
 * Without it, deactivation is a one-way door: the only other way out would be to
 * delete the account, which is exactly what a posted account cannot do. An org
 * that deactivated the wrong row would be left with an account it can neither use
 * nor remove, and — because `uq_accounts_org_code` does not exclude inactive rows
 * — could not recreate it under the same code either. Reactivation costs one
 * operation and removes a trap.
 */
export async function reactivateAccount(accountId: string, ctx: RequestContext): Promise<Account> {
  return setActive(accountId, true, ctx);
}

/**
 * Deletes an account that has never been posted to.
 *
 * ## Why hard deletion is permitted at all
 *
 * ROADMAP D-16 settles that ledger entries are never deleted, and an account is
 * not a ledger entry. It is configuration: a name and a classification that
 * postings *refer* to. An account with no journal lines has never appeared in the
 * books, so deleting it removes nothing an auditor could ask about and no report
 * changes — there is no past date whose figures stop reproducing, which is the
 * property D-16 exists to protect.
 *
 * Refusing outright was the alternative and it has a real cost. Deactivation is
 * not equivalent, because `uq_accounts_org_code` applies to inactive rows too: an
 * org that mistyped `1000` while setting up their chart would carry that row and
 * that code forever, and the only way to hold the code they wanted would be to
 * pick a different one. Onboarding is where accounts are created wrongly and where
 * nothing has been posted yet — precisely the case where deletion is safe — so
 * forbidding it would put the friction exactly where the risk is not.
 *
 * ## Why the pre-check is not what makes this safe
 *
 * `hasPostings` runs before the delete so the caller gets an actionable message
 * naming deactivation, and its answer can be stale the moment it returns: a
 * posting can arrive between the check and the delete. It cannot be stale in the
 * other direction, because journals are append-only and the app user holds no
 * `DELETE` on `journal_lines` (`0004_app_grants`) — an account that is referenced
 * stays referenced, permanently.
 *
 * What closes the window is `ON DELETE RESTRICT` on `journal_lines.account_id`.
 * InnoDB takes a shared lock on the parent `accounts` row to validate the child
 * insert and this statement needs an exclusive one, so the two serialize: whichever
 * commits second fails — the delete with errno 1451, or the posting with errno
 * 1452 — and a journal line can never end up pointing at a row that is gone. The
 * database refuses regardless of what this service concluded, which is the only
 * reason a check-then-act is acceptable here. `deleteAccountRow` translates the
 * 1451 into the same error the pre-check raises, so the race is invisible to the
 * caller rather than being a different failure.
 *
 * Deliberately no cascade and no "delete and reassign its postings": both are ways
 * for a chart of accounts to lose entries quietly, which is the failure this
 * ticket names.
 */
export async function deleteAccount(accountId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'accounts.write');

  const db = orgScope(ctx);
  const id = assertFound(accountIdBytes(accountId), RESOURCE);

  // Establishes existence, so deleting an account that never existed — or one
  // belonging to another org — is a 404 rather than a silent success.
  assertFound(await selectAccountById(db, id), RESOURCE);

  if (await hasPostings(db, id)) throw accountReferencedError();

  await deleteAccountRow(db, id);
}

async function setActive(
  accountId: string,
  isActive: boolean,
  ctx: RequestContext,
): Promise<Account> {
  await requirePermission(ctx, 'accounts.write');

  const db = orgScope(ctx);
  const id = assertFound(accountIdBytes(accountId), RESOURCE);
  assertFound(await selectAccountById(db, id), RESOURCE);

  await updateAccountRow(db, id, { isActive });
  return toAccount(assertFound(await selectAccountById(db, id), RESOURCE));
}

/**
 * Shares `accountReferencedError`'s `account_has_postings` token and carries its
 * own message.
 *
 * The token is the machine-readable fact — this account has postings — and it is
 * the same fact in both cases, so a client branching on it does not have to learn
 * two names for one state. The prose differs because the remedies do: a delete is
 * answered with "deactivate instead", a reclassification with "create the account
 * you meant". Splitting the token instead would put the difference in the part of
 * the contract that `src/errors/codes.ts` says is never renamed.
 */
function accountTypeLockedError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_has_postings',
    'This account has postings, so its type and normal balance are fixed. Changing either ' +
      'would restate what past reports said about entries that have already been made. Create ' +
      'the account you intended and reverse and re-post the affected entries; `code`, `name`, ' +
      'and `description` remain editable.',
  );
}
