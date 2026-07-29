import type {
  AccountType,
  DiscountAccounts,
  UpdateDiscountAccountsRequest,
} from '@openbooks/shared-types';
import { updateDiscountAccountsRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';

import type { DiscountAccountsPatch } from './settings.repository';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  orgScope,
  selectDiscountAccounts,
  selectNominatedAccount,
  upsertDiscountAccounts,
} from './settings.repository';

/**
 * The org's early-pay discount nominations (OB-136; ROADMAP D-106, D-107).
 *
 * Mirrors `control-accounts.ts` verbatim — same file structure, same two
 * operations, same `resolveDiscountAccount` a caller uses without re-checking a
 * permission — because D-107 makes the two the same *kind* of setting: neither
 * is guessable from a chart-template code (D-23), and both live in
 * `org_accounting_settings` for the reason that file's migration gives.
 *
 * ## Which side is which
 *
 * `given`: the account an early-pay discount **debits** when this org gives one
 * to a *customer* — the expense/contra-revenue side of D-106's journal (`debit
 * discount-given / credit AR control`). `received`: the account an early-pay
 * discount **credits** when a *vendor* gives one to this org — the AP mirror.
 * The names follow `0005_subledger`'s own column comments rather than
 * `receivable`/`payable`, because "given" and "received" are what a bookkeeper
 * calls the two sides of a discount and `receivable`/`payable` would suggest a
 * link to the two control accounts that does not exist — a discount posts
 * beside a control account, not through it.
 */
export type DiscountSide = 'given' | 'received';

/**
 * The account type each side must be.
 *
 * Not database-enforced — `0005_subledger`'s own comment on these two columns
 * gives the reason `tax_account_id` is not constrained either: MySQL cannot
 * express a CHECK that reads another table. Enforced here instead, mirroring
 * `resolveTaxAccount`'s refusal rather than leaving it unchecked: nominating a
 * revenue account as the *received* side, or an expense account as the *given*
 * side, would post a real discount into the wrong section of the P&L with
 * nothing refusing it and no sign until a statement is read.
 */
const REQUIRED_TYPE: Readonly<Record<DiscountSide, AccountType>> = {
  given: 'expense',
  received: 'revenue',
};

export async function getDiscountAccounts(
  ctx: RequestContext = getContext('getDiscountAccounts()'),
): Promise<DiscountAccounts> {
  await requirePermission(ctx, 'orgs.read');

  const row = await selectDiscountAccounts(orgScope(ctx));

  return {
    discountGivenAccountId:
      row.discountGivenAccountId === null ? null : bufferToUuid(row.discountGivenAccountId),
    discountReceivedAccountId:
      row.discountReceivedAccountId === null ? null : bufferToUuid(row.discountReceivedAccountId),
  };
}

/**
 * Nominates, repoints or clears a discount account.
 *
 * `orgs.write`, not `accounts.write` — `control-accounts.ts`'s own reasoning:
 * this decides where every future early-pay discount posts, and the role that
 * enters documents is not the role that decides the shape of the books.
 *
 * As with the control accounts, this does not touch a posted journal and
 * cannot — no column in `journals`/`journal_lines` is updatable by the app user
 * — and it is not refused while a discount already posted to the previous
 * account is outstanding, for the same reason: refusing would strand exactly
 * the org that nominated the wrong account and has already confirmed one.
 */
export async function updateDiscountAccounts(
  request: UpdateDiscountAccountsRequest,
  ctx: RequestContext = getContext('updateDiscountAccounts()'),
): Promise<DiscountAccounts> {
  await requirePermission(ctx, 'orgs.write');
  const input = parseInput(updateDiscountAccountsRequestSchema, request);

  return orgScope(ctx).transaction(async (trx) => {
    const patch: DiscountAccountsPatch = {
      ...(input.discountGivenAccountId === undefined
        ? {}
        : {
            discountGivenAccountId: await resolveNomination(
              trx,
              'given',
              input.discountGivenAccountId,
            ),
          }),
      ...(input.discountReceivedAccountId === undefined
        ? {}
        : {
            discountReceivedAccountId: await resolveNomination(
              trx,
              'received',
              input.discountReceivedAccountId,
            ),
          }),
    };

    await upsertDiscountAccounts(trx, patch);

    return getDiscountAccountsIn(trx);
  });
}

