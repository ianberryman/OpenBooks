import {
  closePeriodRequestSchema,
  createFiscalPeriodRequestSchema,
  fiscalPeriodListSchema,
  fiscalPeriodSchema,
  generateFiscalYearRequestSchema,
  generatedFiscalYearSchema,
  listFiscalPeriodsQuerySchema,
  periodCloseChecklistSchema,
  reopenPeriodRequestSchema,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { withIdempotency } from '../../modules/idempotency';
import {
  closePeriod,
  computeCloseChecklist,
  createPeriod,
  generateFiscalYear,
  listPeriods,
  reopenPeriod,
} from '../../modules/periods';
import type { FiscalPeriod, GeneratedFiscalYear } from '../../modules/periods';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/fiscal-periods` and `/v1/fiscal-years` — the accounting calendar (spec §7;
 * ROADMAP D-08, D-17).
 *
 * ## Two path roots for one concept, on purpose
 *
 * Generating a year is not "creating a period with extra steps": it produces twelve
 * contiguous periods whose gaplessness is a property of the generation, and its
 * request names a year rather than a month. Hanging it off `/v1/fiscal-periods` would
 * have to be either a magic path segment or a discriminated body, and both read as
 * one endpoint doing two things. `/v1/fiscal-years` is the resource that actually
 * gets created.
 *
 * ## Generation is explicit, and there is no route that makes it otherwise
 *
 * D-17 is emphatic: nothing creates a period as a side effect of posting into it,
 * because that would let a posting silently manufacture a period inside a year that
 * had already been closed — the reverse of what closing a year is for. The visible
 * consequence at this layer is that onboarding must call `POST /v1/fiscal-years`
 * before the first journal, and `POST /v1/journals` answers `precondition_failed`
 * until it has. That is a prerequisite, not a rough edge.
 *
 * ## Close and reopen are separate operations with separate permissions
 *
 * Closing is the routine monthly soft close. Reopening withdraws a statement that has
 * already been relied on — figures were reported, a return may have been filed — so
 * it is a restatement requiring the authority that answers for it. Both are `POST`s
 * to named sub-resources rather than a `PATCH` setting `status`, because a `PATCH`
 * would make them one operation and therefore one permission, and the split is
 * precisely what lets an org keep the monthly close with a bookkeeper and
 * restatement with the owner.
 */

const TAG = 'fiscal-periods';

const periodParamsSchema = z.strictObject({ periodId: z.uuid() });

export function registerPeriodRoutes(app: App): void {
  app.post(
    '/v1/fiscal-years',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'generateFiscalYear',
        summary: 'Generate the twelve periods of a fiscal year',
        description:
          'The month the year begins in comes from the org’s `fiscalYearStartMonth`, not from ' +
          'the request — a caller that could choose it per call could generate two overlapping ' +
          'years for one org.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: generateFiscalYearRequestSchema,
        response: { 201: generatedFiscalYearSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withIdempotency(
        { endpoint: 'generateFiscalYear', request: request.body, successStatus: 201 },
        () => generateFiscalYear(request.body),
      );

      return reply.status(result.status).send(idempotentBody<WireGeneratedFiscalYear>(result));
    },
  );

  app.post(
    '/v1/fiscal-periods',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createFiscalPeriod',
        summary: 'Create one monthly period',
        description:
          'For the partial first year a business that started in September actually has. ' +
          'Gaplessness is a property of year generation, not of the table, so a year built one ' +
          'month at a time can leave a hole — and a date in that hole is un-postable.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createFiscalPeriodRequestSchema,
        response: { 201: fiscalPeriodSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withIdempotency(
        { endpoint: 'createFiscalPeriod', request: request.body, successStatus: 201 },
        () => createPeriod(request.body),
      );

      return reply.status(result.status).send(idempotentBody<WireFiscalPeriod>(result));
    },
  );

  app.get(
    '/v1/fiscal-periods',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listFiscalPeriods',
        summary: 'List fiscal periods',
        tags: [TAG],
        querystring: listFiscalPeriodsQuerySchema,
        response: { 200: fiscalPeriodListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { status } = request.query;
      const periods = await listPeriods(status === undefined ? {} : { status });
      return { periods: wireList(periods) };
    },
  );

  app.get(
    '/v1/fiscal-periods/:periodId/close-checklist',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getPeriodCloseChecklist',
        summary: 'Preview the advisory close checklist for a period',
        description:
          'The completeness checks the close workflow surfaces — unposted drafts in the period, ' +
          'unreconciled bank lines, a still-open prior period (OB-193, D-97). Advisory: a warning ' +
          'never blocks the close, and this read has no side effect. The same snapshot is ' +
          'recomputed and recorded when the period is actually closed.',
        tags: [TAG],
        params: periodParamsSchema,
        response: { 200: periodCloseChecklistSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => computeCloseChecklist({ periodId: request.params.periodId }),
  );

  // Close and reopen each take an optional note — a sign-off note on a close, a reason
  // on a reopen (OB-193, D-97) — so their bodies differ by schema id even though both
  // are `{ note? }`. The workflow (the checklist recompute + the recorded
  // `period_close_events` row) lives in the service; this only carries the note in.
  for (const route of [
    {
      path: '/v1/fiscal-periods/:periodId/close',
      operationId: 'closeFiscalPeriod',
      summary: 'Close a fiscal period',
      description:
        'The routine monthly soft close. Records who closed it, when, and the advisory checklist ' +
        'at sign-off. A posting dated inside a closed period is refused (A4), and a posting racing ' +
        'this call either commits fully or not at all (A9).',
      body: closePeriodRequestSchema,
      run: closePeriod,
    },
    {
      path: '/v1/fiscal-periods/:periodId/reopen',
      operationId: 'reopenFiscalPeriod',
      summary: 'Reopen a closed fiscal period',
      description:
        'Withdraws a statement that may already have been relied on, so it needs the separate ' +
        '`periods.reopen` permission rather than the one that closes. The reason is recorded.',
      body: reopenPeriodRequestSchema,
      run: reopenPeriod,
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
          params: periodParamsSchema,
          body: route.body,
          response: { 200: fiscalPeriodSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const { periodId } = request.params;
        const { note } = request.body;
        const input = { periodId, ...(note === undefined ? {} : { note }) };
        const result = await withIdempotency(
          { endpoint: route.operationId, request: input, successStatus: 200 },
          () => route.run(input),
        );

        return reply.status(result.status).send(idempotentBody<WireFiscalPeriod>(result));
      },
    );
  }
}

/**
 * The wire shapes, and the compile-time link between them and the service's.
 *
 * `idempotentBody` casts, because a replayed body comes out of a `JSON` column and no
 * compiler can know its shape. These two lines are what stop that cast from being a
 * blind one: the service's `FiscalPeriod` and `GeneratedFiscalYear` must remain
 * assignable to what the response schemas describe, so a field added to either — or a
 * `status` the `fiscal_periods` `ENUM` grew that `PERIOD_STATUSES` does not name —
 * fails to compile here rather than serializing to a 500 at runtime.
 */
type WireFiscalPeriod = z.infer<typeof fiscalPeriodSchema>;
type WireGeneratedFiscalYear = z.infer<typeof generatedFiscalYearSchema>;

type AssertAssignable<_Narrow extends _Wide, _Wide> = true;

/**
 * The services return `readonly` arrays and `z.array()` infers mutable ones (see
 * `wireList` in `./support.ts`), so the comparison is made on a mutable projection
 * rather than being weakened to ignore the arrays.
 */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[] ? E[] : T[K];
};

export type _FiscalPeriodMatchesWire = AssertAssignable<FiscalPeriod, WireFiscalPeriod>;
export type _GeneratedFiscalYearMatchesWire = AssertAssignable<
  Mutable<GeneratedFiscalYear>,
  WireGeneratedFiscalYear
>;
