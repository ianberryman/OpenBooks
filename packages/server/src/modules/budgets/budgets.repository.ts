import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { newUuidBuffer, orgScope as toOrgId, tenantDb, tryUuidToBuffer } from '../../db';

/**
 * Data access for `budgets` (initiative N, OB-181; ROADMAP D-N1…D-N5).
 *
 * `fixed-assets.repository.ts` is the template this mirrors: every statement goes
 * through `tenantDb`, so a cross-org id matches nothing and the service's
 * `assertFound` turns that into A7's one sanctioned miss. `dimension_slice` is a
 * `STORED GENERATED` column (the composite uniqueness key for a budget slot,
 * D-N1) and never appears in an insert or update — only in `ORDER BY`, where
 * MySQL is free to read a generated column like any other.
 */

export const BUDGET_RESOURCE = 'budget';

const BUDGET_COLUMNS = [
  'id',
  'account_id',
  'period_id',
  'dimension_id',
  'dimension_value_id',
  'amount_minor',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

export interface BudgetRow {
  readonly id: Buffer;
  readonly account_id: Buffer;
  readonly period_id: Buffer;
  readonly dimension_id: Buffer | null;
  readonly dimension_value_id: Buffer | null;
  readonly amount_minor: bigint;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewBudgetRow {
  readonly accountId: Buffer;
  readonly periodId: Buffer;
  readonly dimensionId: Buffer | null;
  readonly dimensionValueId: Buffer | null;
  readonly amountMinor: bigint;
  readonly createdByUserId: Buffer;
}

export interface BudgetFilters {
  readonly periodId?: Buffer;
  readonly accountId?: Buffer;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied budget id as bytes, or `undefined` when it is not a UUID —
 * routed through `assertFound` to the same 404 a nonexistent one produces (A7),
 * `assetIdBytes`'s own shape.
 */
export function budgetIdBytes(budgetId: string): Buffer | undefined {
  return tryUuidToBuffer(budgetId);
}

/**
 * Enters or replaces one budget slot's amount (D-N5). `id` and the slot's
 * identity — `account_id`, `period_id`, and the `dimension_slice` the database
 * computes from `dimension_value_id` — are only ever set on insert; a repeat
 * upsert touches `amount_minor` alone, so the row keeps the id and identity of
 * whichever call created it first.
 */
export async function upsertBudget(db: TenantDatabase, input: NewBudgetRow): Promise<void> {
  await db
    .insertInto('budgets')
    .values({
      id: newUuidBuffer(),
      account_id: input.accountId,
      period_id: input.periodId,
      dimension_id: input.dimensionId,
      dimension_value_id: input.dimensionValueId,
      amount_minor: input.amountMinor,
      created_by_user_id: input.createdByUserId,
    })
    .onDuplicateKeyUpdate({ amount_minor: input.amountMinor })
    .execute();
}

/**
 * Re-reads what `setBudgets` just upserted, across every period and account the
 * batch touched — the read `setBudgets` maps back into the `Budget`s it returns,
 * since an upsert statement itself reports no rows.
 */
export async function selectBudgetsByPeriodAndAccounts(
  db: TenantDatabase,
  periodIds: readonly Buffer[],
  accountIds: readonly Buffer[],
): Promise<readonly BudgetRow[]> {
  if (periodIds.length === 0 || accountIds.length === 0) return [];

  return db
    .selectFrom('budgets')
    .select(BUDGET_COLUMNS)
    .where('period_id', 'in', periodIds)
    .where('account_id', 'in', accountIds)
    .execute();
}

/**
 * `listBudgets`'s read. Not paginated — `budgets.ts`'s own reasoning: a period's
 * budgets are bounded by the chart × its dimension values, and the report, not
 * this list, is the read that scales. Ordered by `account_id`, then
 * `dimension_slice` for a stable result across calls.
 */
export async function selectBudgets(
  db: TenantDatabase,
  filters: BudgetFilters,
): Promise<readonly BudgetRow[]> {
  let query = db.selectFrom('budgets').select(BUDGET_COLUMNS);

  if (filters.periodId !== undefined) {
    query = query.where('period_id', '=', filters.periodId);
  }
  if (filters.accountId !== undefined) {
    query = query.where('account_id', '=', filters.accountId);
  }

  return query.orderBy('account_id', 'asc').orderBy('dimension_slice', 'asc').execute();
}

export async function selectBudgetById(
  db: TenantDatabase,
  id: Buffer,
): Promise<BudgetRow | undefined> {
  return db.selectFrom('budgets').select(BUDGET_COLUMNS).where('id', '=', id).executeTakeFirst();
}

export async function deleteBudgetById(db: TenantDatabase, id: Buffer): Promise<void> {
  await db.deleteFrom('budgets').where('id', '=', id).execute();
}

/**
 * Accounts a budget entry may target, keyed by id — `selectPostableAccounts`'s
 * own shape (`ledger/posting.repository.ts`), extended with `type` since
 * `setBudgets` must also refuse a balance-sheet account (D-N2). Reads through
 * the tenant wrapper, so another org's account does not appear in the result and
 * the caller reports it as unknown (A7).
 */
export async function selectPostableBudgetAccounts(
  db: TenantDatabase,
  accountIds: readonly Buffer[],
): Promise<Map<string, { readonly isActive: boolean; readonly type: string }>> {
  if (accountIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('accounts')
    .select(['id', 'is_active', 'type'])
    .where('accounts.id', 'in', accountIds)
    .execute();

  return new Map(
    rows.map((row) => [row.id.toString('hex'), { isActive: row.is_active === 1, type: row.type }]),
  );
}

/** Which of `periodIds` exist in this org — `setBudgets`'s period-existence check. */
export async function selectExistingPeriodIds(
  db: TenantDatabase,
  periodIds: readonly Buffer[],
): Promise<Set<string>> {
  if (periodIds.length === 0) return new Set();

  const rows = await db
    .selectFrom('fiscal_periods')
    .select('id')
    .where('id', 'in', periodIds)
    .execute();

  return new Set(rows.map((row) => row.id.toString('hex')));
}

/**
 * The axis (`dimension_id`) each of `valueIds` belongs to, keyed by the value's
 * own id — `setBudgets` needs this because a client names only the value, never
 * its axis redundantly (`setBudgetEntrySchema`'s own commentary). A value absent
 * from the result is unknown to this org, cross-org or otherwise, and
 * `setBudgets` reports it as `NotFoundError('dimension_value')` (A7).
 */
export async function selectDimensionAxisForValues(
  db: TenantDatabase,
  valueIds: readonly Buffer[],
): Promise<Map<string, Buffer>> {
  if (valueIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('dimension_values')
    .select(['id', 'dimension_id'])
    .where('id', 'in', valueIds)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.dimension_id]));
}