/**
 * The org's nominated account for one side, or a refusal that names the
 * setting — `resolveControlAccount`'s twin, called by the confirmed-discount
 * posting path (OB-138/D-106) exactly as that one is called by document
 * approval.
 *
 * No permission check: the caller has already checked the permission that
 * governs confirming the discount (`banking.match` for a clearing entry), and a
 * second key here would make confirming a discount require `orgs.read` — a
 * boundary nobody asked for.
 */
export async function resolveDiscountAccount(
  db: TenantDatabase,
  side: DiscountSide,
): Promise<Buffer> {
  const settings = await selectDiscountAccounts(db);
  const nominated =
    side === 'given' ? settings.discountGivenAccountId : settings.discountReceivedAccountId;

  if (nominated === null) throw notSetError(side);

  // Re-read rather than trust the nomination, matching `resolveControlAccount`:
  // `updateAccount` can change an account's `type` and `is_active` after it was
  // nominated, and `fk_oas_discount_given`/`fk_oas_discount_received` guarantee
  // only that the row exists and belongs to this org.
  const account = await selectNominatedAccount(db, nominated);
  if (account === undefined || !account.isActive || account.type !== REQUIRED_TYPE[side]) {
    throw unusableError(side, bufferToUuid(nominated));
  }

  return nominated;
}

/** `getDiscountAccounts` without the permission check, for use inside a write. */
async function getDiscountAccountsIn(db: TenantDatabase): Promise<DiscountAccounts> {
  const row = await selectDiscountAccounts(db);

  return {
    discountGivenAccountId:
      row.discountGivenAccountId === null ? null : bufferToUuid(row.discountGivenAccountId),
    discountReceivedAccountId:
      row.discountReceivedAccountId === null ? null : bufferToUuid(row.discountReceivedAccountId),
  };
}

/**
 * Validates one nomination, or clears it — `resolveNomination`'s own shape in
 * `control-accounts.ts`.
 */
async function resolveNomination(
  db: TenantDatabase,
  side: DiscountSide,
  accountId: string | null,
): Promise<Buffer | null> {
  if (accountId === null) return null;

  const bytes = assertFound(accountIdBytes(accountId), ACCOUNT_RESOURCE);
  const account = assertFound(await selectNominatedAccount(db, bytes), ACCOUNT_RESOURCE);

  if (account.type !== REQUIRED_TYPE[side]) {
    throw new PreconditionFailedError(
      side === 'given'
        ? 'discount_given_account_wrong_type'
        : 'discount_received_account_wrong_type',
      `The discount-${side} account must be of type ${JSON.stringify(REQUIRED_TYPE[side])}, and ` +
        `the nominated account is of type ${JSON.stringify(account.type)}. ${
          side === 'given'
            ? 'A discount this org gives a customer for paying early reduces what it recognised ' +
              'on the sale, which belongs beside the other selling expenses; nominating anything ' +
              'else would post a real discount into the wrong section of the P&L with nothing ' +
              'to show it happened.'
            : 'A discount a vendor gives this org for paying early is income earned on the ' +
              'purchase, which belongs beside revenue; nominating anything else would understate ' +
              'the saving with nothing in the trial balance to explain it.'
        }`,
    );
  }

  if (!account.isActive) {
    throw new PreconditionFailedError(
      'account_inactive',
      `The nominated discount-${side} account is deactivated, so nothing can post to it. Every ` +
        'confirmed early-pay discount would fail at the moment somebody was clearing a deposit ' +
        'rather than now. Reactivate the account, or nominate another.',
    );
  }

  return bytes;
}

function notSetError(side: DiscountSide): PreconditionFailedError {
  return new PreconditionFailedError(
    side === 'given' ? 'discount_given_account_not_set' : 'discount_received_account_not_set',
    `This organization has not nominated a discount-${side} account, and confirming ${
      side === 'given' ? 'a discount given to a customer' : 'a discount received from a vendor'
    } posts to it. Nominate one — any active ${JSON.stringify(REQUIRED_TYPE[side])} account in ` +
      `this chart — in the organization's accounting settings, and try again.`,
  );
}

function unusableError(side: DiscountSide, accountId: string): PreconditionFailedError {
  return new PreconditionFailedError(
    side === 'given' ? 'discount_given_account_unusable' : 'discount_received_account_unusable',
    `The account nominated as this organization's discount-${side} account (${accountId}) is ` +
      `deactivated or is no longer of type ${JSON.stringify(REQUIRED_TYPE[side])}, so nothing ` +
      'may post to it. Reactivate it, restore its type, or nominate a different account. ' +
      'Discounts already posted to it are unaffected — a journal names the account it posted ' +
      'to and is never restated.',
  );
}
