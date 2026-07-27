import type {
  BankAccount,
  BankAccountPage,
  CreateBankAccountRequest,
  ListBankAccountsQuery,
  UpdateBankAccountRequest,
} from '@openbooks/shared-types';
import {
  createBankAccountRequestSchema,
  listBankAccountsQuerySchema,
  updateBankAccountRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { assertFound, parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';

import type { BankAccountPatch } from './bank-accounts.repository';
import {
  BANK_ACCOUNT_RESOURCE as RESOURCE,
  LEDGER_ACCOUNT_RESOURCE,
  bankAccountIdBytes,
  insertBankAccount,
  orgScope,
  selectBankAccountById,
  selectBankAccountsPage,
  selectLedgerAccountId,
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
 * ## What is not here, and why
 *
 * No `deactivate`/`reactivate`, and so no way to flip `isActive` yet. `bankAccountSchema`
 * returns it and the import and clearing services already refuse a deactivated account
 * (`bank_account_archived`), so deactivation is a real intended state — but the
 * operation that reaches it has to refuse an account with an open reconciliation
 * session (`bank_account_has_open_session`, declared in `refusals.ts`), and that guard
 * is business logic this transport ticket is not the place to design. A newly
 * registered account is active and stays active until that operation lands.
 *
 * No hard delete: a bank account is referenced by every line, import and clearing it
 * has accumulated, and nothing a journal points at may vanish (D-16) — deactivation is
 * the removal a used account gets, once it exists.
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
