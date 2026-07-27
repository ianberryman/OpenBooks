import {
  MAX_DIMENSIONS_PER_ORG,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  balanceSheetSchema,
  calendarDateSchema,
  generalLedgerSchema,
  pageCursorSchema,
  profitAndLossSchema,
  reportDimensionFilterSchema,
  trialBalanceQuerySchema,
  trialBalanceSchema,
} from '@openbooks/shared-types';
import type { GeneralLedger } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { getTrialBalance } from '../../modules/ledger';
import type { TrialBalance } from '../../modules/ledger';
import { getBalanceSheet, getGeneralLedger, getProfitAndLoss } from '../../modules/reports';
import type { App } from '../types';
import { ERROR_RESPONSES, requireOrgScope, wireList, wireValue } from './support';

/**
 * `/v1/reports` — the trial balance (A2) and M2's three statements (OB-042,
 * OB-043, OB-044).
 *
 * ## All four are `GET`, and the filters are the reason that took deciding
 *
 * Reads take no `Idempotency-Key` and run no `withIdempotency`: there is nothing to
 * execute at most once. That also means these responses are typed end to end rather
 * than cast — each service's return type is checked against the response schema by
 * the compiler, which is the assertion the write routes have to make by hand.
 *
 * The cost of `GET` is `dimensions`, which is the one structured argument in this
 * API that has to cross a querystring. It is an array of objects — an axis, the
 * values to include, and whether to include the untagged bucket — and Node's
 * querystring parser produces flat strings, so there is no bracket or `deepObject`
 * notation available to express it. Three options existed:
 *
 * 1. **`POST` with a JSON body.** Rejected. Every non-`GET` operation in this
 *    surface is a write requiring an `Idempotency-Key` (spec §12), asserted by a
 *    test that enumerates the route table rather than a hand-written list. A
 *    read-only `POST` would turn that rule into a rule-with-an-allowlist, which is
 *    a much worse trade than an awkward parameter. It would also make every report
 *    uncacheable and unlinkable, and OB-052's drill-through is a link.
 * 2. **An invented compact grammar**, `dimension=<axis>:<value>,<value>`. Rejected
 *    because it is a parser, and a parser in this directory is the business logic
 *    spec §2.4 keeps out: its failures would be hand-written messages that do not
 *    match the ones `reportDimensionFilterSchema` produces for the same mistake.
 * 3. **JSON in one parameter**, which is what this does. The only thing the route
 *    adds is `JSON.parse`, which is the same single responsibility as the
 *    `z.stringbool()` and `z.coerce.number()` on every other list query — text
 *    arrived, and this is the layer that knows it. Everything after the parse is
 *    the shared schema, so a malformed filter earns the message the schema already
 *    writes, wherever it came from.
 *
 * What option 3 costs, stated because it is the part a client feels: the filter is
 * a `string` in the published document rather than a `$ref`, so a generated client
 * types it as text. Publishing `ReportDimensionFilter` as a component anyway would
 * put a schema in `components.schemas` that no operation references, which is the
 * thing the `.meta({ id })` rule exists to prevent. The description below carries
 * the shape instead.
 *
 * ## Why the general ledger is not `{ items, nextCursor }`
 *
 * D-21's envelope is for lists, and a general-ledger page is a report that contains
 * one: the account, the range, and the opening / movement / closing balances are the
 * subject, and the entries are the working that explains them. `generalLedgerSchema`
 * carries the full argument. The paging *protocol* is unchanged — `nextCursor` is
 * the same opaque `PageCursor`, meaning the same thing — so only the key the entries
 * sit under differs.
 *
 * ## Nothing here re-checks a permission
 *
 * `GET /v1/auth/me` already publishes the caller's permission set so a screen can
 * hide what it must not offer (D-25), and that set is advisory by design. Each of
 * these four services calls `requirePermission(ctx, 'reports.read')` itself — the
 * report services do so a second time over the core's own check, deliberately, so
 * each states its own authority rather than inheriting one from a function it
 * happens to call. `requireOrgScope` below is not a permission check and must not
 * become one; `support.ts` says why it cannot diverge from the service's.
 */

