import type {
  Budget,
  BudgetList,
  ListBudgetsQueryParams,
  SetBudgetsRequest,
} from '@openbooks/shared-types';
import {
  fromMinorString,
  listBudgetsQuerySchema,
  setBudgetsRequestSchema,
  toMinorUnits,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, tryUuidToBuffer, uuidToBuffer } from '../../db';
import {
  assertFound,
  NotFoundError,
  parseInput,
  PreconditionFailedError,
  ValidationError,
} from '../../errors';
import { requirePermission } from '../permissions';

import type { BudgetRow } from './budgets.repository';
import {
  BUDGET_RESOURCE as RESOURCE,
  budgetIdBytes,
  deleteBudgetById,
  orgScope,
  selectBudgetById,
  selectBudgets,
  selectBudgetsByPeriodAndAccounts,
  selectDimensionAxisForValues,
  selectExistingPeriodIds,
  selectPostableBudgetAccounts,
  upsertBudget,
} from './budgets.repository';

/**
 * Budgets: enter, import, list and remove budget figures (initiative N, OB-181;
 * ROADMAP D-N1…D-N5). A budget posts no journal (D-94) — it is a target the
 * budget-vs-actual report (`reports`, OB-182) compares to ledger actuals, so
 * everything here is a plain upsert/select over `budgets`.
 *
 * `requirePermission` runs first everywhere below, before the payload is parsed
 * — `fixed-assets.service.ts`'s own ordering, so an unauthorized caller learns
 * nothing about the shape of a request it cannot make. A miss is always
 * `assertFound`/`NotFoundError`: `orgScope`/`tenantDb` has already confined
 * every read to the caller's org, so a cross-org id matches nothing and reaches
 * the same 404 a nonexistent one does (A7).
 */

/** A cents-only wire string as minor units — `fixed-assets.service.ts`'s own restatement. */
function minorUnits(value: string): bigint {
  return toMinorUnits(fromMinorString(value));
}

/**
 * The user a batch of budget figures is entered by. `budgets.created_by_user_id`
 * is `NOT NULL` — `fixed-assets.service.ts`'s `requireRecordingUser`, restated
 * here rather than imported, for the reason that file gives for restating
 * `addCalendarDays` rather than reaching into another module's internals.
 */
function requireRecordingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A budget entry is recorded by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot enter a budget figure. Entry is ' +
          'attributed to the person who made it.',
      },
    ]);
  }
  return userId;
}

/** De-duplicates by id, `assertAccountsPostable`'s own `Map`-through-hex idiom. */
function distinctBuffers(ids: readonly Buffer[]): readonly Buffer[] {
  return [...new Map(ids.map((id) => [id.toString('hex'), id])).values()];
}

/**
 * An entry's `(account, period, dimension value)` slot, as a string key —
 * `setBudgets`'s own way of matching the re-read rows back to the entries that
 * produced them. A null dimension value (the account-total slot) maps to the
 * empty string, distinct from any hex id.
 */
function slotKey(accountId: Buffer, periodId: Buffer, dimensionValueId: Buffer | null): string {
  return `${accountId.toString('hex')}:${periodId.toString('hex')}:${
    dimensionValueId === null ? '' : dimensionValueId.toString('hex')
  }`;
}

/**
 * Every named account must exist in this org, be active, and be a P&L account
 * (D-N2) — balance-sheet budgeting is deferred. `assertAccountsPostable`'s own
 * shape (`ledger/posting.service.ts`), extended with the P&L-type check.
 */
function assertAccountsBudgetable(
  accountIds: readonly Buffer[],
  accounts: ReadonlyMap<string, { readonly isActive: boolean; readonly type: string }>,
): void {
  const missing = accountIds.filter((id) => !accounts.has(id.toString('hex')));
  if (missing.length > 0) {
    throw new NotFoundError('account');
  }

  const inactive = accountIds.filter((id) => accounts.get(id.toString('hex'))?.isActive === false);
  if (inactive.length > 0) {
    throw new PreconditionFailedError(
      'account_inactive',
      `Cannot budget against a deactivated account (${inactive
        .map((id) => bufferToUuid(id))
        .join(', ')}).`,
    );
  }

  const notProfitAndLoss = accountIds.filter((id) => {
    const type = accounts.get(id.toString('hex'))?.type;
    return type !== 'revenue' && type !== 'expense';
  });
  if (notProfitAndLoss.length > 0) {
    throw new PreconditionFailedError(
      'account_not_profit_and_loss',
      'Only revenue and expense accounts can be budgeted (D-N2); balance-sheet budgeting is ' +
        `deferred (${notProfitAndLoss.map((id) => bufferToUuid(id)).join(', ')}).`,
    );
  }
}

