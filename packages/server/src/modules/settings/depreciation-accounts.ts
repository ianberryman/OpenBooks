import type {
  AccountType,
  DepreciationAccounts,
  UpdateDepreciationAccountsRequest,
} from '@openbooks/shared-types';
import { updateDepreciationAccountsRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';

import type { DepreciationAccountsPatch } from './settings.repository';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  orgScope,
  selectDepreciationAccounts,
  selectNominatedAccount,
  upsertDepreciationAccounts,
} from './settings.repository';

/**
 * The org's default depreciation-account nominations (initiative L, OB-163…166;
 * ROADMAP D-115).
 *
 * Mirrors `discount-accounts.ts` verbatim — same file structure, same two
 * operations, same `resolveDepreciationAccount` a caller uses without
 * re-checking a permission — because D-115 makes this the same *kind* of
 * setting as the control accounts and the discount accounts: neither is
 * guessable from a chart-template code (D-23), and all three live in
 * `org_accounting_settings` for the reason that file's migration gives.
 *
 * ## Which side is which
 *
 * `expense`: the account each posted depreciation period **debits** — an
 * ordinary operating expense, beside every other one on the P&L.
 * `accumulated`: the account each posted period **credits** — an ordinary
 * `type: 'asset'` account with a credit balance rather than a contra flag,
 * `fixed-assets.repository.ts`'s own reasoning (the chart's `type` and
 * `normal_balance` are independent, `0002_ledger`).
 *
 * ## Why this is a *default*, and not the only place an asset's accounts come from
 *
 * A fixed asset may nominate its own accounts at registration
 * (`createFixedAssetRequestSchema`), and only falls back to these org-wide
 * defaults when it does not. That is the opposite of the control accounts,
 * which every document uses unconditionally — a business commonly runs several
 * depreciation-expense accounts (one per department, one per asset class) and
 * the org default exists for the common case where it does not need to, not as
 * the only path.
 */
export type DepreciationAccountSide = 'expense' | 'accumulated';

/** The account type each side must be (D-115). */
const REQUIRED_TYPE: Readonly<Record<DepreciationAccountSide, AccountType>> = {
  expense: 'expense',
  accumulated: 'asset',
};

export async function getDepreciationAccounts(
  ctx: RequestContext = getContext('getDepreciationAccounts()'),
): Promise<DepreciationAccounts> {
  await requirePermission(ctx, 'orgs.read');

  const row = await selectDepreciationAccounts(orgScope(ctx));

  return {
    depreciationExpenseAccountId:
      row.depreciationExpenseAccountId === null
        ? null
        : bufferToUuid(row.depreciationExpenseAccountId),
    accumulatedDepreciationAccountId:
      row.accumulatedDepreciationAccountId === null
        ? null
        : bufferToUuid(row.accumulatedDepreciationAccountId),
  };
}

/**
 * Nominates, repoints or clears a default depreciation account.
 *
 * `orgs.write`, not `fixed_assets.write` — `control-accounts.ts`'s own
 * reasoning: this decides where every future asset that leaves an account
 * unset will post, and the role that registers an asset is not the role that
 * decides the shape of the books.
 *
 * Not refused while an asset already depends on the previous nomination
 * (there is no way to ask that question — an asset that resolved a default at
 * registration stored the concrete id it resolved to, not "the default"), for
 * the same reason `updateControlAccounts` is not refused: a posted journal
 * names the account it posted to, by id, and nothing here could reach back and
 * change it even if it wanted to.
 */
export async function updateDepreciationAccounts(
  request: UpdateDepreciationAccountsRequest,
  ctx: RequestContext = getContext('updateDepreciationAccounts()'),
): Promise<DepreciationAccounts> {
  await requirePermission(ctx, 'orgs.write');
  const input = parseInput(updateDepreciationAccountsRequestSchema, request);

  return orgScope(ctx).transaction(async (trx) => {
    const patch: DepreciationAccountsPatch = {
      ...(input.depreciationExpenseAccountId === undefined
        ? {}
        : {
            depreciationExpenseAccountId: await resolveNomination(
              trx,
              'expense',
              input.depreciationExpenseAccountId,
            ),
          }),
      ...(input.accumulatedDepreciationAccountId === undefined
        ? {}
        : {
            accumulatedDepreciationAccountId: await resolveNomination(
              trx,
              'accumulated',
              input.accumulatedDepreciationAccountId,
            ),
          }),
    };

    await upsertDepreciationAccounts(trx, patch);

    return getDepreciationAccountsIn(trx);
  });
}

