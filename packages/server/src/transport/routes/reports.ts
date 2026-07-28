import {
  AGING_LEDGERS,
  CASH_FLOW_BUCKET_GRANULARITIES,
  CASH_FLOW_PROJECTION_HORIZON_MAX,
  MAX_DIMENSIONS_PER_ORG,
  agingSchema,
  balanceSheetSchema,
  calendarDateSchema,
  cashFlowProjectionSchema,
  generalLedgerSchema,
  pageCursorSchema,
  profitAndLossSchema,
  reportBasisSchema,
  reportDimensionFilterSchema,
  statementOfCashFlowsSchema,
  trialBalanceQuerySchema,
  trialBalanceSchema,
} from '@openbooks/shared-types';
import type { Aging, CashFlowProjection, GeneralLedger } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { getTrialBalance } from '../../modules/ledger';
import type { TrialBalance } from '../../modules/ledger';
import {
  getBalanceSheet,
  getCashFlowProjection,
  getGeneralLedger,
  getProfitAndLoss,
  getStatementOfCashFlows,
} from '../../modules/reports';
/**
 * Imported from the service file rather than from `modules/reports/index.ts`, which
 * is the one deviation in this directory and is deliberate rather than an oversight:
 * `getAging` is not re-exported by that barrel, and adding it there would be a change
 * to `src/modules/`, which this ticket may not make. The import is legal —
 * `transport-holds-no-business-logic` forbids reaching a `*.repository.ts` or `src/db`,
 * and this is neither — and the signature is the ordinary `(query, ctx)` every other
 * service has. Fold it into the barrel next time the module is open.
 */
import { getAging } from '../../modules/reports/aging.service';
import type { App } from '../types';
import { ERROR_RESPONSES, pageLimitQuery, requireOrgScope, wireList, wireValue } from './support';

/**
 * `/v1/reports` — the trial balance (A2), M2's three statements (OB-042, OB-043,
 * OB-044), and the aging and cash-flow statements that followed (OB-067, OB-157).
 *
 * ## All are `GET`, and the filters are the reason that took deciding
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
 * ## Aging is a `GET` too, and it needed no new convention
 *
 * OB-067 adds `GET /v1/reports/aging`, and the thing worth recording is what it did
 * *not* need. Every filter it takes is a scalar — a date, an enum, a contact id, two
 * booleans — so there is nothing here that a querystring cannot express and no reason
 * to reach for the JSON-in-one-parameter shape the three M2 reports use. Inventing a
 * second structured-filter convention for a report that has no structured filter
 * would have been the worst of both: `dimensions` is url-encoded JSON because it is
 * an array of objects and Node's parser produces flat strings, and that argument
 * simply does not apply to `asOf` and `detail`. The booleans are `z.stringbool()`,
 * which is the same single responsibility every other list query in this directory
 * has.
 *
 * `asOf` is required, unlike every other report's bound, and the reason is D-40's:
 * an aging report that defaulted to today would answer differently tomorrow, and the
 * request that produced a figure someone filed would no longer reproduce it.
 *
 * There is no pagination and no `groupBy`. The buckets must sum to a control account
 * (C8) and a page of them sums to nothing in particular, which is the same reason
 * `detail` is opt-in rather than a second endpoint: "what does this customer owe and
 * since when" is this report with `contactId` and `detail` set, and a second endpoint
 * would be a second definition of outstanding (D-34).
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

/**
 * Aging's filters, all of them scalar. Local and carrying no `id`, like every other
 * query schema in this directory: a querystring is emitted as individual
 * `parameters`.
 */
const agingWireQuerySchema = z.strictObject({
  asOf: calendarDateSchema.meta({
    description:
      'The date the report is computed as at. Required, unlike every other report’s bound: an ' +
      'aging report that defaulted to today would answer differently tomorrow, and D-40 makes ' +
      'reproducibility its point.',
  }),
  ledger: z.enum(AGING_LEDGERS).meta({
    description:
      '`receivable` ages invoices against what customers owe; `payable` ages bills against what ' +
      'is owed to vendors. Each ties to its own control account (C8).',
  }),
  contactId: z.uuid().optional().meta({
    description: 'One contact only. With `detail`, this is the statement for that customer.',
  }),
  detail: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Include the outstanding documents behind each row. Off by default — the list is bounded ' +
        'only by how many documents are open. Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, ' +
        '`on`/`off`).',
    }),
  includeZero: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Include contacts whose total is zero as at the date. Off by default: unlike a trial ' +
        'balance, where a zero row is how someone notices a posting went astray, a contact with ' +
        'nothing outstanding is simply a contact who has paid.',
    }),
});