/**
 * Enters or imports a batch of budget figures (OB-181, D-N5). Each entry
 * upserts its own `(account, period, dimension-value)` slot — re-sending the
 * same batch is a no-op, and a repeated slot within one batch is the last
 * writer (`setBudgetsRequestSchema`'s own contract). Every account, period and
 * dimension value the batch names is validated before anything is written, so
 * a batch either lands in full or not at all.
 */
export async function setBudgets(
  input: SetBudgetsRequest,
  ctx: RequestContext = getContext('setBudgets()'),
): Promise<BudgetList> {
  await requirePermission(ctx, 'budgets.write');
  const request = parseInput(setBudgetsRequestSchema, input);
  const author = requireRecordingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const accountIds = distinctBuffers(
      request.entries.map((entry) => uuidToBuffer(entry.accountId)),
    );
    const accounts = await selectPostableBudgetAccounts(trx, accountIds);
    assertAccountsBudgetable(accountIds, accounts);

    const periodIds = distinctBuffers(request.entries.map((entry) => uuidToBuffer(entry.periodId)));
    const existingPeriods = await selectExistingPeriodIds(trx, periodIds);
    if (periodIds.some((id) => !existingPeriods.has(id.toString('hex')))) {
      throw new NotFoundError('fiscal_period');
    }

    const dimensionValueIds = distinctBuffers(
      request.entries
        .map((entry) => entry.dimensionValueId)
        .filter((id): id is string => id !== undefined)
        .map((id) => uuidToBuffer(id)),
    );
    const axisByValue = await selectDimensionAxisForValues(trx, dimensionValueIds);
    if (dimensionValueIds.some((id) => !axisByValue.has(id.toString('hex')))) {
      throw new NotFoundError('dimension_value');
    }

    for (const entry of request.entries) {
      const dimensionValueId =
        entry.dimensionValueId === undefined ? null : uuidToBuffer(entry.dimensionValueId);
      const dimensionId =
        dimensionValueId === null
          ? null
          : (axisByValue.get(dimensionValueId.toString('hex')) ?? null);

      await upsertBudget(trx, {
        accountId: uuidToBuffer(entry.accountId),
        periodId: uuidToBuffer(entry.periodId),
        dimensionId,
        dimensionValueId,
        amountMinor: minorUnits(entry.amount),
        createdByUserId: author,
      });
    }

    const slots = new Set(
      request.entries.map((entry) =>
        slotKey(
          uuidToBuffer(entry.accountId),
          uuidToBuffer(entry.periodId),
          entry.dimensionValueId === undefined ? null : uuidToBuffer(entry.dimensionValueId),
        ),
      ),
    );

    const rows = await selectBudgetsByPeriodAndAccounts(trx, periodIds, accountIds);
    const items = rows
      .filter((row) => slots.has(slotKey(row.account_id, row.period_id, row.dimension_value_id)))
      .map(toBudget);

    return { items };
  });
}

/** One page — unpaginated, `budgetListSchema`'s own reasoning — of this org's stored budgets. */
export async function listBudgets(
  query: ListBudgetsQueryParams,
  ctx: RequestContext = getContext('listBudgets()'),
): Promise<BudgetList> {
  await requirePermission(ctx, 'budgets.read');
  const request = parseInput(listBudgetsQuerySchema, query);
  const db = orgScope(ctx);

  const rows = await selectBudgets(db, {
    ...(request.periodId === undefined ? {} : { periodId: uuidToBuffer(request.periodId) }),
    ...(request.accountId === undefined ? {} : { accountId: uuidToBuffer(request.accountId) }),
  });

  return { items: rows.map(toBudget) };
}

/**
 * Removes a stored budget figure. A malformed or cross-org id reaches the same
 * 404 (A7) — `budgetIdBytes` is checked with its own `assertFound` before the
 * row is read, `getFixedAssetSchedule`'s own two-step shape, so a bad id never
 * reaches a query.
 */
export async function deleteBudget(
  input: { readonly budgetId: string },
  ctx: RequestContext = getContext('deleteBudget()'),
): Promise<void> {
  await requirePermission(ctx, 'budgets.write');
  const db = orgScope(ctx);

  const id = assertFound(budgetIdBytes(input.budgetId), RESOURCE);
  assertFound(await selectBudgetById(db, id), RESOURCE);
  await deleteBudgetById(db, id);
}

function toBudget(row: BudgetRow): Budget {
  return {
    id: bufferToUuid(row.id),
    accountId: bufferToUuid(row.account_id),
    periodId: bufferToUuid(row.period_id),
    dimensionId: row.dimension_id === null ? null : bufferToUuid(row.dimension_id),
    dimensionValueId: row.dimension_value_id === null ? null : bufferToUuid(row.dimension_value_id),
    amount: row.amount_minor.toString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
