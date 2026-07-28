import type {
  CashFlowBucketGranularity,
  CashFlowProjection,
  CashFlowProjectionBucket,
  CashFlowProjectionQueryParams,
} from '@openbooks/shared-types';
import {
  CASH_FLOW_PROJECTION_GRANULARITY_DEFAULT,
  CASH_FLOW_PROJECTION_HORIZON_DEFAULT,
  cashFlowProjectionQuerySchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid } from '../../db';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { AgingDocumentRow } from './aging.repository';
import { selectApDocuments, selectArDocuments } from './aging.repository';
import { orgScope } from './balances.repository';
import { getAccountBalances } from './balances.service';

/**
 * The forward cash-flow projection (OB-158; ROADMAP D-88, K6).
 *
 * `shared-types/reports/cash-flow-projection.ts` carries the argument for the wire
 * contract's shape; this file is the reading and the arithmetic behind it.
 *
 * ## What it reads, and why it is three concurrent reads over two existing paths
 *
 * **Opening cash** is `getAccountBalances`'s own `closing` balance (D-13, no stored
 * balance to drift from — D-46's whole argument), narrowed to the org's cash and
 * bank accounts by `accountIds`, the same internal option `general-ledger.service.ts`
 * uses to read one account instead of a type. Which accounts count as cash is
 * `selectCashAccountIds` below: every account registered in `bank_accounts`, plus
 * any account an org has separately flagged `cash_basis_role = 'cash'` on
 * `accounts` without registering it as a bank account (a till, a cash-on-hand
 * account with no statement to import). Both are read and unioned rather than
 * either alone, because the two are genuinely different: the first is "this
 * account has a bank feed", the second is "this account settles cash basis",
 * and an org's cash position is every account either is true of.
 *
 * **Outstanding AR and AP** are `aging.repository.ts`'s `selectArDocuments` and
 * `selectApDocuments`, restricted to `invoice` and `bill` — not the four document
 * types aging reads. Credit notes and vendor credits carry no due date at all
 * (`0005_subledger` makes it NULL on a credit note precisely because a credit is
 * allocated, not chased), so they have no bucket to fall into here the way they do
 * in aging's `current` bucket; and unlike aging, this report makes no claim to tie
 * to a control account, so there is no C8-shaped reason to carry them anyway. The
 * outstanding computation itself — total minus allocations dated on or before the
 * date, gated on the allocation's counterparty having itself posted — is the exact
 * function aging reads, restated in this file's own words rather than duplicated:
 * D-34 is that outstanding has one definition, and reusing the same repository
 * functions is what keeps that true rather than merely stated.
 *
 * ## Bucketing: rolling windows from `asOf`, not calendar-aligned ones
 *
 * A bucket boundary is `asOf` plus `n` weeks or `n` months — a rolling window, not
 * "the rest of this calendar month, then whole months after". Calendar alignment
 * would make the first bucket's width depend on which day of the month `asOf` fell
 * on, which is a fact about the calendar and not about the forecast; a rolling
 * window makes every bucket after the first the same width as the first, and the
 * first bucket is the one a reader most wants to trust ("how much comes in over the
 * next 30 days").
 *
 * A due date that has **already passed** — an overdue invoice or bill, still
 * unpaid — is not excluded and is not given a bucket of its own. It lands in
 * whichever bucket its due date's ordinal position finds, which for anything at or
 * before `asOf` is always the first: `bucketIndexFor` scans buckets by `periodEnd`
 * in ascending order and returns the first one at or after the due date, and no
 * `periodEnd` in the horizon is earlier than the first bucket's. That is a
 * consequence of the scan rather than a special case written for it — overdue money
 * is money a forecast should expect *now*, not money a stale due date should hide.
 *
 * A due date **beyond the horizon** finds no bucket (`bucketIndexFor` returns -1)
 * and is dropped from the projection entirely, the same way a document `to` bound
 * excludes what falls after it elsewhere in this module — a forecast of the next
 * three months has nothing to say about an invoice due in a year.
 *
 * ## Surface
 *
 * | Operation                              | Permission     |
 * | --------------------------------------- | -------------- |
 * | `getCashFlowProjection(query, ctx)`     | `reports.read` |
 */

export type CashFlowProjectionQuery = CashFlowProjectionQueryParams;

