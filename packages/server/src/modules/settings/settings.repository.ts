import type { AccountType } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { orgScope as toOrgId, tenantDb, tryUuidToBuffer } from '../../db';

/**
 * Data access for `org_accounting_settings` (OB-066a).
 *
 * Every statement here goes through `tenantDb`, including the read of `accounts`
 * that validates a nomination — which is what makes another org's account id the
 * same 404 a nonexistent one gets rather than errno 1452 surfacing as a 500 (A7).
 * `tax-rates.repository.ts` establishes that shape for the account a rate posts to
 * and this is the same rule applied to the account a document posts through.
 *
 * The row is created lazily. An org has no settings row until something nominates
 * an account, and the absence is the answer rather than a missing default: `null`
 * on both sides is exactly what a brand-new org means, and materializing a row of
 * nulls at org creation would put a write into `createOrg` that says nothing.
 */

/**
 * The token a miss on a nominated account reports, and it must stay equal to
 * `ACCOUNT_RESOURCE` in `modules/accounts/accounts.repository.ts`.
 *
 * A literal rather than an import for the reason `tax-rates.repository.ts` gives:
 * importing a sibling module's repository would put an edge in the dependency
 * graph asserting that org settings are built on the chart of accounts module,
 * which dependency-cruiser would then enforce as though it meant something. The
 * risk of drift is real and small — a rename would have to be deliberate — and the
 * service tests assert the wire body against the one `getAccount` produces.
 */
export const ACCOUNT_RESOURCE = 'account';

export interface ControlAccountsRow {
  readonly receivableControlAccountId: Buffer | null;
  readonly payableControlAccountId: Buffer | null;
  readonly inventoryShrinkageAccountId: Buffer | null;
}

/** The early-pay discount nominations (OB-136; ROADMAP D-106, D-107). */
export interface DiscountAccountsRow {
  readonly discountGivenAccountId: Buffer | null;
  readonly discountReceivedAccountId: Buffer | null;
}

/** The org-default depreciation-account nominations (initiative L; ROADMAP D-115). */
export interface DepreciationAccountsRow {
  readonly depreciationExpenseAccountId: Buffer | null;
  readonly accumulatedDepreciationAccountId: Buffer | null;
}

/** What validating a nomination needs, and nothing more. */
export interface NominatedAccountRow {
  readonly type: AccountType;
  readonly isActive: boolean;
}

/**
 * The patch shape, in which `null` and absent are different values.
 *
 * `undefined` leaves the side alone; `null` clears it. That is
 * `updateControlAccountsRequestSchema`'s distinction carried down unchanged, and
 * collapsing it here would make "set only the receivable one" impossible to
 * express without restating a value the caller may not have read.
 */
export interface ControlAccountsPatch {
  readonly receivableControlAccountId?: Buffer | null;
  readonly payableControlAccountId?: Buffer | null;
  readonly inventoryShrinkageAccountId?: Buffer | null;
}

/** The discount-nomination twin of `ControlAccountsPatch`, same two rules. */
export interface DiscountAccountsPatch {
  readonly discountGivenAccountId?: Buffer | null;
  readonly discountReceivedAccountId?: Buffer | null;
}

