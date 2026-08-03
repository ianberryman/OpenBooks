import type {
  AccountType,
  ControlAccounts,
  UpdateControlAccountsRequest,
} from '@openbooks/shared-types';
import { updateControlAccountsRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';

import type { ControlAccountsPatch } from './settings.repository';
import {
  ACCOUNT_RESOURCE,
  accountIdBytes,
  orgScope,
  selectControlAccounts,
  selectNominatedAccount,
  upsertControlAccounts,
} from './settings.repository';

/**
 * The control accounts an org's subledger posts through (OB-066a).
 *
 * Read `index.ts` for why this is a setting at all and what changing one means.
 * This file is the two operations that read and write it, plus the one function
 * the document services call.
 */

/**
 * Which subledger an operation is about.
 *
 * The same two words `AGING_LEDGERS` uses, because they name the same split: what a
 * business is owed and what it owes. A payment's direction chooses one, a
 * document's table is one, and an allocation may never cross between them.
 */
export type SubledgerSide = 'receivable' | 'payable';

/**
 * What each side's control account must be, and the reason it is exactly one type.
 *
 * A receivable is a claim on somebody and a payable is an obligation to somebody,
 * so the balance sheet section is not a preference. The check exists because a
 * misnominated control account is invisible: nothing is refused, the postings land,
 * and the first sign of it is a balance sheet with a liability sitting in current
 * assets — which is discovered at a year end, months of documents later, and cannot
 * be undone by editing anything (D-16). A refusal at nomination costs one message.
 *
 * A *contra* balance — a receivables account that happens to be in credit because
 * customers are in advance — is not the same thing and is not constrained here. The
 * sign of a balance is a fact about the postings; the type is a fact about the
 * account, and `0002_ledger` deliberately declines to constrain `normal_balance`
 * against `type` for exactly that reason.
 */
const REQUIRED_TYPE: Readonly<Record<SubledgerSide, AccountType>> = {
  receivable: 'asset',
  payable: 'liability',
};

/**
 * The org's nominations, as the API returns them.
 *
 * `orgs.read`, not `accounts.read`: what is being read is a decision the
 * organization made, and the accounts it names are readable through the chart
 * anyway. Every role that can see the org at all can see this, which matters
 * because it is the field a client needs in order to explain a refused approval.
 */
export async function getControlAccounts(
  ctx: RequestContext = getContext('getControlAccounts()'),
): Promise<ControlAccounts> {
  await requirePermission(ctx, 'orgs.read');

  const row = await selectControlAccounts(orgScope(ctx));

  return {
    receivableControlAccountId:
      row.receivableControlAccountId === null ? null : bufferToUuid(row.receivableControlAccountId),
    payableControlAccountId:
      row.payableControlAccountId === null ? null : bufferToUuid(row.payableControlAccountId),
    inventoryShrinkageAccountId:
      row.inventoryShrinkageAccountId === null
        ? null
        : bufferToUuid(row.inventoryShrinkageAccountId),
  };
}

/**
 * Nominates, repoints or clears a control account.
 *
 * `orgs.write` — the permission seeded as "Change organization settings" — and not
 * `accounts.write`, which the bookkeeper role holds. That is deliberate rather than
 * incidental: this operation decides where every future invoice and bill lands, and
 * the role that enters documents is not the role that decides the shape of the
 * books. It is also, per `index.ts`, a setup act rather than a routine one.
 *
 * ## What it does not do
 *
 * It does not touch a posted journal, and cannot: a journal names its accounts by
 * id, no column in `journals` or `journal_lines` is updatable by the app user (spec
 * §12), and nothing here reads a document. So the postings that named the previous
 * account keep naming it, correctly — they are what happened.
 *
 * It also does not refuse the change when documents posted to the previous account
 * are still outstanding, which was the other option. Refusing would strand exactly
 * the org this operation exists for — one that nominated the wrong account and has
 * already approved something — leaving it with no way to correct the setting at
 * all. What the change costs is stated in `index.ts` and in the wire contract: the
 * subledger ties to the two accounts together until the old ones settle.
 *
 * The whole update is one transaction: two nominations sent together either both
 * land or neither does, so a partially applied pair cannot leave an org posting
 * receivables to a new account and payables to an old one it thought it had
 * changed.
 */
export async function updateControlAccounts(
  request: UpdateControlAccountsRequest,
  ctx: RequestContext = getContext('updateControlAccounts()'),
): Promise<ControlAccounts> {
  await requirePermission(ctx, 'orgs.write');
  const input = parseInput(updateControlAccountsRequestSchema, request);

  return orgScope(ctx).transaction(async (trx) => {
    const patch: ControlAccountsPatch = {
      ...(input.receivableControlAccountId === undefined
        ? {}
        : {
            receivableControlAccountId: await resolveNomination(
              trx,
              'receivable',
              input.receivableControlAccountId,
            ),
          }),
      ...(input.payableControlAccountId === undefined
        ? {}
        : {
            payableControlAccountId: await resolveNomination(
              trx,
              'payable',
              input.payableControlAccountId,
            ),
          }),
      ...(input.inventoryShrinkageAccountId === undefined
        ? {}
        : {
            inventoryShrinkageAccountId: await resolveShrinkageNomination(
              trx,
              input.inventoryShrinkageAccountId,
            ),
          }),
    };

    await upsertControlAccounts(trx, patch);

    return getControlAccountsIn(trx);
  });
}

/**
 * Nominates the two accounts a chart template just created, without disturbing a
 * nomination the org already has.
 *
 * Called from `applyChartTemplate` (D-23), which is the path most orgs take, so
 * that the common case never meets the refusal below at all. Not exported through
 * `index.ts`'s public surface commentary as an operation: it takes a handle and no
 * context because the caller has already checked `accounts.write` and is inside its
 * own transaction, and reopening the permission question here would make applying a
 * template require two permissions to describe.
 *
 * Existing nominations win. Applying a template to an org that has already chosen
 * its control accounts must not silently redirect its postings — that is the
 * failure this whole ticket exists to remove, arriving from the other direction.
 */
export async function nominateControlAccountsIfUnset(
  db: TenantDatabase,
  accounts: Readonly<Partial<Record<SubledgerSide, Buffer>>>,
): Promise<void> {
  const current = await selectControlAccounts(db);

  const patch: ControlAccountsPatch = {
    ...(current.receivableControlAccountId === null && accounts.receivable !== undefined
      ? { receivableControlAccountId: accounts.receivable }
      : {}),
    ...(current.payableControlAccountId === null && accounts.payable !== undefined
      ? { payableControlAccountId: accounts.payable }
      : {}),
  };

  if (Object.keys(patch).length === 0) return;

  await upsertControlAccounts(db, patch);
}

/**
 * The org's control account for one side, or a refusal that names the setting.
 *
 * This is the single function the three document services call, and it replaces
 * three copies of "the active account whose code is `1100`". Nothing about the
 * chart's numbering reaches it any more, which is what makes an org that declined a
 * chart template (D-23) or renumbered its own able to invoice at all.
 *
 * No permission check: every caller has already checked the one that governs the
 * operation it is part of (`invoices.write`, `bills.write`, `payments_received.write`),
 * and a second key here would make approving an invoice require `orgs.read` — a
 * boundary nobody asked for and one the `ar_only` role does not hold.
 *
 * The two refusals are separate tokens because the two fixes are different acts. A
 * nomination that was never made is a setup step; a nomination that has stopped
 * being usable is a chart that changed under the setting, and the person who
 * deactivated the account is the person who needs to hear about it.
 */
export async function resolveControlAccount(
  db: TenantDatabase,
  side: SubledgerSide,
): Promise<Buffer> {
  const settings = await selectControlAccounts(db);
  const nominated =
    side === 'receivable' ? settings.receivableControlAccountId : settings.payableControlAccountId;

  if (nominated === null) throw notSetError(side);

  // Re-read rather than trust the nomination, because `updateAccount` can change an
  // account's `type` and `is_active` after it was nominated. `fk_oas_receivable`
  // guarantees the row exists and belongs to this org; it cannot guarantee the row
  // still describes an account a control balance may sit in.
  const account = await selectNominatedAccount(db, nominated);
  if (account === undefined || !account.isActive || account.type !== REQUIRED_TYPE[side]) {
    throw unusableError(side, bufferToUuid(nominated));
  }

  return nominated;
}

/** `getControlAccounts` without the permission check, for use inside a write. */
async function getControlAccountsIn(db: TenantDatabase): Promise<ControlAccounts> {
  const row = await selectControlAccounts(db);

  return {
    receivableControlAccountId:
      row.receivableControlAccountId === null ? null : bufferToUuid(row.receivableControlAccountId),
    payableControlAccountId:
      row.payableControlAccountId === null ? null : bufferToUuid(row.payableControlAccountId),
    inventoryShrinkageAccountId:
      row.inventoryShrinkageAccountId === null
        ? null
        : bufferToUuid(row.inventoryShrinkageAccountId),
  };
}

/**
 * Validates one nomination, or clears it.
 *
 * The account is read through `tenantDb`, so an id belonging to another org is
 * indistinguishable from one that does not exist — both are `NotFoundError`
 * carrying the resource token and nothing else, which is the byte-identical body A7
 * requires. Letting `fk_oas_receivable` refuse the write instead would be equivalent
 * for integrity and wrong for the error surface: a cross-org id arrives as MySQL
 * errno 1452 and becomes an opaque 500, which is a distinguishable answer and
 * therefore an existence oracle.
 *
 * `PreconditionFailedError` for the type and the deactivation, on
 * `taxAccountTypeError`'s distinction: the id is a well-formed uuid naming a real
 * account in this org, and it is that account's state that forbids the nomination.
 * `account_inactive` is shared with the tax service and with `assertAccountsPostable`
 * on purpose — the machine-readable fact is one fact, and a client should not have
 * to learn a second name for it depending on which service noticed.
 */
async function resolveNomination(
  db: TenantDatabase,
  side: SubledgerSide,
  accountId: string | null,
): Promise<Buffer | null> {
  if (accountId === null) return null;

  const bytes = assertFound(accountIdBytes(accountId), ACCOUNT_RESOURCE);
  const account = assertFound(await selectNominatedAccount(db, bytes), ACCOUNT_RESOURCE);

  if (account.type !== REQUIRED_TYPE[side]) {
    throw new PreconditionFailedError(
      side === 'receivable'
        ? 'receivable_control_account_wrong_type'
        : 'payable_control_account_wrong_type',
      `The ${describe(side)} control account must be of type ` +
        `${JSON.stringify(REQUIRED_TYPE[side])}, and the nominated account is of type ` +
        `${JSON.stringify(account.type)}. ${
          side === 'receivable'
            ? 'What customers owe is a claim the business holds, so it belongs in assets; a ' +
              'receivable balance parked anywhere else reports as something it is not and is ' +
              'found at a year end rather than now.'
            : 'What the business owes its vendors is an obligation, so it belongs in ' +
              'liabilities; a payable balance parked anywhere else understates what is owed on ' +
              'every balance sheet until somebody reconciles it.'
        }`,
    );
  }

  if (!account.isActive) {
    throw new PreconditionFailedError(
      'account_inactive',
      `The nominated ${describe(side)} control account is deactivated, so nothing can post to ` +
        'it. Every approval in this subledger would fail at the moment somebody was waiting for ' +
        'a document rather than now. Reactivate the account, or nominate another.',
    );
  }

  return bytes;
}

/**
 * The inventory-shrinkage nomination (OB-224, D-INV-6), validated to exist and be
 * active in this org. Unlike the two control accounts, its *type* is not
 * constrained: a shrinkage/write-off account is conventionally an expense, but an
 * org may post adjustments to a COGS or other-expense account of its own choosing,
 * so this follows `catalog.service.ts`'s `requireAccount` — existence and activity
 * only, with `postJournal` the backstop that refuses an unpostable account. A
 * cross-org id is A7's 404 (read through `tenantDb`); a deactivated account is the
 * shared `account_inactive` `precondition_failed`.
 */
async function resolveShrinkageNomination(
  db: TenantDatabase,
  accountId: string | null,
): Promise<Buffer | null> {
  if (accountId === null) return null;

  const bytes = assertFound(accountIdBytes(accountId), ACCOUNT_RESOURCE);
  const account = assertFound(await selectNominatedAccount(db, bytes), ACCOUNT_RESOURCE);

  if (!account.isActive) {
    throw new PreconditionFailedError(
      'account_inactive',
      'The nominated inventory-shrinkage account is deactivated, so a stock adjustment could not ' +
        'post its offsetting entry. Reactivate the account, or nominate another.',
    );
  }

  return bytes;
}

function notSetError(side: SubledgerSide): PreconditionFailedError {
  return new PreconditionFailedError(
    side === 'receivable'
      ? 'receivable_control_account_not_set'
      : 'payable_control_account_not_set',
    `This organization has not nominated a ${describe(side)} control account, and approving ` +
      `${side === 'receivable' ? 'an invoice or a credit note' : 'a bill or a vendor credit'} ` +
      `posts to it. Nominate one — any active ${JSON.stringify(REQUIRED_TYPE[side])} account in ` +
      'this chart, conventionally the one named "Accounts ' +
      `${side === 'receivable' ? 'receivable' : 'payable'}" — in the organization's accounting ` +
      'settings, and try again. Posting to a plausible-looking substitute instead would make ' +
      'the subledger and the ledger disagree with no visible cause (D-34), and a wrong posting ' +
      'is the one mistake this system cannot take back.',
  );
}

function unusableError(side: SubledgerSide, accountId: string): PreconditionFailedError {
  return new PreconditionFailedError(
    side === 'receivable'
      ? 'receivable_control_account_unusable'
      : 'payable_control_account_unusable',
    `The account nominated as this organization's ${describe(side)} control account ` +
      `(${accountId}) is deactivated or is no longer of type ` +
      `${JSON.stringify(REQUIRED_TYPE[side])}, so nothing may post to it. Reactivate it, restore ` +
      'its type, or nominate a different account in the accounting settings. Documents already ' +
      'posted to it are unaffected — a journal names the account it posted to and is never ' +
      'restated.',
  );
}

function describe(side: SubledgerSide): string {
  return side === 'receivable' ? 'receivables' : 'payables';
}
