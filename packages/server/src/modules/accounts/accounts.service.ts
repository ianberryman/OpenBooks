import type {
  Account,
  AccountPage,
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
import { resolvePageLimit } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';
import type { AccountPatch } from './accounts.repository';
import {
  ACCOUNT_RESOURCE as RESOURCE,
  accountIdBytes,
  accountReferencedError,
  deleteAccountRow,
  hasPostings,
  insertAccount,
  orgScope,
  selectAccountById,
  selectAccountByIdForUpdate,
  selectAccountsPage,
  toAccount,
  updateAccountRow,
} from './accounts.repository';
import {
  assertParentTypeMatches,
  deleteBlockedByChildrenError,
  hasChildren,
  reclassifyBlockedByChildrenError,
  resolveAssignableParent,
} from './hierarchy';

/**
 * The chart of accounts (OB-018, OB-035; spec §2.1).
 *
 * Read `index.ts` for the three decisions this module exists to record — hard
 * deletion, the immutable code, and the hierarchy rules — `hierarchy.ts` for the
 * rules themselves, and `packages/shared-types/src/accounts/accounts.ts` for the
 * wire contract.
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

/**
 * Creates one account, active, and optionally under a parent.
 *
 * `accounts.write` alone, not `accounts.write` plus `accounts.read`, even though
 * this returns the created row. Reading back what you just wrote is part of the
 * write — a caller who could create an account but not see the result would have to
 * guess its id — and requiring both would make every write role a read role for no
 * gain. The same reasoning covers `update`, `deactivate`, and `reactivate`.
 *
 * The transaction is what ties the parent's resolution to the insert. Between
 * validating the parent and writing the row, the parent could be deleted — and
 * `hierarchy.ts` holds a row lock on it precisely so that it cannot be, which is
 * only true if both statements are in the same transaction. It is opened
 * unconditionally rather than only when a parent is named: `TenantDatabase`
 * joins an ambient one (`transaction-scope.ts`), so the cost when there is
 * nothing to protect is one `BEGIN`.
 */
export async function createAccount(
  input: CreateAccountRequest,
  ctx: RequestContext,
): Promise<Account> {
  await requirePermission(ctx, 'accounts.write');
  const request = parseInput(createAccountRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const parentAccountId =
      request.parentAccountId === undefined || request.parentAccountId === null
        ? null
        : await resolveAssignableParent(
            trx,
            { id: null, type: request.type },
            request.parentAccountId,
          );

    const row = await insertAccount(trx, {
      code: request.code,
      name: request.name,
      type: request.type,
      normalBalance: request.normalBalance,
      parentAccountId,
      description: request.description ?? null,
    });

    return toAccount(row);
  });
}

export async function getAccount(accountId: string, ctx: RequestContext): Promise<Account> {
  await requirePermission(ctx, 'accounts.read');

  const db = orgScope(ctx);
  const id = assertFound(accountIdBytes(accountId), RESOURCE);

  return toAccount(assertFound(await selectAccountById(db, id), RESOURCE));
}

/**
 * One page of the chart of accounts, in code order (D-21, D-27).
 *
 * `resolvePageLimit` and not the parsed `limit`, even though the schema declares
 * the same bounds. The schema is a restatement for `openapi.json`'s benefit; the
 * function is the authority, and it has to be, because spec §12 puts an MCP tool
 * and the workflow engine on the same service with no schema in front of them.
 */
export async function listAccounts(
  query: ListAccountsQuery,
  ctx: RequestContext,
): Promise<AccountPage> {
  await requirePermission(ctx, 'accounts.read');
  const filters = parseInput(listAccountsQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectAccountsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toAccount), nextCursor: page.nextCursor };
}