const generalLedgerWireQuerySchema = z.strictObject({
  accountId: z.uuid(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  ...reportSliceWireShape,
  limit: pageLimitQuery('entries'),
  cursor: pageCursorSchema.optional(),
});

/**
 * The cash flow's filters: the range, and a `basis` override for `netIncome`. No
 * `contactId`, `dimensions` or `groupBy` — the statement is whole-org by
 * construction (`shared-types/reports/cash-flow.ts`).
 */
const cashFlowWireQuerySchema = z.strictObject({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  basis: reportBasisSchema.optional(),
});

/**
 * The cash-flow projection's filters (OB-158). `horizon` is the one numeric argument
 * on this surface's querystring, so it is the one field here that needs `z.coerce` —
 * every other query in this file is a date, a uuid or an enum, all of which arrive
 * already correct as text. `cashFlowProjectionQuerySchema` (the service's own, in
 * `shared-types`) takes a real number for the reason `pageLimitQuery` states: it is
 * also reachable from a caller that is not a route.
 */
const cashFlowProjectionWireQuerySchema = z.strictObject({
  asOf: calendarDateSchema.optional().meta({
    description:
      'The date the projection starts from. Defaults to today — unlike aging’s `asOf`, this is ' +
      'not a reproducibility guarantee the endpoint owes a caller, because a forward projection ' +
      'answers differently on every call regardless of the date it is pinned to.',
  }),
  granularity: z.enum(CASH_FLOW_BUCKET_GRANULARITIES).optional().meta({
    description: 'The width of one bucket, forward from `asOf`. Defaults to `monthly`.',
  }),
  horizon: z.coerce
    .number()
    .int()
    .min(1)
    .max(CASH_FLOW_PROJECTION_HORIZON_MAX)
    .optional()
    .meta({
      description:
        `How many buckets to project, at most ${String(CASH_FLOW_PROJECTION_HORIZON_MAX)}. ` +
        'Defaults to 12. Over the maximum is refused rather than clamped.',
    }),
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
    '/v1/reports/aging',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getAging',
        summary: 'Aging, as at a date',
        description:
          'What is owed and how late it is, per contact, split into current / 1–30 / 31–60 / ' +
          '61–90 / 90+ days past due — measured from the **due** date rather than the issue ' +
          'date, because that is what "overdue" means to the person chasing it (D-40). ' +
          'Aggregated over documents and allocations rather than over journal lines, which is ' +
          'what makes C8 worth asserting: `totals` must equal the control account’s balance at ' +
          '`asOf`, and an aging report that does not tie to the ledger is a list of hopes. That ' +
          'is why unapplied credit is in here at all — an unallocated payment or credit note is ' +
          'money already sitting in the control account, so it appears as a **negative** amount ' +
          'in `current` on the contact holding it, and a report that omitted it would overstate ' +
          'what the business is owed by exactly that much. The report deliberately does not ' +
          'state the control-account balance itself: an org that has nominated nothing has none ' +
          'to state, and a reconciliation that is sometimes reported is one nobody trusts. ' +
          'Everything is computed as at `asOf`, including each document’s `outstanding`, so last ' +
          'month’s aging still prints last month’s figures next year. Not paginated, on purpose: ' +
          'a page of buckets sums to nothing in particular. Takes `reports.read` and only that.',
        tags: [TAG],
        querystring: agingWireQuerySchema,
        response: { 200: agingSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Aging> => {
      const { asOf, ledger, contactId, detail, includeZero } = request.query;
      const aging = await getAging(
        {
          asOf,
          ledger,
          ...(contactId === undefined ? {} : { contactId }),
          ...(detail === undefined ? {} : { detail }),
          ...(includeZero === undefined ? {} : { includeZero }),
        },
        getContext(),
      );

      return wireValue(aging);
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

  app.get(
    '/v1/reports/cash-flow',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getStatementOfCashFlows',
        summary: 'Statement of cash flows (indirect method)',
        description:
          'Net income for the period, the literal change in the org’s cash accounts, and the ' +
          'difference between them as a single "adjustments to reconcile net income to net ' +
          'cash" line (D-88). Cash accounts are every account registered in `bank_accounts` ' +
          'plus every account flagged `cash_basis_role: cash`. There is no categorized ' +
          'operating/investing/financing split in this increment — a wrong split would be worse ' +
          'than the honest reconciliation this reports instead — and no contact, dimension or ' +
          '`groupBy` filter, since the statement is whole-org by construction. `basis` overrides ' +
          'the org default for `netIncome` only; the cash movement itself is always accrual, ' +
          'because which account a payment landed in is not a recognition question.',
        tags: [TAG],
        querystring: cashFlowWireQuerySchema,
        response: { 200: statementOfCashFlowsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<z.infer<typeof statementOfCashFlowsSchema>> => {
      const { from, to, basis } = request.query;
      const statement = await getStatementOfCashFlows(
        {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(basis === undefined ? {} : { basis }),
        },
        getContext(),
      );

      return wireValue(statement);
    },
  );

  app.get(
    '/v1/reports/cash-flow-projection',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getCashFlowProjection',
        summary: 'Forward cash-flow projection',
        description:
          'Forecasts cash forward from `asOf`: opening cash — this org’s cash and bank account ' +
          'balances at the close of that date — plus outstanding invoices (money in) and bills ' +
          '(money out) bucketed by **due date** rather than by how overdue they are, projected ' +
          'across `horizon` buckets of `granularity` width. An amount already overdue lands in ' +
          'the earliest bucket instead of being excluded — it is money expected now, not money a ' +
          'stale due date should hide. `includesRecurringCommitments` is always `false`: ' +
          'recurring journals do not exist yet, so this forecast only knows about money already ' +
          'sitting in the AR/AP subledgers as an invoice or a bill. Takes `reports.read` and ' +
          'only that.',
        tags: [TAG],
        querystring: cashFlowProjectionWireQuerySchema,
        response: { 200: cashFlowProjectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<CashFlowProjection> => {
      const { asOf, granularity, horizon } = request.query;
      const projection = await getCashFlowProjection(
        {
          ...(asOf === undefined ? {} : { asOf }),
          ...(granularity === undefined ? {} : { granularity }),
          ...(horizon === undefined ? {} : { horizon }),
        },
        getContext(),
      );

      return wireValue(projection);
    },
  );
}
