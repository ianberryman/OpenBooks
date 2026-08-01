import {
  efileTen99RunRequestSchema,
  generateTen99RunRequestSchema,
  ten99RunListSchema,
  ten99RunSchema,
  ten99WorksheetSchema,
  upsertVendorTaxProfileRequestSchema,
  vendorTaxProfileSchema,
} from '@openbooks/shared-types';
import type { Ten99Run, VendorTaxProfile } from '@openbooks/shared-types';
import { z } from 'zod';

import { withIdempotency } from '../../modules/idempotency';
import {
  computeTen99Worksheet,
  efileTen99Run,
  generateTen99Run,
  getTen99FilingStatus,
  getTen99Run,
  getVendorTaxProfile,
  listTen99Runs,
  listVendorTaxProfiles,
  renderTen99FormPdf,
  upsertVendorTaxProfile,
} from '../../modules/ten99';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/vendor-tax-profiles` and `/v1/ten99` — 1099 contractor tax reporting (OB-228,
 * transport for `modules/ten99`).
 *
 * Handlers map arguments and hold no logic (spec §2.4); every operation gates on
 * `ten99.read` or `ten99.write` in the service, not here. A vendor tax profile
 * `PUT` is a write like any other (records/updates a row, may replace the encrypted
 * TIN) so it carries an `Idempotency-Key` and wraps the service in `withIdempotency`
 * exactly like every other write on this surface — "upsert" describes the service's
 * behaviour, not an exemption from the replay contract. Generating a run and
 * e-filing one are writes for the same reason: both are one-shot actions a
 * double-click must not repeat (a second generate must not re-snapshot the same
 * forms, a second e-file must not resubmit).
 *
 * `getTen99FormPdf` streams raw PDF bytes and declares no `200` response schema,
 * `public-invoices.ts`'s `getPublicInvoicePdf` shape — the difference here is this
 * route is session-scoped (`ten99.read`) rather than token-authorized, so it sits
 * behind `requireOrgScope` like every other read in this file.
 */

const TAG = '1099';

const vendorTaxProfileParamsSchema = z.strictObject({ contactId: z.uuid() });
const ten99RunParamsSchema = z.strictObject({ runId: z.uuid() });
const ten99FormParamsSchema = z.strictObject({ formId: z.uuid() });

const vendorTaxProfileListSchema = z
  .strictObject({ profiles: z.array(vendorTaxProfileSchema) })
  .meta({
    id: 'VendorTaxProfileList',
    description: "The org's vendor 1099 tax profiles.",
  });

/**
 * The worksheet's querystring. `taxYear` is a real number in the service and shared
 * `Ten99Worksheet`/`computeTen99Worksheet` shapes; the querystring carries it as
 * text like every other numeric filter on this surface (`pageLimitQuery`,
 * `cashFlowProjectionWireQuerySchema`'s `horizon`), so it is `z.coerce`d here.
 * `threshold` maps onto the service's `thresholdMinor` — the wire name matches
 * `generateTen99RunRequestSchema`'s own `thresholdMinor` in spirit but is shortened
 * for the querystring the way `reports.ts`'s `limit`/`cursor` are, and mapped onto
 * the service's field name in the handler rather than the schema, so the JSON body
 * and the querystring can each use the name that reads best in their own shape.
 */
const ten99WorksheetWireQuerySchema = z.strictObject({
  taxYear: z.coerce.number().int().min(2000).max(2100).meta({
    description: 'The calendar tax year to roll up cash payments for.',
  }),
  threshold: z.string().optional().meta({
    description:
      'Override the reporting threshold, cents-only (D-13). Absent uses the NEC default ($600).',
  }),
});

export function registerTen99Routes(app: App): void {
  app.put(
    '/v1/vendor-tax-profiles/:contactId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'upsertVendorTaxProfile',
        summary: "Create or update a vendor's 1099 tax profile",
        description:
          "Creates or replaces one contact's 1099/W-9 profile. `taxId` is write-only (D-228-2): " +
          'present sets or replaces the encrypted TIN, `null` clears it, absent leaves it ' +
          'untouched — the response never echoes it back, only `taxIdLast4`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: vendorTaxProfileParamsSchema,
        body: upsertVendorTaxProfileRequestSchema,
        response: { 200: vendorTaxProfileSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { contactId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'upsertVendorTaxProfile',
          request: { contactId, patch: request.body },
          successStatus: 200,
        },
        () => upsertVendorTaxProfile({ contactId, ...request.body }),
      );

      return reply.status(result.status).send(idempotentBody<VendorTaxProfile>(result));
    },
  );

  app.get(
    '/v1/vendor-tax-profiles/:contactId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getVendorTaxProfile',
        summary: "One vendor's 1099 tax profile",
        tags: [TAG],
        params: vendorTaxProfileParamsSchema,
        response: { 200: vendorTaxProfileSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<VendorTaxProfile> => getVendorTaxProfile(request.params.contactId),
  );

  app.get(
    '/v1/vendor-tax-profiles',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listVendorTaxProfiles',
        summary: "Every vendor's 1099 tax profile",
        tags: [TAG],
        response: { 200: vendorTaxProfileListSchema, ...ERROR_RESPONSES },
      },
    },
    async () => {
      const { profiles } = await listVendorTaxProfiles();
      return { profiles: [...profiles] };
    },
  );

  app.get(
    '/v1/ten99/worksheet',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTen99Worksheet',
        summary: 'The calendar-year 1099 worksheet',
        description:
          'Cash actually paid to each 1099-eligible vendor in the tax year (card/third-party ' +
          'payments excluded, D-228-3/4), with the review flags a human needs before generating ' +
          'a run — over threshold, has a TIN on file, likely-exempt classification.',
        tags: [TAG],
        querystring: ten99WorksheetWireQuerySchema,
        response: { 200: ten99WorksheetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { taxYear, threshold } = request.query;
      return computeTen99Worksheet({
        taxYear,
        ...(threshold === undefined ? {} : { thresholdMinor: threshold }),
      });
    },
  );

  app.post(
    '/v1/ten99/runs',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'generateTen99Run',
        summary: 'Generate a 1099 filing run',
        description:
          'Snapshots one immutable form per eligible vendor at or over the threshold for a tax ' +
          'year (D-228-5). `contactIds` narrows to a subset; absent takes every over-threshold ' +
          'eligible vendor.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: generateTen99RunRequestSchema,
        response: { 200: ten99RunSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withIdempotency(
        { endpoint: 'generateTen99Run', request: request.body, successStatus: 200 },
        () => generateTen99Run(request.body),
      );

      return reply.status(result.status).send(idempotentBody<Ten99Run>(result));
    },
  );

  app.get(
    '/v1/ten99/runs',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listTen99Runs',
        summary: "The org's 1099 filing runs",
        description: 'Every filing run this org has generated, newest first.',
        tags: [TAG],
        response: { 200: ten99RunListSchema, ...ERROR_RESPONSES },
      },
    },
    async () => listTen99Runs(),
  );

  app.get(
    '/v1/ten99/runs/:runId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTen99Run',
        summary: 'One 1099 filing run',
        tags: [TAG],
        params: ten99RunParamsSchema,
        response: { 200: ten99RunSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Ten99Run> => getTen99Run(request.params.runId),
  );

  app.get(
    '/v1/ten99/forms/:formId/pdf',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTen99FormPdf',
        summary: 'The recipient Copy B PDF for one filed 1099 form',
        description:
          'Streams the rendered Copy B PDF for one immutable form on a filing run. Gated on ' +
          '`ten99.read`, the same permission every other read in this file takes.',
        tags: [TAG],
        params: ten99FormParamsSchema,
        // The success body is raw PDF bytes, not a Zod-describable shape — see the file
        // header and `public-invoices.ts`'s `getPublicInvoicePdf`, which states the same
        // reasoning for leaving `200` undeclared.
        response: ERROR_RESPONSES,
      },
    },
    async (request, reply) => {
      const bytes = await renderTen99FormPdf(request.params.formId);

      // The zod type provider constrains `send` to the declared response shapes, and
      // the only one here is the error `default`. The cast is the same one
      // `public-invoices.ts`'s PDF route makes, for the same reason.
      return reply.header('content-type', 'application/pdf').send(Buffer.from(bytes) as never);
    },
  );

  app.post(
    '/v1/ten99/runs/:runId/efile',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'efileTen99Run',
        summary: 'Submit a 1099 filing run for e-file',
        description:
          'Submits a generated run to an e-file provider. `manual` (the default) returns the ' +
          'IRIS file to download rather than transmitting anything itself.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: ten99RunParamsSchema,
        body: efileTen99RunRequestSchema,
        response: { 200: ten99RunSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { runId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'efileTen99Run',
          request: { runId, ...request.body },
          successStatus: 200,
        },
        () => efileTen99Run({ runId, ...request.body }),
      );

      return reply.status(result.status).send(idempotentBody<Ten99Run>(result));
    },
  );

  app.get(
    '/v1/ten99/runs/:runId/status',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTen99RunStatus',
        summary: 'The e-file status of one 1099 filing run',
        tags: [TAG],
        params: ten99RunParamsSchema,
        response: { 200: ten99RunSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Ten99Run> => getTen99FilingStatus(request.params.runId),
  );
}
