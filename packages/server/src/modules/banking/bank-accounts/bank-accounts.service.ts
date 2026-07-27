import type {
  BankAccount,
  BankAccountPage,
  CreateBankAccountRequest,
  ListBankAccountsQuery,
  UpdateBankAccountRequest,
} from '@openbooks/shared-types';
import {
  BANKING_PRECONDITIONS,
  createBankAccountRequestSchema,
  listBankAccountsQuerySchema,
  updateBankAccountRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../../errors';
import { requirePermission } from '../../permissions';

import type { BankAccountPatch } from './bank-accounts.repository';
import {
  BANK_ACCOUNT_RESOURCE as RESOURCE,
  LEDGER_ACCOUNT_RESOURCE,
  bankAccountIdBytes,
  hasOpenReconciliationSession,
  insertBankAccount,
  orgScope,
  selectBankAccountById,
  selectBankAccountsPage,
  selectLedgerAccountId,
  setBankAccountActiveRow,
  toBankAccount,
  updateBankAccountRow,
} from './bank-accounts.repository';

/**
 * Bank accounts (OB-084; ROADMAP D-46).
 *
 * The thin read/create surface `bank-accounts.repository.ts` explains — built here
 * because the routes need a service to reach and no earlier wave wrote one. It follows
 * the register `accounts.service.ts` set: `requirePermission` first (before the payload
 * is parsed, so a caller without authority learns nothing about the shape); every
 * payload re-parsed with the shared schema because HTTP is not the only caller (spec
 * §12); a miss is `assertFound`, never a hand-written throw.
 *
 * ## The permission a bank account's writes take
 *
 * `banking.import` for register and update, `banking.read` for the reads. There is no
 * `banking.manage` in the catalog, and registering a bank account is the setup a
 * statement import needs — whoever imports is who sets up the account it imports into.
 * A dedicated key would be a catalog change, which is OB-089's to make, not this
 * ticket's; the routes name what the service enforces and nothing here re-checks it
 * (spec §5).
 *
 * ## Deactivate and reactivate (OB-095), and the guard between them
 *
 * `deactivateBankAccount` refuses an account with an *open* reconciliation session
 * (`bank_account_has_open_session`, a `412` — the AP register `refusals.ts` fixes): a
 * deactivated account accepts no new clearing (`bank_account_archived` on the import and
 * clearing paths), so a session still in flight would be stranded with nothing able to
 * settle its remaining lines. That guard is the business logic OB-084 deferred, which is
 * why the operation lands here rather than with the transport that first wanted it.
 * `reactivateBankAccount` is the counterpart and carries no such guard — for
 * `reactivateAccount`'s reason, deactivation cannot be a one-way door when the only other
 * exit, deletion, is one a referenced account never has.
 *
 * Both take `banking.import`, the code register and update already take: a bank account
 * is import setup, and whoever imports is who sets up the account they import into. There
 * is no hard delete — a bank account is referenced by every line, import and clearing it
 * has accumulated, and nothing a journal points at may vanish (D-16), so deactivation is
 * the removal a used account gets.
 */

/**
 * Registers an existing ledger account as a bank account (D-46).
 *
 * `accountId` names an account the org already has; the pre-check turns a bad id into
 * the chart module's own 404 rather than a foreign-key 500. Creating the ledger account
 * as a side effect is refused for D-23's reason — the chart is the org's, and a module
 * that invents accounts in it decides the org's chart on its behalf.
 *
 * The insert is inside a transaction so the account's existence and the child insert
 * commit together; `tenantDb` joins the ambient one (`transaction-scope.ts`), so the
 * cost when there is nothing to protect is one `BEGIN`.
 */
export async function createBankAccount(
  input: CreateBankAccountRequest,
  ctx: RequestContext,
): Promise<BankAccount> {
  await requirePermission(ctx, 'banking.import');
  const request = parseInput(createBankAccountRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const ledgerAccountId = assertFound(
      tryUuidToBuffer(request.accountId),
      LEDGER_ACCOUNT_RESOURCE,
    );
    // A ledger account that does not exist (or belongs to another org) is the chart
    // module's own 404, not a foreign-key 500 from the insert below.
    assertFound(await selectLedgerAccountId(trx, ledgerAccountId), LEDGER_ACCOUNT_RESOURCE);

    const row = await insertBankAccount(trx, {
      accountId: ledgerAccountId,
      name: request.name,
      institutionName: request.institutionName ?? null,
      externalAccountId: request.externalAccountId ?? null,
    });

    return toBankAccount(row);
  });
}

export async function getBankAccount(
  bankAccountId: string,
  ctx: RequestContext,
): Promise<BankAccount> {
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  const id = assertFound(bankAccountIdBytes(bankAccountId), RESOURCE);
  return toBankAccount(assertFound(await selectBankAccountById(db, id), RESOURCE));
}

