import {
  createStatementPackageRequestSchema,
  statementPackageListSchema,
  statementPackageSchema,
} from '@openbooks/shared-types';
import type { StatementPackage } from '@openbooks/shared-types';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { createStatementPackage, listStatementPackages } from '../../modules/statements';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/statement-packages` — render and list branded statement bundles (OB-195,
 * transport for `modules/statements`).
 *
 * Handlers map arguments and hold no logic (spec §2.4). Both gate on `reports.read`
 * in the service: a statement package renders the P&L, Balance Sheet and Cash Flow a
 * `reports.read` holder can already run, stapled into one branded PDF (P5), so it
 * needs no permission those reports do not. The render *is* a write — it stores an
 * artifact and records a `statement_packages` row — so `POST` carries an
 * `Idempotency-Key` like every other write, and a replayed request returns the same
 * package rather than rendering a second one.
 */

const TAG = 'statement-packages';

export function registerStatementPackageRoutes(app: App): void {
  app.post(
    '/v1/statement-packages',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createStatementPackage',
        summary: 'Render a branded statement package to PDF',
        description:
          'Renders the P&L, Balance Sheet and Cash Flow for a date range into one branded PDF ' +
          '(P5), stores it behind the StorageProvider, and records it so it can be re-downloaded. ' +
          'Returns the package with a short-lived signed download URL.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createStatementPackageRequestSchema,
        response: { 201: statementPackageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withIdempotency(
        { endpoint: 'createStatementPackage', request: request.body, successStatus: 201 },
        () => createStatementPackage(request.body),
      );

      return reply.status(result.status).send(idempotentBody<StatementPackage>(result));
    },
  );

  app.get(
    '/v1/statement-packages',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listStatementPackages',
        summary: 'List rendered statement packages',
        description:
          'Every statement package this org has rendered, newest first, each with a freshly ' +
          'signed download URL minted on read.',
        tags: [TAG],
        response: { 200: statementPackageListSchema, ...ERROR_RESPONSES },
      },
    },
    async () => listStatementPackages(getContext()),
  );
}