/** The depreciation-nomination twin of `ControlAccountsPatch`, same two rules. */
export interface DepreciationAccountsPatch {
  readonly depreciationExpenseAccountId?: Buffer | null;
  readonly accumulatedDepreciationAccountId?: Buffer | null;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function accountIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

/**
 * The org's nominations, or both null when it has never made one.
 *
 * No row and a row of nulls are deliberately the same answer. They mean the same
 * thing — nothing nominated — and giving the caller two ways to spell it would put
 * a `row === undefined` branch into every consumer for no difference in outcome.
 */
export async function selectControlAccounts(db: TenantDatabase): Promise<ControlAccountsRow> {
  const row = await db
    .selectFrom('org_accounting_settings')
    .select([
      'receivable_control_account_id',
      'payable_control_account_id',
      'inventory_shrinkage_account_id',
    ])
    .executeTakeFirst();

  return {
    receivableControlAccountId: row?.receivable_control_account_id ?? null,
    payableControlAccountId: row?.payable_control_account_id ?? null,
    inventoryShrinkageAccountId: row?.inventory_shrinkage_account_id ?? null,
  };
}

/**
 * The org's discount nominations, or both null when it has never made one —
 * `selectControlAccounts`'s own reasoning, on the two columns beside these in
 * the same row.
 */
export async function selectDiscountAccounts(db: TenantDatabase): Promise<DiscountAccountsRow> {
  const row = await db
    .selectFrom('org_accounting_settings')
    .select(['discount_given_account_id', 'discount_received_account_id'])
    .executeTakeFirst();

  return {
    discountGivenAccountId: row?.discount_given_account_id ?? null,
    discountReceivedAccountId: row?.discount_received_account_id ?? null,
  };
}

/**
 * The org's depreciation-account nominations, or both null when it has never
 * made one — `selectDiscountAccounts`'s own reasoning, on the two columns
 * `0005_subledger` added in place beside the four above (D-115).
 */
export async function selectDepreciationAccounts(
  db: TenantDatabase,
): Promise<DepreciationAccountsRow> {
  const row = await db
    .selectFrom('org_accounting_settings')
    .select(['depreciation_expense_account_id', 'accumulated_depreciation_account_id'])
    .executeTakeFirst();

  return {
    depreciationExpenseAccountId: row?.depreciation_expense_account_id ?? null,
    accumulatedDepreciationAccountId: row?.accumulated_depreciation_account_id ?? null,
  };
}

export async function selectNominatedAccount(
  db: TenantDatabase,
  accountId: Buffer,
): Promise<NominatedAccountRow | undefined> {
  const row = await db
    .selectFrom('accounts')
    .select(['type', 'is_active'])
    .where('id', '=', accountId)
    .executeTakeFirst();

  return row === undefined ? undefined : { type: row.type, isActive: row.is_active !== 0 };
}

/**
 * Writes the patch, creating the settings row if this is the org's first
 * nomination.
 *
 * `INSERT … ON DUPLICATE KEY UPDATE` rather than a read followed by a branch,
 * because the read-then-branch loses a race with itself: two concurrent first
 * nominations both see no row, both insert, and the loser gets errno 1062 on a
 * primary key — a 500 for an operation that had nothing wrong with it. The upsert
 * is one statement holding one row lock, and `PRIMARY KEY (org_id)` is what makes
 * the conflict target unambiguous.
 *
 * The insert supplies only the columns the patch names, so the other side arrives
 * as its column default (NULL) on a first write and is left untouched on a
 * subsequent one — which is the same rule stated twice, once for each branch of the
 * statement.
 */
export async function upsertControlAccounts(
  db: TenantDatabase,
  patch: ControlAccountsPatch,
): Promise<void> {
  const columns = {
    ...(patch.receivableControlAccountId === undefined
      ? {}
      : { receivable_control_account_id: patch.receivableControlAccountId }),
    ...(patch.payableControlAccountId === undefined
      ? {}
      : { payable_control_account_id: patch.payableControlAccountId }),
    ...(patch.inventoryShrinkageAccountId === undefined
      ? {}
      : { inventory_shrinkage_account_id: patch.inventoryShrinkageAccountId }),
  };

  await db
    .insertInto('org_accounting_settings')
    .values(columns)
    .onDuplicateKeyUpdate(columns)
    .execute();
}

/** `upsertControlAccounts`'s own statement, over the two discount columns. */
export async function upsertDiscountAccounts(
  db: TenantDatabase,
  patch: DiscountAccountsPatch,
): Promise<void> {
  const columns = {
    ...(patch.discountGivenAccountId === undefined
      ? {}
      : { discount_given_account_id: patch.discountGivenAccountId }),
    ...(patch.discountReceivedAccountId === undefined
      ? {}
      : { discount_received_account_id: patch.discountReceivedAccountId }),
  };

  await db
    .insertInto('org_accounting_settings')
    .values(columns)
    .onDuplicateKeyUpdate(columns)
    .execute();
}

/** `upsertControlAccounts`'s own statement, over the two depreciation columns (D-115). */
export async function upsertDepreciationAccounts(
  db: TenantDatabase,
  patch: DepreciationAccountsPatch,
): Promise<void> {
  const columns = {
    ...(patch.depreciationExpenseAccountId === undefined
      ? {}
      : { depreciation_expense_account_id: patch.depreciationExpenseAccountId }),
    ...(patch.accumulatedDepreciationAccountId === undefined
      ? {}
      : { accumulated_depreciation_account_id: patch.accumulatedDepreciationAccountId }),
  };

  await db
    .insertInto('org_accounting_settings')
    .values(columns)
    .onDuplicateKeyUpdate(columns)
    .execute();
}