const TAG = 'reports';

/**
 * The shared dimension filter, carried as JSON in one parameter.
 *
 * The `.transform` fails through `ctx.addIssue` rather than throwing, so a
 * malformed document is a `validation_failed` naming `dimensions` — the same
 * envelope a bad `asOf` gets — instead of a 500. Everything downstream of the parse
 * is `reportDimensionFilterSchema` itself, including the refusal of a filter that
 * names neither values nor the unassigned bucket.
 *
 * Bounded by `MAX_DIMENSIONS_PER_ORG` here as well as in each report's own query,
 * because this bound is what stops an unbounded array being built out of a
 * querystring before any schema has looked at it.
 */
const dimensionFiltersQuerySchema = z
  .string()
  .transform((raw, ctx): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'Expected a JSON array of dimension filters, url-encoded. Example: ' +
          '[{"dimensionId":"…","valueIds":["…"]}]',
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(reportDimensionFilterSchema).max(MAX_DIMENSIONS_PER_ORG))
  .meta({
    contentMediaType: 'application/json',
    description:
      'A url-encoded JSON array of dimension filters. Each entry is `{ "dimensionId": uuid, ' +
      '"valueIds"?: uuid[], "includeUnassigned"?: boolean }`. Filters on different axes are ' +
      'conjoined; the values within one are a disjunction. `includeUnassigned` is the ' +
      'drill-through from a grouped report’s unassigned bucket, which no list of value ids can ' +
      'express. Two filters naming the same axis is refused rather than silently matching ' +
      'nothing.',
  });

/** The two filters every M2 report takes, minus the report-specific ones. */
const reportSliceWireShape = {
  contactId: z.uuid().optional().meta({
    description: 'Only lines naming this contact. Not a subledger — that is M3.',
  }),
  dimensions: dimensionFiltersQuerySchema.optional(),
};

const groupByWireSchema = z
  .uuid()
  .optional()
  .meta({
    description:
      'A dimension axis to slice by. The result is one bucket per value the window contains plus ' +
      'an unassigned bucket, which is always present (D-18) — a slice view that omitted untagged ' +
      'lines would show a smaller business than exists. One axis, not several: two would be a ' +
      'cross-tabulation, which is a different presentation problem.',
  });

const profitAndLossWireQuerySchema = z.strictObject({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  ...reportSliceWireShape,
  groupBy: groupByWireSchema,
});

const balanceSheetWireQuerySchema = z.strictObject({
  asOf: calendarDateSchema,
  ...reportSliceWireShape,
  groupBy: groupByWireSchema,
});

const generalLedgerWireQuerySchema = z.strictObject({
  accountId: z.uuid(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  ...reportSliceWireShape,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT)
    .meta({
      description:
        'How many entries to return, at most. Over the maximum is refused rather than clamped, ' +
        'so a short page always means the list is short.',
    }),
  cursor: pageCursorSchema.optional(),
});

