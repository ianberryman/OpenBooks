import {
  createCustomerStatementRequestSchema,
  customerStatementListSchema,
  customerStatementSchema,
} from '@openbooks/shared-types';
import type { CustomerStatement } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { createCustomerStatement, listCustomerStatements } from '../../modules/account-statements';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/customer-statements` — render, list, and (optionally in the same call)
 * email a customer's open-item statement of account (OB-220 part 1, transport for
 * `modules/account-statements`).
 *
 * Handlers map arguments and hold no logic (spec §2.4). Both gate on
 * `reports.read` in the service: a statement is the aging report for one contact,
 * stapled into a branded PDF and optionally sent — the same rationale
 * `transport/routes/statement-packages.ts` states for statement packages. The
 * render *is* a write — it stores an artifact, records a `customer_statements`
 * row, and may send an email — so `POST` carries an `Idempotency-Key` like every
 * other write, and a replayed request returns the same statement rather than
 * rendering (and, worse, re-sending) a second one.
 */

const TAG = 'customer-statements';

const listCustomerStatementsWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
});

export function registerCustomerStatementRoutes(app: App): void {
  app.post(
    '/v1/customer-statements',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createCustomerStatement',
        summary: 'Render a customer statement of account to PDF',
        description:
          'Renders one contact’s open items — the aging report (OB-065) for that contact, as at ' +
          'a date — into a branded PDF, stores it behind the StorageProvider, and records it so ' +
          'it can be re-downloaded. An optional `delivery.recipientEmail` also emails the ' +
          'customer a hosted link; a rejected send is reported as `status: "failed"` rather than ' +
          'as an error, since the artifact was genuinely rendered and stored regardless.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createCustomerStatementRequestSchema,
        response: { 200: customerStatementSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withIdempotency(
        { endpoint: 'createCustomerStatement', request: request.body, successStatus: 200 },
        () => createCustomerStatement(request.body),
      );

      return reply.status(result.status).send(idempotentBody<CustomerStatement>(result));
    },
  );

  app.get(
    '/v1/customer-statements',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listCustomerStatements',
        summary: 'List rendered customer statements',
        description:
          'Every customer statement this org has rendered, newest first, optionally narrowed to ' +
          'one contact — each with a freshly signed download URL and a closing balance ' +
          'recomputed as at its own `asOf` (D-40’s reproducibility makes that the same figure the ' +
          'statement was rendered with).',
        tags: [TAG],
        querystring: listCustomerStatementsWireQuerySchema,
        response: { 200: customerStatementListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => listCustomerStatements(request.query.contactId, getContext()),
  );
}
