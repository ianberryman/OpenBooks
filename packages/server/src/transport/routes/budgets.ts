import { budgetListSchema, setBudgetsRequestSchema } from '@openbooks/shared-types';
import type { BudgetList } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { deleteBudget, listBudgets, setBudgets } from '../../modules/budgets';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  requireOrgScope,
} from './support';

/**
 * `/v1/budgets` — entering, listing and deleting budget figures (OB-183, transport
 * for `modules/budgets`).
 *
 * Handlers map arguments and hold no logic (spec §2.4): a budget posts no journal
 * (D-94), so every refusal here — a non-P&L account, a nonexistent period or
 * dimension value, a cross-org id — is the service's, not this file's. The
 * budget-vs-actual *report* is not here: it gates on `reports.read` like every other
 * report and lives on `/v1/reports/budget-vs-actual` (`routes/reports.ts`), while
 * these three gate on `budgets.read`/`budgets.write` (D-N6).
 *
 * ## `POST /v1/budgets` is the batch upsert, and the import primitive (D-N5)
 *
 * There is no separate "import" endpoint: the write takes an array of entries and
 * upserts each into its `(account, period, slice)` slot, so re-sending a batch
 * restates rather than accumulates. A CSV/paste UI sits on top of this on the
 * screen side; the server parses no CSV.
 */

const TAG = 'budgets';

const budgetParamsSchema = z.strictObject({ budgetId: z.uuid() });

/**
 * Local and carrying no `id`, `listFixedAssetsWireQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for one would be
 * referenced by nothing. Both filters are scalar uuids — no structured filter to
 * cross a querystring, so nothing like the reports' url-encoded `dimensions`.
 */
const listBudgetsWireQuerySchema = z.strictObject({
  periodId: z.uuid().optional(),
  accountId: z.uuid().optional(),
});

export function registerBudgetRoutes(app: App): void {
  app.post(
    '/v1/budgets',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'setBudgets',
        summary: 'Enter or import budget figures',
        description:
          'Upserts a batch of budget figures by account, period and optional dimension value ' +
          '(OB-181, D-N5). Each entry replaces the amount in its slot, so re-sending the same ' +
          'batch is a no-op rather than an accumulation. Posts no journal (D-94). Only revenue ' +
          'and expense accounts may be budgeted in v1 (D-N2); a balance-sheet account is refused ' +
          'with `account_not_profit_and_loss`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: setBudgetsRequestSchema,
        response: { 200: budgetListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'setBudgets', request: request.body, successStatus: 200 },
        () => setBudgets(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BudgetList>(result));
    },
  );

  app.get(
    '/v1/budgets',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBudgets',
        summary: 'List stored budget figures',
        description:
          'Every stored budget, optionally narrowed to one period and/or one account. Not ' +
          'paginated: a period’s budgets are bounded by the chart × its dimension values, and ' +
          'the budget-vs-actual report — not this list — is the read that scales.',
        tags: [TAG],
        querystring: listBudgetsWireQuerySchema,
        response: { 200: budgetListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BudgetList> => {
      const { periodId, accountId } = request.query;
      return listBudgets(
        {
          ...(periodId === undefined ? {} : { periodId }),
          ...(accountId === undefined ? {} : { accountId }),
        },
        getContext(),
      );
    },
  );

  app.delete(
    '/v1/budgets/:budgetId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteBudget',
        summary: 'Delete a budget figure',
        description:
          'Removes one stored budget figure. Deleting is not reversing — a budget posts no ' +
          'journal (D-94), so removing one restates nothing a trial balance depends on. A ' +
          'cross-org or nonexistent id answers 404, never 403 (A7).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: budgetParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { budgetId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteBudget', request: { budgetId }, successStatus: 204 },
        () => deleteBudget({ budgetId }, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