export async function getCashFlowProjection(
  query: CashFlowProjectionQuery = {},
  ctx: RequestContext = getContext('getCashFlowProjection()'),
): Promise<CashFlowProjection> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(cashFlowProjectionQuerySchema, query);

  const asOf = request.asOf ?? today();
  const granularity = request.granularity ?? CASH_FLOW_PROJECTION_GRANULARITY_DEFAULT;
  const horizon = request.horizon ?? CASH_FLOW_PROJECTION_HORIZON_DEFAULT;

  const db = orgScope(ctx);
  const buckets = buildBucketWindows(asOf, granularity, horizon);

  const [openingCash, invoices, bills] = await Promise.all([
    readOpeningCash(db, ctx, asOf),
    selectArDocuments(db, {
      asOf,
      documentType: 'invoice',
      allocationLink: 'invoice_id',
      contactId: null,
    }),
    selectApDocuments(db, {
      asOf,
      documentType: 'bill',
      allocationLink: 'bill_id',
      contactId: null,
    }),
  ]);

  return assemble(buckets, openingCash, invoices, bills, { asOf, granularity });
}

// ---------------------------------------------------------------------------
// Opening cash
// ---------------------------------------------------------------------------

/**
 * The org's cash/bank accounts: every `bank_accounts.account_id`, unioned with
 * every `accounts.id` an org has flagged `cash_basis_role = 'cash'` without
 * registering as a bank account. Read as two plain selects and merged in this
 * process rather than as one `UNION` — both sides are small, org-scoped tables
 * with no aggregation, so there is nothing a database-side union buys here that a
 * `Set` does not, and two selects keep each half legible on its own.
 *
 * An org that has registered no bank account and tagged no account `cash_basis_role
 * = 'cash'` reads an empty list, which `getAccountBalances`'s own `accountIds: []`
 * handling turns into a report on no accounts — zero opening cash — rather than,
 * read the wrong way round, an unfiltered report on the *whole chart*.
 * `AccountBalancesOptions.accountIds` distinguishes `undefined` (no filter, every
 * account) from an empty array (a filter matching nothing) precisely so that
 * distinction is representable; getting the two swapped here is the one mistake
 * that would make this figure silently wrong rather than merely small, and it is
 * worth the orchestrator's second look for exactly that reason.
 */
async function selectCashAccountIds(db: TenantDatabase): Promise<readonly string[]> {
  const [registered, roleTagged] = await Promise.all([
    db.selectFrom('bank_accounts').select('account_id').execute(),
    db.selectFrom('accounts').select('id').where('cash_basis_role', '=', 'cash').execute(),
  ]);

  const ids = new Set<string>();
  for (const row of registered) ids.add(bufferToUuid(row.account_id));
  for (const row of roleTagged) ids.add(bufferToUuid(row.id));
  return [...ids];
}

