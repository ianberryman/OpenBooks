import type { CalendarDate, Instant } from '@openbooks/plugin-api';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, newUuidBuffer, tenantDb, tryUuidToBuffer, uuidToBuffer } from '../../db';
import type { ErrorDetails, JsonValue } from '../../errors';
import { assertFound, ConflictError, InternalError, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';
import type { MonthSpan } from './calendar';
import { fiscalYearSpan, MONTHS_PER_YEAR, monthSpan } from './calendar';
import type { NewPeriod, PeriodClosure, PeriodRecord } from './periods.repository';
import {
  insertPeriods,
  selectFiscalYearStartMonth,
  selectPeriodById,
  selectPeriods,
  selectPeriodsOverlapping,
  updatePeriodClosure,
} from './periods.repository';
import type {
  CreatePeriodInput,
  GenerateFiscalYearInput,
  ListPeriodsInput,
  PeriodRef,
  PeriodStatus,
} from './periods.schemas';
import {
  calendarDateSchema,
  createPeriodInputSchema,
  generateFiscalYearInputSchema,
  listPeriodsInputSchema,
  parseServiceInput,
  periodRefSchema,
} from './periods.schemas';

/**
 * Fiscal periods (OB-019; ROADMAP D-08, D-17). This module owns acceptance
 * criterion **A4: posting to a locked period is rejected**, by way of
 * `assertPostable`.
 *
 * Read `calendar.ts` for why no `Date` appears anywhere on this path, and
 * `assertPostable` below for the contract OB-020 depends on.
 */

/** The resource name for every not-found answer in this module (A7). */
const RESOURCE = 'fiscal_period';

/** mysql2's `errno` for a unique constraint violation (`ER_DUP_ENTRY`). */
const DUPLICATE_ENTRY_ERRNO = 1062;

export interface FiscalPeriod {
  readonly id: string;
  readonly name: string;
  readonly startDate: CalendarDate;
  /** Inclusive. */
  readonly endDate: CalendarDate;
  readonly status: PeriodStatus;
  /**
   * When the period was closed, or null while it is open. An instant rather than a
   * calendar date — this is the wall-clock time of a system event, not an accounting
   * date (plugin-api `primitives.ts`).
   */
  readonly closedAt: Instant | null;
  /** Null when closed by an automation or agent, which is not a `users` row. */
  readonly closedByUserId: string | null;
}

export interface GeneratedFiscalYear {
  /** The calendar year the fiscal year *starts* in. See `fiscalYearSpan`. */
  readonly fiscalYear: number;
  readonly startMonth: number;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
  /** Twelve periods, contiguous, in ascending date order. */
  readonly periods: readonly FiscalPeriod[];
}

/**
 * A period a posting may land in. Returned by `assertPostable`.
 *
 * `id` is the UUID string, not the `BINARY(16)` the column holds; OB-020 converts
 * with `uuidToBuffer` from `src/db`. Handing back the raw bytes would put a storage
 * representation in a service return type for the sake of one round trip through a
 * hex decode, and every other service here returns UUID strings.
 */
export interface PostablePeriod {
  readonly id: string;
  readonly name: string;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
}

export interface PostabilityOptions {
  /**
   * Take a row lock on the resolved period. Defaults to **true**, which is the
   * behaviour A9 needs — see `assertPostable`. Pass `false` only for a read-only
   * probe, such as a UI asking whether a date is postable before offering a form.
   */
  readonly lock?: boolean;
}

/**
 * Generates the twelve monthly periods of one fiscal year (ROADMAP D-17).
 *
 * The org's `fiscal_year_start_month` decides where the year begins — April, July,
 * and October are all common — and the periods inside it are ordinary calendar
 * months. `fiscalYear` names the calendar year the year *starts* in.
 *
 * ## Why generation is explicit and never implicit on first post
 *
 * D-17 is emphatic and the reason is worth restating at the code that could have
 * done otherwise: creating the enclosing period at posting time "would let a posting
 * silently manufacture a period inside a year that had already been closed, which is
 * the reverse of what closing a year is for". So `assertPostable` refuses a date no
 * period covers rather than creating one, and this function is the only way a period
 * comes into existence. The cost, also from D-17, is that onboarding must generate
 * periods before the first entry — a prerequisite, not a nicety.
 */
export async function generateFiscalYear(
  input: GenerateFiscalYearInput,
): Promise<GeneratedFiscalYear> {
  // Authorize before validating. Both orders are safe here — every message these
  // schemas produce describes the request rather than any stored state — but
  // refusing an unauthorized caller before doing any work is the order that stays
  // safe if a future schema grows a message that mentions state.
  const ctx = getContext('generateFiscalYear()');
  await requirePermission(ctx, 'periods.write');

  const { fiscalYear } = parseServiceInput(
    generateFiscalYearInputSchema,
    input,
    'fiscal year generation request',
  );

  const orgId = orgIdOf(ctx);
  const startMonth = await resolveFiscalYearStartMonth(orgId);
  const span = fiscalYearSpan(fiscalYear, startMonth);

  const periods = await createPeriods(tenantDb(orgId), span.months);

  return {
    fiscalYear: span.fiscalYear,
    startMonth: span.startMonth,
    startDate: span.startDate,
    endDate: span.endDate,
    periods,
  };
}

/**
 * Creates one monthly period.
 *
 * The single-month form exists for the partial first year a business that started in
 * September actually has, and for the M2 UI's "add the next month" affordance.
 * Gaplessness is a property of `generateFiscalYear` rather than of the table
 * (D-17), so a caller using this to build a year by hand can leave a hole — and a
 * date in that hole is un-postable, which `assertPostable` answers and
 * `journals.period_id NOT NULL` enforces rather than merely discourages.
 */
export async function createPeriod(input: CreatePeriodInput): Promise<FiscalPeriod> {
  const ctx = getContext('createPeriod()');
  await requirePermission(ctx, 'periods.write');

  const { year, month } = parseServiceInput(createPeriodInputSchema, input, 'period request');
  const span = monthSpan({ year, month });

  const created = await createPeriods(tenantDb(orgIdOf(ctx)), [span]);
  const period = created[0];
  if (period === undefined) {
    throw new InternalError('createPeriods returned no period for a single-month request.');
  }
  return period;
}

export async function listPeriods(input: ListPeriodsInput = {}): Promise<readonly FiscalPeriod[]> {
  const ctx = getContext('listPeriods()');
  await requirePermission(ctx, 'periods.read');

  const filter = parseServiceInput(listPeriodsInputSchema, input, 'period list request');
  const rows = await selectPeriods(
    tenantDb(orgIdOf(ctx)),
    // Spread rather than passing `filter` directly: under
    // `exactOptionalPropertyTypes` an explicit `status: undefined` is not the same
    // as an absent key, and the repository branches on absence.
    filter.status === undefined ? {} : { status: filter.status },
  );

  return rows.map(toFiscalPeriod);
}

export async function getPeriod(input: PeriodRef): Promise<FiscalPeriod> {
  const ctx = getContext('getPeriod()');
  await requirePermission(ctx, 'periods.read');

  const { periodId } = parseServiceInput(periodRefSchema, input, 'period reference');

  const row = await selectPeriodById(tenantDb(orgIdOf(ctx)), uuidToBuffer(periodId));
  // A7: the row never arrives for another org's period, because `tenantDb` filtered
  // it out, so this is the same line of code for "not yours" and "never existed" —
  // and `NotFoundError` has no channel through which the two could differ.
  return toFiscalPeriod(assertFound(row, RESOURCE));
}

/**
 * Closes a period. Records `closed_at` and `closed_by_user_id` (ROADMAP D-08).
 */
export async function closePeriod(input: PeriodRef): Promise<FiscalPeriod> {
  const ctx = getContext('closePeriod()');
  await requirePermission(ctx, 'periods.close');

  const { periodId } = parseServiceInput(periodRefSchema, input, 'period reference');
  return transitionPeriod(ctx, periodId, 'closed');
}

/**
 * Reopens a closed period.
 *
 * ## Why `periods.reopen` is a separate permission from `periods.close`
 *
 * Because they are different acts, held by different people, at different
 * frequencies.
 *
 * Closing is routine and forward-only: it is the monthly soft close, the last step
 * of doing the books, and the person who does the books does it. Reopening
 * *withdraws a statement that has already been relied on*. Between the close and the
 * reopen, figures were reported, a VAT or sales-tax return may have been filed, and a
 * lender or an accountant may hold a balance sheet as at that date. Admitting a new
 * posting dated inside that range changes a number someone has already published,
 * which is a restatement — an exception requiring the authority that answers for it.
 *
 * One permission covering both would make that distinction inexpressible: an org
 * could not let a bookkeeper close each month while keeping restatement with the
 * owner or the outside accountant, which is precisely the split most small
 * businesses want and the reason spec §5 has a fixed catalog with roles as bundles
 * over it. Note that in M1 the distinction is *latent* rather than exercised — the
 * six seeded roles in `0001_tenancy` grant both to Owner and Bookkeeper and neither
 * to anyone else, so it is realized by the first custom role (spec §5 defers those
 * to v2). Splitting the codes now rather than later is what makes that a feature
 * instead of a migration: permission codes are part of the catalog union, and
 * widening one code into two afterwards means every role that held the old one has
 * to be re-derived.
 *
 * D-08 also has this module in mind when it says the richer, audited period-close
 * workflow arrives with M2/M3. That workflow attaches to reopen, and it attaches to
 * a permission that already exists.
 */
export async function reopenPeriod(input: PeriodRef): Promise<FiscalPeriod> {
  const ctx = getContext('reopenPeriod()');
  await requirePermission(ctx, 'periods.reopen');

  const { periodId } = parseServiceInput(periodRefSchema, input, 'period reference');
  return transitionPeriod(ctx, periodId, 'open');
}

/**
 * Resolves `date` to its period and asserts a posting may land there. **This is the
 * mechanism behind A4** and the one function in this module OB-020 calls.
 *
 * ```ts
 * // Inside the posting repository's own transaction:
 * await tenantDb(orgId).transaction(async (trx) => {
 *   const period = await assertPostable(input.date);
 *   await trx.insertInto('journals').values({
 *     period_id: uuidToBuffer(period.id),
 *     entry_date: input.date,
 *     …
 *   }).execute();
 * });
 * ```
 *
 * ## How it composes inside OB-020's transaction
 *
 * It takes no database handle and no org. Both are ambient: the org comes from
 * request context (spec §4 — never a loose parameter) and the transaction comes from
 * `src/db/transaction-scope.ts`, which is why the snippet above passes no `trx` and
 * is still enrolled in one. `tenantDb()` consults `ambientTransaction()` before
 * falling back to the pool, so the read below happens on the *same connection and
 * inside the same transaction* as the journal insert that follows it. That is the
 * whole point of that module, and a period check that took its own handle would be
 * the seam it was written to close.
 *
 * ## Why the read locks the row, and how that gives A9
 *
 * A9 requires that "a posting racing a period lock leaves no half-written journal".
 * The lock is what supplies it, and it has to be taken here because this is the read
 * whose answer the posting depends on. `SELECT … FOR UPDATE` in InnoDB reads the
 * latest committed row rather than the transaction's snapshot, so of two racing
 * transactions:
 *
 *  - if `closePeriod` commits first, this read sees `status = 'closed'` and rejects,
 *    so no journal row is written at all;
 *  - if this read wins, `closePeriod`'s `UPDATE` blocks on the same row lock until
 *    the posting transaction commits or rolls back, and then closes a period whose
 *    postings are all accounted for.
 *
 * Either way there is no interleaving that admits a journal into a closed period, and
 * no partial write, because the check and the insert are one transaction. This is
 * also why `fiscal_periods` is in `0999_app_grants`'s mutable allowlist: the app user
 * cannot take a locking read on `journals` — MySQL requires `UPDATE`/`DELETE`
 * alongside `SELECT` for one, and withholding those is how journal immutability is
 * enforced — so the lock has to live on a table it may write.
 *
 * ## Why there is no `requirePermission` here
 *
 * This is an invariant check inside another operation, not an operation. The caller
 * has already been authorized for what it is doing (`journals.post`), and gating this
 * on `periods.read` would mean a role that may post but may not browse the period
 * calendar could not post — and would surface as a `403` raised from the middle of a
 * posting transaction, naming a permission the caller never asked to use.
 */
export async function assertPostable(
  date: CalendarDate,
  options: PostabilityOptions = {},
): Promise<PostablePeriod> {
  const entryDate = parseServiceInput(calendarDateSchema, date, 'posting date');
  const ctx = getContext('assertPostable()');

  // Resolving a date is the degenerate case of an overlap test — the range
  // [date, date] — so it uses the same predicate rather than a second one that could
  // disagree with it about a boundary day.
  const covering = await selectPeriodsOverlapping(tenantDb(orgIdOf(ctx)), entryDate, entryDate, {
    lock: options.lock ?? true,
  });

  const period = covering[0];
  if (period === undefined) {
    // A `precondition_failed`, not a `validation_failed`: the request is well-formed
    // and the state is what forbids it, so the fix is to generate the fiscal year
    // rather than to change the request (see `src/errors/errors.ts`). Deliberately
    // *not* creating the period — D-17, quoted on `generateFiscalYear`.
    throw new PreconditionFailedError(
      'period_missing',
      `No fiscal period covers ${entryDate}. Generate the fiscal year that contains this ` +
        'date before posting into it.',
    );
  }

  if (covering.length > 1) {
    // Non-overlap is enforced in this service and nowhere in the schema, so a second
    // covering period means the invariant has already been broken — by a manual
    // write, an import, or a bug. Failing is the only safe answer: silently taking
    // the first would post into whichever period sorted lower, and the choice would
    // be invisible in the resulting books.
    throw new InternalError(
      `${covering.length} fiscal periods cover ${entryDate}. Periods must not overlap; the ` +
        'invariant is enforced in the periods service because MySQL cannot express it ' +
        '(see 0002_ledger).',
      { periods: describePeriods(covering) },
    );
  }

  if (period.status === 'closed') {
    // A4. Free text is safe here for the same reason it is on `ConflictError`: the
    // period is inside the caller's own org, because `tenantDb` could not have
    // returned another org's row.
    throw new PreconditionFailedError(
      'period_closed',
      `Fiscal period ${period.name} (${period.startDate} to ${period.endDate}) is closed. ` +
        'Post to an open period, or reopen this one.',
    );
  }

  return {
    id: bufferToUuid(period.id),
    name: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}

/**
 * The shared create path: reject overlaps, then insert.
 *
 * ## The non-overlap algorithm
 *
 * Migration `0002_ledger` states that non-overlap "is NOT enforceable as a MySQL
 * constraint (no exclusion constraints, no range types)" and that
 * `uq_fiscal_periods_org_start` "catches the most common duplicate but does not catch
 * a genuine overlap". So it is enforced here, in three parts:
 *
 *  1. **The predicate is symmetric.** One query per request asks for every existing
 *     period with `start_date <= <span end> AND end_date >= <span start>`. That is
 *     the complete overlap test — see `rangesOverlap` for the containment and
 *     straddling cases the tempting `start_date`-only version misses. Checking the
 *     whole requested span in one query rather than month by month also means a
 *     twelve-month generation is one round trip and one lock acquisition.
 *  2. **The check is taken under a lock**, so it is not a check-then-act race. See
 *     `selectPeriodsOverlapping`.
 *  3. **The unique key is still the last word.** `uq_fiscal_periods_org_start`
 *     rejects an exact duplicate start date whatever the application believed, and a
 *     duplicate-entry error is translated to the same `ConflictError` a positive
 *     overlap check produces — so the two paths are indistinguishable to a client and
 *     the schema-level guard cannot present as a 500.
 *
 * Months proposed within a single call are contiguous by construction (`calendar.ts`)
 * and therefore cannot overlap each other, which is why only existing rows are
 * checked.
 */
async function createPeriods(
  db: TenantDatabase,
  months: readonly MonthSpan[],
): Promise<readonly FiscalPeriod[]> {
  // The checked range is the union of the requested months, read off the first and
  // last of them rather than taken as a separate argument. For a fiscal year those
  // are the same dates `FiscalYearSpan` reports, and deriving them here means the
  // range checked and the rows inserted cannot disagree.
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) {
    throw new InternalError('createPeriods was called with no months.');
  }

  const rangeStart = first.startDate;
  const rangeEnd = last.endDate;

  const rows: readonly NewPeriod[] = months.map((month) => ({
    id: newUuidBuffer(),
    name: month.name,
    startDate: month.startDate,
    endDate: month.endDate,
  }));

  return db.transaction(async (trx) => {
    const clashing = await selectPeriodsOverlapping(trx, rangeStart, rangeEnd, { lock: true });
    if (clashing.length > 0) {
      throw overlapConflict(rangeStart, rangeEnd, clashing);
    }

    try {
      await insertPeriods(trx, rows);
    } catch (error) {
      if (!isDuplicateEntry(error)) throw error;
      throw overlapConflict(rangeStart, rangeEnd, []);
    }

    return rows.map((row) => ({
      id: bufferToUuid(row.id),
      name: row.name,
      startDate: row.startDate,
      endDate: row.endDate,
      // `status` and `closed_at` take their column defaults, so a new period is open
      // with no close recorded. Stated rather than re-read: a SELECT after the INSERT
      // would cost a round trip to learn what `0002_ledger`'s DEFAULT already fixed.
      status: 'open' as const,
      closedAt: null,
      closedByUserId: null,
    }));
  });
}

/**
 * The one write path for `status`, so the CHECK constraint has a single author.
 *
 * `chk_fiscal_periods_closed_consistency` pairs `status` with `closed_at`, and
 * `PeriodClosure` makes that pairing a type rather than a discipline — there is no
 * way to call `updatePeriodClosure` that sets one without the other. A test asserts
 * the constraint still refuses the inconsistent row when it is written by hand, which
 * is what keeps this a defence in depth rather than the only defence.
 */
async function transitionPeriod(
  ctx: RequestContext,
  periodId: string,
  target: PeriodStatus,
): Promise<FiscalPeriod> {
  const id = uuidToBuffer(periodId);

  return tenantDb(orgIdOf(ctx)).transaction(async (trx) => {
    // Locked, for the same reason `assertPostable` locks: a close racing a posting
    // must resolve one way or the other rather than both proceeding on a stale read
    // (A9). Locking here also serializes two concurrent closes, so `closed_by_user_id`
    // records the actor who actually performed the transition.
    const current = assertFound(await selectPeriodById(trx, id, { lock: true }), RESOURCE);

    if (current.status === target) {
      // A conflict rather than a silent success. Closing records *who* closed it and
      // *when*; answering 200 to a second close would tell the caller their action was
      // recorded when the stored actor and timestamp belong to someone else. Replay
      // safety for a retried request is OB-017's job and is keyed on the request, not
      // inferred from the state.
      throw new ConflictError(
        `Fiscal period ${current.name} is already ${target}.`,
        periodDetail(current),
      );
    }

    const closure: PeriodClosure =
      target === 'closed'
        ? { status: 'closed', closedAt: new Date(), closedByUserId: closingUserId(ctx) }
        : // Reopening clears the closer as well as the timestamp. Leaving
          // `closed_by_user_id` set would make the row say "closed by X" while open,
          // which reads as a record of a close rather than of a close that was undone;
          // the audit trail for the reopen itself belongs in the M5 event log, not in a
          // column whose name is about closing.
          { status: 'open', closedAt: null, closedByUserId: null };

    const changed = await updatePeriodClosure(trx, id, closure);
    if (changed === 0) {
      throw new InternalError(
        'The fiscal period read under FOR UPDATE in this transaction was not updated by it.',
      );
    }

    return toFiscalPeriod({ ...current, ...closure });
  });
}

/**
 * `closed_by_user_id` for the acting context, or null.
 *
 * The column is a foreign key to `users`, and spec §6 admits automation and agent
 * actors that have no row there — so a null is the honest value rather than a missing
 * one. Actor provenance for non-user actors is recorded per posting on `journals`;
 * a period close is not a posting.
 */
function closingUserId(ctx: RequestContext): Buffer | null {
  if (ctx.userId === null) return null;

  const id = tryUuidToBuffer(ctx.userId);
  if (id === undefined) {
    throw new InternalError(
      'Request context carries a userId that is not a UUID; the context was built from an ' +
        'untrusted value or the wrong field.',
    );
  }
  return id;
}

/**
 * The context's org as `BINARY(16)`.
 *
 * An `InternalError` on a malformed value, matching `permissions.service.ts`: a
 * context is host-built from a session or an API key, so a non-UUID org id is a
 * wiring bug in whoever opened the scope and not something a client did. Letting
 * `uuidToBuffer` throw its `TypeError` instead would reach the transport as an
 * unrecognised error and serialize as a bare `internal_error` with no explanation in
 * the log.
 */
function orgIdOf(ctx: RequestContext): Buffer {
  const orgId = tryUuidToBuffer(ctx.orgId);
  if (orgId === undefined) {
    throw new InternalError(
      'Request context carries an orgId that is not a UUID; the context was built from an ' +
        'untrusted value or the wrong field.',
    );
  }
  return orgId;
}

async function resolveFiscalYearStartMonth(orgId: Buffer): Promise<number> {
  const startMonth = await selectFiscalYearStartMonth(orgId);

  if (startMonth === undefined) {
    throw new InternalError(
      'No org row for the org id in request context. The context was opened for an org that ' +
        'does not exist, or the org was deleted mid-request.',
    );
  }

  // `chk_orgs_fiscal_year_start_month` already restricts this to 1-12, so the branch
  // is unreachable through a migrated database. It is here because the generated type
  // is `number`: without it, a schema drift or a hand-edited row would produce twelve
  // periods in the wrong months rather than an error, and wrong periods are far harder
  // to notice than a failed call.
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > MONTHS_PER_YEAR) {
    throw new InternalError(
      `orgs.fiscal_year_start_month is ${startMonth}, which is not a month. ` +
        'chk_orgs_fiscal_year_start_month should have made this unreachable.',
    );
  }

  return startMonth;
}

