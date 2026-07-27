import {
  bankAccountPageSchema,
  bankAccountSchema,
  createBankAccountRequestSchema,
  pageCursorSchema,
  updateBankAccountRequestSchema,
} from '@openbooks/shared-types';
import type { BankAccount, BankAccountPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createBankAccount,
  deactivateBankAccount,
  getBankAccount,
  listBankAccounts,
  reactivateBankAccount,
  updateBankAccount,
} from '../../modules/banking';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/bank-accounts` — the register that everything else in M4 hangs off (OB-084,
 * for OB-085/086/087; ROADMAP D-46).
 *
 * A bank account is a ledger account plus the import metadata a statement needs (D-46);
 * these routes register one, list them, and edit the text a human wrote. There is no
 * balance here and there must never be one — the balance is the ledger account's,
 * read through the reports a client already has.
 *
 * The writes take `banking.import` and the reads `banking.read`, which the service
 * enforces and this file only documents (spec §5): there is no `banking.manage`, and
 * setting up the account a statement imports into is the import surface's own concern.
 *
 * `isActive` is not a field on the patch; deactivate and reactivate are their own routes
 * (OB-095), because deactivation refuses an account with an open reconciliation session
 * and a state change every future import depends on should not ride in as a side effect
 * of a rename — the same shape `accounts.ts` argues for the chart.
 */

const TAG = 'bank-accounts';

const bankAccountParamsSchema = z.strictObject({ bankAccountId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listBankAccountsWireQuerySchema = z.strictObject({
  isActive: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`). Omitted matches active and ' +
        'inactive bank accounts alike.',
    }),
  limit: pageLimitQuery('bank accounts'),
  cursor: pageCursorSchema.optional(),
});

export function registerBankAccountRoutes(app: App): void {
  app.post(
    '/v1/bank-accounts',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createBankAccount',
        summary: 'Register a bank account',
        description:
          'Registers an existing ledger account as a bank account (D-46). `accountId` names an ' +
          'account the org already has — a `404` if it does not, because the chart is the org’s ' +
          'and a module that invented accounts in it would decide the org’s chart on its behalf ' +
          '(D-23). Created active.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createBankAccountRequestSchema,
        response: { 201: bankAccountSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createBankAccount', request: request.body, successStatus: 201 },
        () => createBankAccount(request.body, ctx),
      );

      const bankAccount = idempotentBody<BankAccount>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/bank-accounts/${bankAccount.id}`)
        .send(bankAccount);
    },
  );

  app.get(
    '/v1/bank-accounts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBankAccounts',
        summary: 'List bank accounts',
        description: 'One page, oldest first by creation (D-21).',
        tags: [TAG],
        querystring: listBankAccountsWireQuerySchema,
        response: { 200: bankAccountPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankAccountPage> => {
      const { isActive, limit, cursor } = request.query;
      return listBankAccounts(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/bank-accounts/:bankAccountId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBankAccount',
        summary: 'One bank account',
        tags: [TAG],
        params: bankAccountParamsSchema,
        response: { 200: bankAccountSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankAccount> =>
      getBankAccount(request.params.bankAccountId, getContext()),
  );

  app.patch(
    '/v1/bank-accounts/:bankAccountId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateBankAccount',
        summary: 'Update a bank account’s name and institution metadata',
        description:
          'The name and the two bits of institution metadata, and nothing else. `accountId` is ' +
          'not editable — repointing at a different ledger account would orphan every cleared ' +
          'line — and `isActive` is its own operation.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: bankAccountParamsSchema,
        body: updateBankAccountRequestSchema,
        response: { 200: bankAccountSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { bankAccountId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateBankAccount',
          request: { bankAccountId, patch: request.body },
          successStatus: 200,
        },
        () => updateBankAccount(bankAccountId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankAccount>(result));
    },
  );

  /**
   * Deactivate and reactivate, registered from a table because they differ in one word —
   * the same construction `accounts.ts` uses and for the same reason: written out twice
   * they are two near-identical handlers that drift apart when one is edited. Deactivation
   * is refused with `bank_account_has_open_session` (a `412`) when the account has an open
   * reconciliation session; reactivation has no such guard (`bank-accounts.service.ts`).
   */
  for (const route of [
    {
      path: '/v1/bank-accounts/:bankAccountId/deactivate',
      operationId: 'deactivateBankAccount',
      summary: 'Deactivate a bank account',
      description:
        'Takes the account out of circulation: it keeps every line, import and reconciliation it ' +
        'has and accepts no new ones. Refused with `bank_account_has_open_session` while a ' +
        'reconciliation session on it is still open — a deactivated account can settle no ' +
        'clearing, so an open session would be stranded. Idempotent otherwise.',
      run: deactivateBankAccount,
    },
    {
      path: '/v1/bank-accounts/:bankAccountId/reactivate',
      operationId: 'reactivateBankAccount',
      summary: 'Reactivate a bank account',
      description:
        'The counterpart to deactivation, so deactivating the wrong account is not a trap: the ' +
        'account is referenced by its ledger and cannot be deleted.',
      run: reactivateBankAccount,
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
          params: bankAccountParamsSchema,
          response: { 200: bankAccountSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { bankAccountId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { bankAccountId }, successStatus: 200 },
          () => route.run(bankAccountId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<BankAccount>(result));
      },
    );
  }
}
