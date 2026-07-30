import {
  billPageSchema,
  billSchema,
  calendarDateSchema,
  createExpenseRequestSchema,
  documentStatusSchema,
  pageCursorSchema,
  updateExpenseRequestSchema,
} from '@openbooks/shared-types';
import type { Expense, ExpensePage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  approveExpense,
  createExpense,
  discardExpense,
  getExpense,
  listExpenses,
  updateExpense,
} from '../../modules/expenses';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/expenses` — employee reimbursements, entered as bills (initiative M,
 * OB-177; ROADMAP D-M2).
 *
 * The clone of `bills.ts` that D-M2 describes: an expense **is** an
 * `ap_documents` bill whose contact is an employee, so every response reuses
 * `billSchema`/`billPageSchema` rather than a duplicate shape — an
 * `expenseSchema` restating `billSchema` field for field would be a second
 * definition of the same document, and the first one to drift would be the
 * one nobody remembers to update. Only the *requests* get their own schema
 * (`createExpenseRequestSchema`, `updateExpenseRequestSchema`), because they
 * are free to diverge later even though they are identical to their bill
 * counterparts today.
 *
 * ## No `reference` filter, and no `voidExpense`
 *
 * `GET /v1/bills` takes a `reference` filter because D-36 makes "have we
 * already entered this vendor invoice" an AP question; an expense has no
 * third party issuing a number to key on, so `listExpensesQuerySchema` omits
 * it and so does this file's querystring.
 *
 * There is no `POST /v1/expenses/{expenseId}/void`. The correction after
 * approval is a vendor credit against the same contact, or `POST
 * /v1/bills/{billId}/void` — the row this endpoint writes is a bill in every
 * sense the schema can see, and the catalog holds no `expenses.void`.
 *
 * ## The approve/write split
 *
 * `approveExpense` is gated by `expenses.approve`, not `expenses.write` —
 * `ORG_SCOPED_WRITE_HOOKS` still applies to the route (org scope and
 * idempotency are transport concerns), but which permission key the call
 * requires is decided inside `expenses.service.ts`, never here (transport
 * holds no business logic; `requirePermission` is service-layer only).
 */

const EXPENSE_TAG = 'expenses';

const expenseParamsSchema = z.strictObject({ expenseId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listExpensesWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: documentStatusSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  dueBefore: calendarDateSchema.optional(),
  limit: pageLimitQuery('expenses'),
  cursor: pageCursorSchema.optional(),
});

export function registerExpenseRoutes(app: App): void {
  app.post(
    '/v1/expenses',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createExpense',
        summary: 'Create a draft expense',
        description:
          'Creates a draft bill whose contact is an employee (D-M2). `contactId` must carry ' +
          '`isEmployee` — `contact_is_not_an_employee` otherwise. Reimbursement is Pay Bills ' +
          'settling this same document once approved; there is no separate reimbursement request.',
        tags: [EXPENSE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createExpenseRequestSchema,
        response: { 201: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createExpense', request: request.body, successStatus: 201 },
        () => createExpense(request.body, ctx),
      );

      const expense = idempotentBody<Expense>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/expenses/${expense.id}`)
        .send(expense);
    },
  );

  app.get(
    '/v1/expenses',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listExpenses',
        summary: 'List expenses',
        description:
          'One page of headers with totals and settlement, and no lines. Ordered by ' +
          '`(created_at, id)`. Only bills whose contact carries `isEmployee` appear here — a ' +
          'contact flagged both a vendor and an employee appears on this list and on ' +
          '`GET /v1/bills` both (D-M8).',
        tags: [EXPENSE_TAG],
        querystring: listExpensesWireQuerySchema,
        response: { 200: billPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ExpensePage> => {
      const { contactId, status, from, to, dueBefore, limit, cursor } = request.query;
      return listExpenses(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(status === undefined ? {} : { status }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(dueBefore === undefined ? {} : { dueBefore }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/expenses/:expenseId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getExpense',
        summary: 'One expense, with its lines and allocations',
        tags: [EXPENSE_TAG],
        params: expenseParamsSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Expense> => getExpense(request.params.expenseId, getContext()),
  );

  app.patch(
    '/v1/expenses/:expenseId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateExpense',
        summary: 'Update a draft expense',
        description:
          'Drafts only; an approved expense answers `document_approved`. `lines` replaces the ' +
          'whole set. The correction after approval is a vendor credit or a void, never an edit ' +
          '(D-38).',
        tags: [EXPENSE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: expenseParamsSchema,
        body: updateExpenseRequestSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { expenseId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateExpense',
          request: { expenseId, patch: request.body },
          successStatus: 200,
        },
        () => updateExpense(expenseId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Expense>(result));
    },
  );

  app.delete(
    '/v1/expenses/:expenseId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardExpense',
        summary: 'Discard a draft expense',
        description:
          'Deletes a draft and its lines. Nothing reached the ledger and no number was ' +
          'allocated, so nothing is restated and no gap is left.',
        tags: [EXPENSE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: expenseParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { expenseId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardExpense', request: { expenseId }, successStatus: 204 },
        () => discardExpense(expenseId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/expenses/:expenseId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveExpense',
        summary: 'Approve an expense and post its journal',
        description:
          'The irreversible step (D-38). In one transaction it allocates the expense’s gapless ' +
          'number, posts a balanced journal debiting the expense lines and **crediting** the ' +
          'org’s payables control account, and records both. Gated by `expenses.approve`, not ' +
          '`expenses.write` — the separation-of-duties split between entering an expense and ' +
          'approving it into a payable. Refusals worth branching on: ' +
          '`payable_control_account_not_set` and `payable_control_account_unusable` naming the ' +
          'org setting to fix, and `document_already_approved` when it has already happened.',
        tags: [EXPENSE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: expenseParamsSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { expenseId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveExpense', request: { expenseId }, successStatus: 200 },
        () => approveExpense(expenseId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Expense>(result));
    },
  );
}
