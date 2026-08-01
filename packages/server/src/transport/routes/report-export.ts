import { exportReportQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import { exportReport } from '../../modules/reports/export';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';
import { requireOrgScope } from './support';

/**
 * `GET /v1/reports/export` (OB-220 part 2) — CSV/Excel export for the seven
 * tabular-friendly reports named by `ReportExportKind`.
 *
 * ## Why this is one route and not a `?format=` on each report route
 *
 * `shared-types/reports/export.ts`'s file header gives the reasoning at length;
 * restated for this file's own concern, the transport one: every other route in
 * `reports.ts` returns a schema-checked JSON body, and an export returns a file,
 * so its `response` shape is nothing like theirs. Bolting a file response onto
 * nine existing operations would mean nine routes each declaring two success
 * shapes; one new route with its own `report` selector declares one.
 *
 * ## Why there is no `200` response schema
 *
 * The same reason `public-invoices.ts`'s PDF route has none: the success body is
 * raw bytes (CSV text or a `.xlsx`'s binary), not JSON, so there is no Zod shape
 * for `fastify-type-provider-zod`'s serializer compiler to check it against.
 * `response: { default: errorResponseSchema }` is the only declared shape, and
 * Fastify falls back to its own default reply handling for `200`, which sends a
 * `Buffer` payload as-is.
 *
 * ## Authorization
 *
 * `requireOrgScope` here is the same non-permission org-scoping hook every other
 * route in this directory uses (`support.ts` explains why it must not itself
 * become a permission check); the actual authority is
 * `exportReport`'s own `requirePermission(ctx, 'reports.read')`, matching
 * `reports.ts`'s rule that each service states its own authority.
 */
const TAG = 'reports';

export function registerReportExportRoutes(app: App): void {
  app.get(
    '/v1/reports/export',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'exportReport',
        summary: 'Export a report as CSV or Excel',
        description:
          'Runs the same report service the JSON route runs — trial balance, profit and loss, ' +
          'balance sheet, general ledger, aging, cash flow, or budget vs actual — flattens the ' +
          'result into a canonical table, and returns it as `text/csv` or a real `.xlsx` ' +
          'workbook. The figures can never disagree with the on-screen report: there is no second ' +
          'aggregation here, only a different serialisation of the same service call. `report` and ' +
          '`format` are required; every other field is a filter one or more of the reports read, ' +
          'and a report missing a filter it requires (general ledger’s `accountId`, aging’s ' +
          '`ledger`/`asOf`, budget vs actual’s `periodId`) gets that report’s own validation error. ' +
          'Dimension filters and `groupBy` are not carried by this endpoint — an export is the ' +
          'report’s flat rows, not a caller-chosen slice of them.',
        tags: [TAG],
        querystring: exportReportQuerySchema,
        // The success body is raw file bytes, not JSON — see the file header for why `200`
        // is deliberately undeclared here, matching `public-invoices.ts`'s PDF route.
        response: { default: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { filename, contentType, bytes } = await exportReport(request.query, getContext());

      // The zod type provider constrains `send` to the declared response shapes, and the
      // only one here is the error `default` (the header explains why `200` is undeclared).
      // The success body is raw bytes, so it is cast past that constraint; Fastify sends a
      // `Buffer` payload as-is.
      return reply
        .header('content-type', contentType)
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(Buffer.from(bytes) as never);
    },
  );
}