/** `getAccountBalances`'s `closing.balance` at `asOf`, over this org's cash accounts only. */
async function readOpeningCash(
  db: TenantDatabase,
  ctx: RequestContext,
  asOf: string,
): Promise<bigint> {
  const accountIds = await selectCashAccountIds(db);
  const balances = await getAccountBalances({ to: asOf }, ctx, { accountIds });
  return balances.totals.closing.balance;
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

interface BucketWindow {
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * `horizon` rolling windows of `granularity` width, starting at `asOf`.
 *
 * Bucket `i`'s `periodStart` is `asOf` advanced by `i` widths and its `periodEnd`
 * is the day before bucket `i + 1`'s `periodStart` — so the boundary between two
 * buckets is one fact (`boundaryAt`), computed once, and never two independent
 * additions that could disagree at the edge. The same shape `balances.repository.ts`
 * argues for opening/movement: writing the boundary once is what makes it a single
 * fact rather than two arithmetics agreeing by coincidence.
 */
function buildBucketWindows(
  asOf: string,
  granularity: CashFlowBucketGranularity,
  horizon: number,
): readonly BucketWindow[] {
  const windows: BucketWindow[] = [];

  for (let index = 0; index < horizon; index++) {
    const periodStart = boundaryAt(asOf, granularity, index);
    const periodEnd = addDays(boundaryAt(asOf, granularity, index + 1), -1);
    windows.push({ periodStart, periodEnd });
  }

  return windows;
}

function boundaryAt(asOf: string, granularity: CashFlowBucketGranularity, count: number): string {
  return granularity === 'weekly' ? addDays(asOf, count * 7) : addMonths(asOf, count);
}

/**
 * The first bucket whose `periodEnd` is on or after `dueDate`, or -1 when `dueDate`
 * is beyond every bucket's `periodEnd` — i.e. beyond the horizon.
 *
 * `periodEnd` strings compare correctly with `<=` because `calendarDateSchema` is
 * fixed-width `YYYY-MM-DD` (the same trick `aging.service.ts`'s `compareDocuments`
 * uses on `dueDate`), so this needs no date parsing at all. An overdue due date —
 * one before `asOf`, and therefore before every bucket's `periodStart` — still
 * satisfies `dueDate <= periodEnd` on the first bucket, which is `bucketIndexFor`'s
 * whole account of why overdue money lands in the nearest bucket rather than being
 * dropped: nothing here special-cases it.
 */
function bucketIndexFor(dueDate: string, buckets: readonly BucketWindow[]): number {
  return buckets.findIndex((bucket) => dueDate <= bucket.periodEnd);
}

const MILLISECONDS_PER_DAY = 86_400_000;

/** `date` shifted by `days` (negative shifts back), in UTC — a calendar date has no timezone. */
function addDays(date: string, days: number): string {
  const [year, month, day] = parseDateParts(date);
  return toDateString(Date.UTC(year, month - 1, day) + days * MILLISECONDS_PER_DAY);
}

/**
 * `date` shifted by `months` calendar months, clamped to the day the target month
 * actually has.
 *
 * `Date.UTC` normalises an out-of-range day by rolling into the following month —
 * 31 January plus one month would become 3 March rather than 28/29 February — which
 * is arithmetic, not a calendar. Clamping to the target month's last day first is
 * what a person means by "one month from the 31st" when the next month has none.
 */
function addMonths(date: string, months: number): string {
  const [year, month, day] = parseDateParts(date);
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return toDateString(Date.UTC(targetYear, targetMonth, Math.min(day, daysInTargetMonth)));
}

function parseDateParts(date: string): readonly [number, number, number] {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // `calendarDateSchema` has already parsed `asOf`, and every boundary derived from
    // it is built by this file's own arithmetic — a malformed value here is a fault
    // in this process rather than input.
    throw new InternalError(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  return [year, month, day];
}

function toDateString(utcMillis: number): string {
  return new Date(utcMillis).toISOString().slice(0, 10);
}

/** `asOf`'s default: today, in UTC — the same calendar-date reading every boundary above uses. */
function today(): string {
  return toDateString(Date.now());
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface AssemblyMeta {
  readonly asOf: string;
  readonly granularity: CashFlowBucketGranularity;
}

function assemble(
  buckets: readonly BucketWindow[],
  openingCash: bigint,
  invoices: readonly AgingDocumentRow[],
  bills: readonly AgingDocumentRow[],
  meta: AssemblyMeta,
): CashFlowProjection {
  const inflows = new Array<bigint>(buckets.length).fill(0n);
  const outflows = new Array<bigint>(buckets.length).fill(0n);

  accumulateByDueDate(invoices, buckets, inflows);
  accumulateByDueDate(bills, buckets, outflows);

  let runningCash = openingCash;
  const wireBuckets: CashFlowProjectionBucket[] = buckets.map((window, index) => {
    // `inflows`/`outflows` are built with one entry per bucket in `assemble`, so an
    // index from the same loop that built `buckets` is always in range.
    const inflow = inflows[index] ?? 0n;
    const outflow = outflows[index] ?? 0n;
    const netChange = inflow - outflow;
    runningCash += netChange;

    return {
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      expectedInflows: inflow.toString(),
      expectedOutflows: outflow.toString(),
      netChange: netChange.toString(),
      projectedClosingCash: runningCash.toString(),
    };
  });

  return {
    asOf: meta.asOf,
    granularity: meta.granularity,
    openingCash: openingCash.toString(),
    buckets: wireBuckets,
    // Always false — see `shared-types/reports/cash-flow-projection.ts` for why this
    // is a response field rather than a comment nobody reading the wire ever sees.
    includesRecurringCommitments: false,
  };
}

/** Outstanding total minus allocations, bucketed by due date, into `into` in place. */
function accumulateByDueDate(
  rows: readonly AgingDocumentRow[],
  buckets: readonly BucketWindow[],
  into: bigint[],
): void {
  for (const row of rows) {
    const outstanding = row.total - row.allocated;
    if (outstanding === 0n) continue;

    const dueDate = requireDueDate(row);
    const index = bucketIndexFor(dueDate, buckets);
    if (index === -1) continue; // Beyond the horizon — not this forecast's concern.

    into[index] = (into[index] ?? 0n) + outstanding;
  }
}

/**
 * An approved invoice or bill always has one — `chk_ar_documents_invoice_due` and
 * `chk_ap_documents_bill_due` require it, and `selectArDocuments`/`selectApDocuments`
 * both inner-join the posting journal, so every row here is approved. Restated from
 * `aging.service.ts`'s `requireDueDate` rather than imported: it is six lines naming
 * a different pair of constraints than any this file already reaches into.
 */
function requireDueDate(row: AgingDocumentRow): string {
  if (row.dueDate === null) {
    throw new InternalError(
      'An approved invoice or bill has no due date, which chk_ar_documents_invoice_due / ' +
        'chk_ap_documents_bill_due make unrepresentable.',
    );
  }
  return row.dueDate;
}