/**
 * The org's default account for one side, or a refusal that names the setting —
 * `resolveControlAccount`'s twin, called by `fixed-assets.service.ts` only when
 * a registration or an edit leaves the side unset.
 *
 * No permission check: the caller has already checked `fixed_assets.write`, and
 * a second key here would make registering an asset with no explicit account
 * require `orgs.read` too — a boundary nobody asked for.
 */
export async function resolveDepreciationAccount(
  db: TenantDatabase,
  side: DepreciationAccountSide,
): Promise<Buffer> {
  const settings = await selectDepreciationAccounts(db);
  const nominated =
    side === 'expense'
      ? settings.depreciationExpenseAccountId
      : settings.accumulatedDepreciationAccountId;

  if (nominated === null) throw notSetError(side);

  // Re-read rather than trust the nomination, matching `resolveControlAccount`:
  // `updateAccount` can change an account's `type` and `is_active` after it was
  // nominated.
  const account = await selectNominatedAccount(db, nominated);
  if (account === undefined || !account.isActive || account.type !== REQUIRED_TYPE[side]) {
    throw unusableError(side, bufferToUuid(nominated));
  }

  return nominated;
}

/** `getDepreciationAccounts` without the permission check, for use inside a write. */
async function getDepreciationAccountsIn(db: TenantDatabase): Promise<DepreciationAccounts> {
  const row = await selectDepreciationAccounts(db);

  return {
    depreciationExpenseAccountId:
      row.depreciationExpenseAccountId === null
        ? null
        : bufferToUuid(row.depreciationExpenseAccountId),
    accumulatedDepreciationAccountId:
      row.accumulatedDepreciationAccountId === null
        ? null
        : bufferToUuid(row.accumulatedDepreciationAccountId),
  };
}

/** Validates one nomination, or clears it — `resolveNomination`'s own shape in `control-accounts.ts`. */
async function resolveNomination(
  db: TenantDatabase,
  side: DepreciationAccountSide,
  accountId: string | null,
): Promise<Buffer | null> {
  if (accountId === null) return null;

  const bytes = assertFound(accountIdBytes(accountId), ACCOUNT_RESOURCE);
  const account = assertFound(await selectNominatedAccount(db, bytes), ACCOUNT_RESOURCE);

  if (account.type !== REQUIRED_TYPE[side]) {
    throw new PreconditionFailedError(
      side === 'expense'
        ? 'depreciation_expense_account_wrong_type'
        : 'accumulated_depreciation_account_wrong_type',
      `The default depreciation-${side} account must be of type ${JSON.stringify(REQUIRED_TYPE[side])}, ` +
        `and the nominated account is of type ${JSON.stringify(account.type)}. ${
          side === 'expense'
            ? 'Depreciation expense belongs on the P&L beside every other operating expense; ' +
              'nominating anything else would understate expenses with nothing in the trial ' +
              'balance to explain it.'
            : 'Accumulated depreciation is an ordinary asset/credit account (D-115); nominating ' +
              'anything else would post a real depreciation charge into the wrong section of the ' +
              'balance sheet with nothing to show it happened.'
        }`,
    );
  }

  if (!account.isActive) {
    throw new PreconditionFailedError(
      'account_inactive',
      `The nominated default depreciation-${side} account is deactivated, so nothing can post to ` +
        'it. Every asset registered with no account of its own would fail at the moment of ' +
        'registration rather than now. Reactivate the account, or nominate another.',
    );
  }

  return bytes;
}

function notSetError(side: DepreciationAccountSide): PreconditionFailedError {
  return new PreconditionFailedError(
    side === 'expense'
      ? 'depreciation_expense_account_not_set'
      : 'accumulated_depreciation_account_not_set',
    `This organization has not nominated a default depreciation-${side} account, and this asset ` +
      'did not name one of its own. Nominate one — any active ' +
      `${JSON.stringify(REQUIRED_TYPE[side])} account in this chart — in the organization's ` +
      'accounting settings, or name the account on this asset directly, and try again.',
  );
}

function unusableError(side: DepreciationAccountSide, accountId: string): PreconditionFailedError {
  return new PreconditionFailedError(
    side === 'expense'
      ? 'depreciation_expense_account_unusable'
      : 'accumulated_depreciation_account_unusable',
    `The account nominated as this organization's default depreciation-${side} account ` +
      `(${accountId}) is deactivated or is no longer of type ${JSON.stringify(REQUIRED_TYPE[side])}, ` +
      'so nothing may post to it. Reactivate it, restore its type, or nominate a different ' +
      'account — or name one directly on the asset. Periods already posted are unaffected.',
  );
}