/**
 * Updates the mutable fields of one account.
 *
 * ## Why `code` is not one of them (D-27)
 *
 * It is absent from `updateAccountRequestSchema` entirely, so sending it is a
 * `validation_failed` naming the field rather than a silent drop. The full
 * argument is on that schema; the short form is that a keyset ordering over a
 * mutable column drops rows without saying so, and the chart of accounts is
 * ordered by `code`.
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
 *
 * ## Re-parenting
 *
 * `parentAccountId: null` detaches the account and makes it top-level; a uuid
 * moves it, subject to the three rules in `hierarchy.ts`. The lock this path
 * already takes on the account is half of what makes the cycle check exact — the
 * other half is the lock `hierarchy.ts` takes walking up from the new parent, and
 * the two together are why "make A a child of B" and "make B a child of A" cannot
 * both succeed.
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

    const nextType = request.type ?? current.type;

    const parentAccountId =
      request.parentAccountId === undefined || request.parentAccountId === null
        ? request.parentAccountId
        : await resolveAssignableParent(trx, { id, type: nextType }, request.parentAccountId);

    // The invariant is that a parent and its children share a type, so a
    // reclassification has to be checked in both directions. Downwards always:
    // this account's children keep their own type and would stop agreeing with
    // it. Upwards only when the parent is being kept, because `parentAccountId`
    // above has already checked the pair against the new one.
    if (nextType !== current.type) {
      if (await hasChildren(trx, id)) throw reclassifyBlockedByChildrenError();
      if (request.parentAccountId === undefined && current.parent_account_id !== null) {
        await assertParentTypeMatches(trx, current.parent_account_id, nextType);
      }
    }

    const patch: AccountPatch = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.type === undefined ? {} : { type: request.type }),
      ...(request.normalBalance === undefined ? {} : { normalBalance: request.normalBalance }),
      ...(parentAccountId === undefined ? {} : { parentAccountId }),
      // `null` clears, absent leaves alone. `.nullish()` makes both expressible and
      // only `undefined` means "absent" — JSON has no way to send `undefined`, so a
      // client wanting to clear the field sends `null` and gets exactly that.
      ...(request.description === undefined ? {} : { description: request.description }),
      // Same three-valued patch as `description`: absent leaves the classification
      // alone, `null` returns the account to unclassified, a value sets it.
      ...(request.cashBasisRole === undefined ? {} : { cashBasisRole: request.cashBasisRole }),
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
 * `DELETE` on `journal_lines` (`0999_app_grants`) — an account that is referenced
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
 *
 * ## Why the children check needs the lock and the postings check does not
 *
 * `fk_accounts_parent` is `ON DELETE RESTRICT` too, so a parent account is
 * refused by the database exactly as a posted-to one is — with the same errno,
 * which the repository cannot use to say *which* reference it was. Two rules
 * would collapse into one message.
 *
 * The lock removes the ambiguity rather than a second query doing it. Both paths
 * that make an account a parent — `createAccount` and re-parenting — take a row
 * lock on the prospective parent, so holding that lock here means no child can
 * appear between the check and the delete, and errno 1451 is left meaning
 * postings and nothing else. Postings need no such treatment: journals are
 * append-only and the app user holds no `DELETE` on `journal_lines`, so a
 * posting's arrival is serialized by the same foreign key and answered with the
 * message the pre-check would have given.
 */
export async function deleteAccount(accountId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'accounts.write');

  const db = orgScope(ctx);

  await db.transaction(async (trx) => {
    const id = assertFound(accountIdBytes(accountId), RESOURCE);

    // Establishes existence, so deleting an account that never existed — or one
    // belonging to another org — is a 404 rather than a silent success.
    assertFound(await selectAccountByIdForUpdate(trx, id), RESOURCE);

    if (await hasPostings(trx, id)) throw accountReferencedError();
    if (await hasChildren(trx, id)) throw deleteBlockedByChildrenError();

    await deleteAccountRow(trx, id);
  });
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
      'the account you intended and reverse and re-post the affected entries; `name` and ' +
      '`description` remain editable, and `code` never was.',
  );
}