export function registerReportRoutes(app: App): void {
  app.get(
    '/v1/reports/trial-balance',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTrialBalance',
        summary: 'Trial balance',
        description:
          'Debit and credit totals per account plus the org-wide totals, which must be equal. ' +
          'A direct aggregation over journal lines — there is no balance cache in M1, because a ' +
          'stale one produces books that balance on screen and not in the data.',
        tags: [TAG],
        querystring: trialBalanceQuerySchema,
        response: { 200: trialBalanceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<z.infer<typeof trialBalanceSchema>> => {
      const { asOf } = request.query;
      // No context argument: `getTrialBalance` defaults it from the ambient scope, and
      // spec §4 is explicit that the org must not travel as a parameter.
      const balance: TrialBalance = await getTrialBalance(asOf === undefined ? {} : { asOf });

      return { ...balance, rows: wireList(balance.rows) };
    },
  );

  app.get(
    '/v1/reports/profit-and-loss',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getProfitAndLoss',
        summary: 'Profit and loss',
        description:
          'Revenue and expense over an inclusive date range, with hierarchy subtotals and net ' +
          'income. Amounts are signed to their section — a positive revenue figure is money ' +
          'earned, a positive expense figure is money spent — and the flip keys off the ' +
          'account’s `type` and never its `normalBalance`, so a contra-revenue account ' +
          'subtracts from revenue as a discount should. Every account of the type appears, ' +
          'including those with no postings in the period. There is no `types` filter: a profit ' +
          'and loss is revenue and expense by definition. Accrual basis only in M2 (D-22), and ' +
          'the response says so rather than leaving it to be assumed.',
        tags: [TAG],
        querystring: profitAndLossWireQuerySchema,
        response: { 200: profitAndLossSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<z.infer<typeof profitAndLossSchema>> => {
      const { from, to, contactId, dimensions, groupBy } = request.query;
      const report = await getProfitAndLoss(
        {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(dimensions === undefined ? {} : { dimensions }),
          ...(groupBy === undefined ? {} : { groupBy }),
        },
        getContext(),
      );

      return wireValue(report);
    },
  );

  app.get(
    '/v1/reports/balance-sheet',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBalanceSheet',
        summary: 'Balance sheet',
        description:
          'Assets, liabilities and equity as at `asOf`, with hierarchy subtotals and the two ' +
          'derived earnings lines that make the sheet balance without a year-end closing ' +
          'journal (D-20): `priorYearEarnings` for every fiscal year before the one containing ' +
          '`asOf`, and `currentYearEarnings` for that year to date. Neither is an account — an ' +
          'org’s own retained-earnings account is an ordinary equity account and is counted ' +
          'once, in `equity`. `asOf` is required, unlike the trial balance’s: the fiscal year ' +
          'the derivation is scoped to is resolved from it, so an omitted date would have to ' +
          'come from the process clock and the same request would return different numbers on ' +
          'either side of a year end. There is no `types` filter, and could not be: the derived ' +
          'lines are computed from the revenue and expense accounts one would remove.',
        tags: [TAG],
        querystring: balanceSheetWireQuerySchema,
        response: { 200: balanceSheetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<z.infer<typeof balanceSheetSchema>> => {
      const { asOf, contactId, dimensions, groupBy } = request.query;
      const sheet = await getBalanceSheet(
        {
          asOf,
          ...(contactId === undefined ? {} : { contactId }),
          ...(dimensions === undefined ? {} : { dimensions }),
          ...(groupBy === undefined ? {} : { groupBy }),
        },
        getContext(),
      );

      return wireValue(sheet);
    },
  );

  app.get(
    '/v1/reports/general-ledger',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getGeneralLedger',
        summary: 'General ledger for one account',
        description:
          'The balance the account was carrying, one page of the lines that moved it, and the ' +
          'balance it ended on — `opening + movement = closing` (B4). Ordered oldest first by ' +
          'entry date, then the org’s own entry number, then the line, which is a total order ' +
          'and therefore a cursor that cannot skip or repeat a row. The three balances ride on ' +
          'every page rather than only the first, and are recomputed each time: a back-dated ' +
          'entry posted between two fetches moves `closing`, and a client comparing two pages’ ' +
          'headers can see that it did. `counterparty` names the accounts on the *opposite* ' +
          'debit/credit side of the same journal, with no amount apportioned to any of them — a ' +
          'journal records that its debits equal its credits, not which debit paid for which ' +
          'credit. There is no `groupBy`: dividing a list of individual lines into columns is a ' +
          'cross-tabulation and not a ledger.',
        tags: [TAG],
        querystring: generalLedgerWireQuerySchema,
        response: { 200: generalLedgerSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<GeneralLedger> => {
      const { accountId, from, to, contactId, dimensions, limit, cursor } = request.query;
      return getGeneralLedger(
        {
          accountId,
          limit,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(dimensions === undefined ? {} : { dimensions }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        getContext(),
      );
    },
  );
}