/**
 * One page of the org's bank accounts, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`: the schema restates the bounds for
 * `openapi.json`, but the function is the authority, because spec §12 puts an MCP tool
 * and the workflow engine on the same service with no schema in front of them.
 */
export async function listBankAccounts(
  query: ListBankAccountsQuery,
  ctx: RequestContext,
): Promise<BankAccountPage> {
  await requirePermission(ctx, 'banking.read');
  const filters = parseInput(listBankAccountsQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectBankAccountsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toBankAccount), nextCursor: page.nextCursor };
}

/**
 * Updates the fields a human types: the name and the two bits of institution metadata.
 *
 * `accountId` and `isActive` are not in the request shape at all (see the schema), so
 * neither is reachable here — repointing at another ledger account would orphan every
 * cleared line, and deactivation is its own operation.
 */
export async function updateBankAccount(
  bankAccountId: string,
  input: UpdateBankAccountRequest,
  ctx: RequestContext,
): Promise<BankAccount> {
  await requirePermission(ctx, 'banking.import');
  const request = parseInput(updateBankAccountRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(bankAccountIdBytes(bankAccountId), RESOURCE);
  assertFound(await selectBankAccountById(db, id), RESOURCE);

  const patch: BankAccountPatch = {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.institutionName === undefined ? {} : { institutionName: request.institutionName }),
    ...(request.externalAccountId === undefined
      ? {}
      : { externalAccountId: request.externalAccountId }),
  };

  await updateBankAccountRow(db, id, patch);
  return toBankAccount(assertFound(await selectBankAccountById(db, id), RESOURCE));
}

/**
 * Takes a bank account out of circulation (OB-095; E6, D-45).
 *
 * Refused while a reconciliation session on the account is still open: deactivating would
 * leave that session unable ever to settle its remaining lines, because a deactivated
 * account accepts no new clearing (`bank_account_archived`). The read and the write share
 * a transaction so the check cannot go stale between them — `hasOpenReconciliationSession`
 * takes no lock, but `reconciliation_sessions` is the one table a session's state lives
 * in and its `open_marker` unique key means a concurrent open serializes on the same row
 * the reconciliation service already contends on (D-14); the worst a race yields is a
 * deactivation refused a moment early or an open session refused a moment late, never a
 * deactivated account with a live session.
 *
 * Idempotent: an already-inactive account with no open session is returned unchanged, the
 * way `deactivateAccount` is — a retry is a retry, not a conflict.
 */
export async function deactivateBankAccount(
  bankAccountId: string,
  ctx: RequestContext,
): Promise<BankAccount> {
  await requirePermission(ctx, 'banking.import');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(bankAccountIdBytes(bankAccountId), RESOURCE);
    assertFound(await selectBankAccountById(trx, id), RESOURCE);

    if (await hasOpenReconciliationSession(trx, id)) throw hasOpenSession();

    await setBankAccountActiveRow(trx, id, false);
    return toBankAccount(assertFound(await selectBankAccountById(trx, id), RESOURCE));
  });
}

/**
 * Returns a deactivated bank account to circulation (OB-095) — the counterpart to
 * `deactivateBankAccount`, and not optional for `reactivateAccount`'s reason: without it,
 * deactivating the wrong account would be a trap, since the account is referenced by its
 * ledger and cannot be deleted. No guard: an open session is a reason not to *leave*
 * circulation, never a reason not to re-enter it.
 */
export async function reactivateBankAccount(
  bankAccountId: string,
  ctx: RequestContext,
): Promise<BankAccount> {
  await requirePermission(ctx, 'banking.import');

  const db = orgScope(ctx);
  const id = assertFound(bankAccountIdBytes(bankAccountId), RESOURCE);
  assertFound(await selectBankAccountById(db, id), RESOURCE);

  await setBankAccountActiveRow(db, id, true);
  return toBankAccount(assertFound(await selectBankAccountById(db, id), RESOURCE));
}

/**
 * The refusal deactivation makes, spoken from banking's own vocabulary (`refusals.ts`)
 * rather than minted at the throw site — the discipline that keeps M4 from repeating
 * OB-092. The message is the reconciliation service's `hasOpenSession` reworded for the
 * account's point of view: there the open session is what blocks a *second* open, here it
 * is what blocks the *deactivation*, and the token is the same fact.
 */
function hasOpenSession(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.BANK_ACCOUNT_HAS_OPEN_SESSION,
    'This bank account has a reconciliation session open, so it cannot be deactivated: a ' +
      'deactivated account accepts no clearing, which would strand the session with lines it ' +
      'could never settle. Finalise or reopen-and-close the session first, then deactivate.',
  );
}
