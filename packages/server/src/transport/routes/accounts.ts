import {
  ACCOUNT_TYPES,
  accountListSchema,
  accountSchema,
  createAccountRequestSchema,
  updateAccountRequestSchema,
} from '@openbooks/shared-types';
import type { Account, AccountList } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createAccount,
  deactivateAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  reactivateAccount,
  updateAccount,
} from '../../modules/accounts';
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
 * `/v1/accounts` — the chart of accounts (spec §2.1).
 *
 * ## Deactivate and reactivate are their own routes, not a flag on the patch
 *
 * `isActive` is deliberately absent from `updateAccountRequestSchema`. Deactivation
 * is the sanctioned alternative to deleting a posted account and it is what the
 * delete path's error tells the caller to do, so it is an operation of its own: a
 * state change that the contents of every report depend on should not be expressible
 * as a side effect of renaming something.
 *
 * `POST …/deactivate` rather than `DELETE …/active`, because both directions have to
 * exist — reactivation is not a convenience. Without it deactivation is a one-way
 * door: the only other way out is deletion, which is exactly what a posted account
 * cannot do, and `uq_accounts_org_code` covers inactive rows so the code could not be
 * reused either.
 *
 * ## The list filter coerces and the shared schema does not
 *
 * `listAccountsQuerySchema` in `@openbooks/shared-types` takes a real boolean,
 * because a shared schema that accepted `'false'` would accept it from a JSON body
 * too — and `'false'` is truthy in every language an integrator might use. A
 * querystring is text, so the coercion belongs here, in the one layer that knows how
 * the value arrived. That is why the schema below is local and carries no `id`: a
 * querystring is emitted as individual `parameters`, so a component for it would be
 * referenced by nothing.
 */

const TAG = 'accounts';

/** Addressed by UUID. A malformed id is a 400; a well-formed one naming nothing is a 404. */
const accountParamsSchema = z.strictObject({ accountId: z.uuid() });

const listAccountsWireQuerySchema = z.strictObject({
  type: z.enum(ACCOUNT_TYPES).optional(),
  isActive: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`). Omitted matches active and ' +
        'inactive accounts alike.',
    }),
});

export function registerAccountRoutes(app: App): void {
  /**
   * The only route in this file that sets `Location`, and the only one where it says
   * something a client does not already have: the created account's own address.
   */
  app.post(
    '/v1/accounts',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createAccount',
        summary: 'Create an account',
        description:
          'Accounts are created active. `normalBalance` is required and independent of `type`, ' +
          'because contra accounts are real — accumulated depreciation is an `asset` whose ' +
          'normal balance is `credit`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createAccountRequestSchema,
        response: { 201: accountSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createAccount', request: request.body, successStatus: 201 },
        () => createAccount(request.body, ctx),
      );

      const account = idempotentBody<Account>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/accounts/${account.id}`)
        .send(account);
    },
  );

  app.get(
    '/v1/accounts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listAccounts',
        summary: 'List the chart of accounts',
        tags: [TAG],
        querystring: listAccountsWireQuerySchema,
        response: { 200: accountListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<AccountList> => {
      const { type, isActive } = request.query;
      return listAccounts(
        {
          ...(type === undefined ? {} : { type }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/accounts/:accountId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getAccount',
        summary: 'One account',
        tags: [TAG],
        params: accountParamsSchema,
        response: { 200: accountSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Account> => getAccount(request.params.accountId, getContext()),
  );

  /**
   * `PATCH` and not `PUT`: every field is optional, an absent field is unchanged, and
   * `description: null` clears it. A `PUT` would mean "replace", and replacing an
   * account with a body that omitted `type` would have to either fail or blank a field
   * whose value every report depends on.
   *
   * The path id is part of the idempotency request payload as well as the body, so the
   * same key replayed against a *different* account is an
   * `idempotency_key_conflict` rather than the first account's response.
   */
  app.patch(
    '/v1/accounts/:accountId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateAccount',
        summary: 'Update an account',
        description:
          '`type` and `normalBalance` are refused once the account carries postings: changing ' +
          'either would silently restate what past reports said about entries already made.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: accountParamsSchema,
        body: updateAccountRequestSchema,
        response: { 200: accountSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { accountId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateAccount',
          request: { accountId, patch: request.body },
          successStatus: 200,
        },
        () => updateAccount(accountId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Account>(result));
    },
  );

  /**
   * The two activation routes are registered from a table because they differ in one
   * word. Written out twice they would be sixty lines whose only distinguishing
   * features are a path segment and a function reference, which is how the two drift
   * apart when one is edited.
   */
  for (const route of [
    {
      path: '/v1/accounts/:accountId/deactivate',
      operationId: 'deactivateAccount',
      summary: 'Deactivate an account',
      description:
        'Removes an account from circulation without removing it from the books, which is the ' +
        'only form of removal available to an account that has been posted to. Idempotent: an ' +
        'already-inactive account is returned unchanged rather than refused.',
      run: deactivateAccount,
    },
    {
      path: '/v1/accounts/:accountId/reactivate',
      operationId: 'reactivateAccount',
      summary: 'Reactivate an account',
      description: 'The counterpart to deactivation, so that deactivation is not a one-way door.',
      run: reactivateAccount,
    },
  ] as const) {
    app.post(
      route.path,
      {
        onRequest: ORG_SCOPED_WRITE_HOOKS,
        schema: {
          operationId: route.operationId,
          summary: route.summary,
          description: route.description,
          tags: [TAG],
          headers: idempotencyKeyHeaderSchema,
          params: accountParamsSchema,
          response: { 200: accountSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { accountId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { accountId }, successStatus: 200 },
          () => route.run(accountId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<Account>(result));
      },
    );
  }

  /**
   * 204, because there is nothing left to return.
   *
   * Permitted only for an account with no postings, and what makes that safe is
   * `ON DELETE RESTRICT` on `journal_lines.account_id` rather than the service's
   * pre-check — see `deleteAccount` for why a check-then-act is acceptable there and
   * why the alternative (refusing outright) puts friction exactly where the risk is
   * not.
   */
  app.delete(
    '/v1/accounts/:accountId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteAccount',
        summary: 'Delete an account that has never been posted to',
        description:
          'An account is configuration rather than a record of what happened, so deleting an ' +
          'unreferenced one restates nothing. An account with postings answers ' +
          '`precondition_failed` with `account_has_postings`; deactivate it instead.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: accountParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { accountId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteAccount', request: { accountId }, successStatus: 204 },
        () => deleteAccount(accountId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
