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
  getBankAccount,
  listBankAccounts,
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
 * There is no deactivate route yet — flipping `isActive` has to refuse an account with
 * an open reconciliation session, which is business logic beyond this transport ticket
 * (`bank-accounts.service.ts` records it).
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
}
