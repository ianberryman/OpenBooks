import {
  bankImportMappingPageSchema,
  bankImportMappingSchema,
  bankStatementImportPageSchema,
  bankStatementImportPreviewSchema,
  bankStatementImportQueuedSchema,
  bankStatementImportSchema,
  createBankImportMappingRequestSchema,
  createBankStatementImportRequestSchema,
  pageCursorSchema,
  previewBankStatementImportRequestSchema,
} from '@openbooks/shared-types';
import type {
  BankImportMapping,
  BankImportMappingPage,
  BankStatementImport,
  BankStatementImportPage,
  BankStatementImportPreview,
  BankStatementImportQueued,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  getBankImportMapping,
  getBankStatementImport,
  listBankImportMappings,
  listBankStatementImports,
  previewImportWithParsers,
  saveBankImportMapping,
  startImport,
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
 * Statement imports and the saved column mappings that drive them (OB-084, for OB-085;
 * ROADMAP D-41, D-47, D-49; acceptance E1, E10).
 *
 * ## Preview is a `POST` that reads, and it still carries an `Idempotency-Key`
 *
 * `previewBankStatementImport` writes nothing — it takes `banking.read` and returns what
 * an import *would* do (OB-085's column-mapping screen). It has to be a `POST` all the
 * same: the file travels in the body as text (`imports.ts` argues why — both formats are
 * text, an MCP tool has no multipart), and a body cannot ride a `GET`. That makes it the
 * one thing `reports.ts` deliberately avoided, a read-shaped `POST` — but the rule this
 * surface holds is “every non-`GET` carries a key”, asserted by enumerating the writes
 * out of the published document, and a read-`POST` with no key would turn that rule into
 * a rule with an allowlist. So preview requires the header like every other `POST` and
 * simply does not *claim* it: there is nothing to replay, because it changed nothing.
 *
 * ## Start is a `202`, not a `201`
 *
 * `startBankStatementImport` enqueues the parse and returns a queued handle — a
 * 5,000-line statement does not belong in a request (D-47, E10), so the request ends
 * before a line is read. The body is `BankStatementImportQueued`, deliberately smaller
 * than a finished import: a queued row has parsed nothing, so it has no result and no
 * dates to report. Re-submitting the same file under the same key replays the queue
 * claim rather than enqueuing twice; E1 makes a genuine re-upload harmless regardless.
 *
 * A screen then polls `GET /v1/bank-statement-imports/{importId}` from `queued` through
 * `processing` to `complete`/`failed` — the read carries the whole lifecycle, so one
 * shape answers a queued import and a completed one, and the `result` counts arrive with
 * `complete`. `GET /v1/bank-statement-imports` lists them, filtered by account.
 *
 * ## Where the mapping routes sit
 *
 * *Saving* a mapping hangs off the account (`POST /v1/bank-accounts/{bankAccountId}/
 * import-mappings`) — creating one is scoped to an account, and a missing account is a
 * 404. *Reading* them is a top-level collection: `GET /v1/import-mappings/{mappingId}`
 * for one, `GET /v1/import-mappings?bankAccountId=…` for a page. The list takes the
 * account as a query filter rather than a path segment because the service filters
 * rather than asserts — an unknown account is an empty page, not a 404 (E9) — and a
 * path parent would promise the 404 it does not give. There is no update-mapping route:
 * OB-084 has no mapping-update service to reach, so `updateBankImportMappingRequestSchema`
 * stays unpublished (the note in `imports.ts`).
 */

const IMPORT_TAG = 'bank-imports';
const MAPPING_TAG = 'bank-import-mappings';

const bankAccountParamsSchema = z.strictObject({ bankAccountId: z.uuid() });
const mappingParamsSchema = z.strictObject({ mappingId: z.uuid() });
const importParamsSchema = z.strictObject({ importId: z.uuid() });

/**
 * Local and carrying no `id`: a querystring is emitted as individual `parameters`.
 *
 * `bankAccountId` is a **required query filter**, not a path segment, because
 * `listBankImportMappings` filters rather than asserts: an unknown or cross-org account
 * answers with an empty page (its E9 uniform-filter behaviour), and an empty page is not
 * a path-parent 404. Routing it under `/v1/bank-accounts/{id}/…` would promise the 404 a
 * nested collection makes; a query filter promises the empty page the service actually
 * gives. (Creating a mapping stays account-scoped, and does 404 on a missing account.)
 */
const listMappingsWireQuerySchema = z.strictObject({
  bankAccountId: z.uuid(),
  limit: pageLimitQuery('mappings'),
  cursor: pageCursorSchema.optional(),
});

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listImportsWireQuerySchema = z.strictObject({
  bankAccountId: z.uuid().optional(),
  limit: pageLimitQuery('imports'),
  cursor: pageCursorSchema.optional(),
});

export function registerBankImportRoutes(app: App): void {
  app.post(
    '/v1/bank-statement-imports/preview',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'previewBankStatementImport',
        summary: 'Preview a statement import without writing',
        description:
          'Parses the file and reports what importing it would do — headers, a sample of mapped ' +
          'rows, and how many lines are new versus already present (a prediction, E1). Writes ' +
          'nothing. A `POST` because the file is in the body, and it carries an `Idempotency-Key` ' +
          'like every write on this surface even though it claims none.',
        tags: [IMPORT_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: previewBankStatementImportRequestSchema,
        response: { 200: bankStatementImportPreviewSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankStatementImportPreview> =>
      previewImportWithParsers(request.body, getContext()),
  );

  app.post(
    '/v1/bank-statement-imports',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'startBankStatementImport',
        summary: 'Start a statement import',
        description:
          'Accepts the file, writes a `queued` import row and enqueues the parse, then returns — ' +
          'the parse runs on the worker (D-47, E10). The `202` body is a handle to the queued ' +
          'import; it has no result yet. Re-uploading is safe: duplicates are deduped on a ' +
          'fingerprint and re-import never doubles a month (E1).',
        tags: [IMPORT_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createBankStatementImportRequestSchema,
        response: { 202: bankStatementImportQueuedSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'startBankStatementImport', request: request.body, successStatus: 202 },
        () => startImport(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankStatementImportQueued>(result));
    },
  );

  app.get(
    '/v1/bank-statement-imports',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBankStatementImports',
        summary: 'List statement imports',
        description:
          'One page, newest activity last by creation (D-21). Filter by `bankAccountId`; a ' +
          'malformed one filters to an empty page rather than 404ing (E9). Each import carries its ' +
          'lifecycle `status` and, once complete, its `result`.',
        tags: [IMPORT_TAG],
        querystring: listImportsWireQuerySchema,
        response: { 200: bankStatementImportPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankStatementImportPage> => {
      const { bankAccountId, limit, cursor } = request.query;
      return listBankStatementImports(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(bankAccountId === undefined ? {} : { bankAccountId }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/bank-statement-imports/:importId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBankStatementImport',
        summary: 'One statement import, at whatever stage it has reached',
        description:
          'The import across its whole lifecycle — the shape a screen polls after starting one. ' +
          '`queued`/`processing` carry neither `result` nor `failureReason`; `complete` carries ' +
          '`result` with the counts (E1); `failed` carries `failureReason`.',
        tags: [IMPORT_TAG],
        params: importParamsSchema,
        response: { 200: bankStatementImportSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankStatementImport> =>
      getBankStatementImport(request.params.importId, getContext()),
  );

  app.post(
    '/v1/bank-accounts/:bankAccountId/import-mappings',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'saveBankImportMapping',
        summary: 'Save a column mapping for a bank account',
        description:
          'Saves a named CSV column mapping against a bank account, reused across its monthly ' +
          'uploads (D-41). Editing a mapping never touches a line already imported through it — a ' +
          'statement line is what the bank said (D-42), and a file read under the wrong mapping is ' +
          're-imported under the right one.',
        tags: [MAPPING_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: bankAccountParamsSchema,
        body: createBankImportMappingRequestSchema,
        response: { 201: bankImportMappingSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { bankAccountId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'saveBankImportMapping',
          request: { bankAccountId, body: request.body },
          successStatus: 201,
        },
        () => saveBankImportMapping(bankAccountId, request.body, ctx),
      );

      const mapping = idempotentBody<BankImportMapping>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/import-mappings/${mapping.id}`)
        .send(mapping);
    },
  );

  app.get(
    '/v1/import-mappings',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBankImportMappings',
        summary: 'List a bank account’s saved mappings',
        description:
          'One page, oldest first (D-21), for the `bankAccountId` given. A malformed or cross-org ' +
          'account id answers with an empty page rather than a 404, so a filter that matches ' +
          'nothing behaves like an unknown one (E9) — which is why `bankAccountId` is a query ' +
          'filter here and not a path segment.',
        tags: [MAPPING_TAG],
        querystring: listMappingsWireQuerySchema,
        response: { 200: bankImportMappingPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankImportMappingPage> => {
      const { bankAccountId, limit, cursor } = request.query;
      return listBankImportMappings(
        bankAccountId,
        { limit, ...(cursor === undefined ? {} : { cursor }) },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/import-mappings/:mappingId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBankImportMapping',
        summary: 'One saved column mapping',
        tags: [MAPPING_TAG],
        params: mappingParamsSchema,
        response: { 200: bankImportMappingSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankImportMapping> =>
      getBankImportMapping(request.params.mappingId, getContext()),
  );
}