/**
 * Both overlap paths raise the same error, so a client cannot tell whether the
 * application's check or the unique index caught it — the two are the same fact.
 *
 * Free text and identifying detail are permitted on a `ConflictError` and not on a
 * `NotFoundError`: reaching a conflict means the colliding rows are inside the
 * caller's own org, since `tenantDb` could not have returned any others. Naming them
 * is what lets a caller act — the answer to "your fiscal year overlaps" is usually
 * "delete the stray period", and that needs its id.
 */
function overlapConflict(
  rangeStart: CalendarDate,
  rangeEnd: CalendarDate,
  clashing: readonly PeriodRecord[],
): ConflictError {
  const detail: ErrorDetails =
    clashing.length > 0
      ? {
          requestedStartDate: rangeStart,
          requestedEndDate: rangeEnd,
          periods: describePeriods(clashing),
        }
      : { requestedStartDate: rangeStart, requestedEndDate: rangeEnd };

  return new ConflictError(
    `A fiscal period already overlaps ${rangeStart} to ${rangeEnd}. Fiscal periods must not ` +
      'overlap.',
    detail,
  );
}

function describePeriods(periods: readonly PeriodRecord[]): readonly JsonValue[] {
  return periods.map((period) => ({
    id: bufferToUuid(period.id),
    name: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
  }));
}

function periodDetail(period: PeriodRecord): ErrorDetails {
  return {
    id: bufferToUuid(period.id),
    name: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
  };
}

function toFiscalPeriod(record: PeriodRecord): FiscalPeriod {
  return {
    id: bufferToUuid(record.id),
    name: record.name,
    startDate: record.startDate,
    endDate: record.endDate,
    status: record.status,
    // `closed_at` is a `DATETIME(3)`, which the driver does return as a `Date` — it is
    // a genuine instant, unlike the `DATE` columns above. Serialized here so no
    // caller has to decide on a format.
    closedAt: record.closedAt === null ? null : record.closedAt.toISOString(),
    closedByUserId: record.closedByUserId === null ? null : bufferToUuid(record.closedByUserId),
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { readonly errno?: unknown }).errno === DUPLICATE_ENTRY_ERRNO
  );
}
