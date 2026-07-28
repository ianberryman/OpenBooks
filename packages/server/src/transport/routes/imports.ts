import {
  quickbooksImportPreviewSchema,
  quickbooksImportRequestSchema,
  quickbooksImportResultSchema,
} from '@openbooks/shared-types';
import type { QuickBooksImportPreview, QuickBooksImportResult } from '@openbooks/shared-types';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { importQuickBooks, previewQuickBooksImport } from '../../modules/imports';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
} from './support';

/**
 * `/v1/imports/quickbooks` — the one-time QuickBooks CSV cutover (Phase 3, the
 * launch gate).
 *
 * Mirrors `bank-imports.ts`'s preview/start shape with one structural difference:
 * there is no worker leg. Applying a chart is already a synchronous loop over
 * `createAccount` in one transaction (`chart-templates.ts`), and this importer is
 * that plus contacts plus one journal — small, bounded, and atomic — so `import`
 * commits inside the request rather than enqueuing a job (see
 * `@openbooks/shared-types/imports/quickbooks` for the argument in full).
 *
 * ## Preview is a `POST` that reads, and it still carries an `Idempotency-Key`
 *
 * `previewQuickBooksImport` writes nothing — it takes `accounts.read` and
 * `contacts.read` and reports what `import` would do. It is a `POST` because the
 * files travel in the body as text, and the header is required all the same:
 * "every non-`GET` carries a key" is asserted by enumerating the writes out of
 * the published document (`routes/index.ts`), and a read-`POST` with no key
 * would turn that rule into a rule with an allowlist. So preview requires the
 * header like every other `POST` and simply does not *claim* it — there is
 * nothing to replay, because it changed nothing.
 *
 * ## Import is a `201`, all-or-nothing
 *
 * `importQuickBooks` takes `accounts.write`, `contacts.write`, and
 * `journals.post`, and either the whole cutover lands or none of it does — a
 * code collision, an unbalanced trial balance, or a trial-balance line naming an
 * account the file never created refuses the request before anything is
 * written. `openingJournalId` is `null` when no trial balance was sent.
 */

const TAG = 'imports';

export function registerImportRoutes(app: App): void {
  app.post(
    '/v1/imports/quickbooks/preview',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'previewQuickBooksImport',
        summary: 'Preview a QuickBooks CSV import without writing',
        description:
          'Parses the chart, contact lists, and trial balance and reports what committing them ' +
          'would create — draft accounts and contacts, code conflicts, whether the opening ' +
          'balance balances, and every row-level problem. Writes nothing. A `POST` because the ' +
          'files are in the body, and it carries an `Idempotency-Key` like every write on this ' +
          'surface even though it claims none.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: quickbooksImportRequestSchema,
        response: { 200: quickbooksImportPreviewSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<QuickBooksImportPreview> =>
      previewQuickBooksImport(request.body, getContext()),
  );

  app.post(
    '/v1/imports/quickbooks',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'importQuickBooks',
        summary: 'Commit a QuickBooks CSV import',
        description:
          'Creates the chart of accounts, the customers and vendors, and — if a trial balance ' +
          'was sent — posts it as one opening journal, all in a single transaction: every ' +
          'account and contact lands, or none of them do. Refuses on a code conflict, an ' +
          'unbalanced trial balance (`opening_balance_unbalanced`), or a trial-balance line ' +
          'naming an account the file did not create (`opening_balance_unknown_account`).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: quickbooksImportRequestSchema,
        response: { 201: quickbooksImportResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'importQuickBooks', request: request.body, successStatus: 201 },
        () => importQuickBooks(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<QuickBooksImportResult>(result));
    },
  );
}
