import type { CalendarDate } from '@openbooks/plugin-api';

import type { OrgId, TenantDatabase } from '../../db';
import { systemDb } from '../../db';
import type { PeriodStatus } from './periods.schemas';

/**
 * Reads and writes for `fiscal_periods`.
 *
 * Everything here takes a `TenantDatabase`, so `org_id` is injected before the
 * caller sees the query and a cross-org period is not merely unauthorized but
 * absent — which is what makes `assertFound` in the service sufficient for A7
 * rather than a place where the org has to be re-checked.
 *
 * The one exception is `selectFiscalYearStartMonth`, which reads `orgs`; that
 * table's own `id` *is* the org id, so it is reached through `systemDb` by id. See
 * the note on that function.
 */

const PERIOD_COLUMNS = [
  'id',
  'name',
  'start_date',
  'end_date',
  'status',
  'closed_at',
  'closed_by_user_id',
] as const;

/** A period row, in the service's naming. */
export interface PeriodRecord {
  readonly id: Buffer;
  readonly name: string;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
  readonly status: PeriodStatus;
  readonly closedAt: Date | null;
  readonly closedByUserId: Buffer | null;
}

/** The columns a new period supplies. `status` and `closed_at` take their defaults. */
export interface NewPeriod {
  readonly id: Buffer;
  readonly name: string;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
}

/**
 * The `status` / `closed_at` / `closed_by_user_id` triple, always written together.
 *
 * `chk_fiscal_periods_closed_consistency` permits exactly two combinations —
 * `open` with a NULL `closed_at`, and `closed` with a non-NULL one. Modelling the
 * write as one indivisible value rather than three optional column updates is what
 * makes the constraint unviolatable through this module: there is no call shape that
 * sets a status without also deciding its timestamp.
 */
export type PeriodClosure =
  | { readonly status: 'open'; readonly closedAt: null; readonly closedByUserId: null }
  | { readonly status: 'closed'; readonly closedAt: Date; readonly closedByUserId: Buffer | null };

/**
 * Whether the read should take a row lock.
 *
 * `true` means `SELECT … FOR UPDATE`, which is legal for the application user on
 * this table specifically: `0004_app_grants` lists `fiscal_periods` as mutable, and
 * MySQL requires `SELECT` plus one of `UPDATE`/`DELETE`/`LOCK TABLES` for a locking
 * read — which is exactly why the same statement against `journals` is refused
 * (pinned by `test/db/harness.test.ts`).
 */
export interface LockOption {
  readonly lock?: boolean;
}

/**
 * Every period whose inclusive range shares a day with `[startDate, endDate]`.
 *
 * The predicate is the SQL twin of `rangesOverlap`, and both halves are load-bearing
 * — see that function for the containment and straddling cases a `start_date`-only
 * test misses. `idx_fiscal_periods_org_range` is `(org_id, start_date, end_date)`, so
 * the org and the `start_date` bound drive the index and `end_date` filters what it
 * returns.
 *
 * Under `{ lock: true }` this is the serialization point for period creation. The
 * locking read is what makes the check-then-insert in `createPeriods` safe: InnoDB
 * takes next-key locks over the scanned index range, including the gaps, so a
 * concurrent transaction proposing an overlapping period blocks here rather than
 * passing its own check against a snapshot that does not yet contain the first
 * transaction's rows. `uq_fiscal_periods_org_start` is the backstop for the exact
 * duplicate, but nothing in the schema catches a partial overlap — `0002_ledger`
 * says so plainly — so the lock is doing real work rather than belt-and-braces.
 */
export async function selectPeriodsOverlapping(
  db: TenantDatabase,
  startDate: CalendarDate,
  endDate: CalendarDate,
  options: LockOption = {},
): Promise<readonly PeriodRecord[]> {
  const query = db
    .selectFrom('fiscal_periods')
    .select(PERIOD_COLUMNS)
    .where('start_date', '<=', endDate)
    .where('end_date', '>=', startDate)
    .orderBy('start_date');

  const rows = await withLock(query, options).execute();
  return rows.map(toPeriodRecord);
}

export async function selectPeriodById(
  db: TenantDatabase,
  id: Buffer,
  options: LockOption = {},
): Promise<PeriodRecord | undefined> {
  const query = db.selectFrom('fiscal_periods').select(PERIOD_COLUMNS).where('id', '=', id);

  const row = await withLock(query, options).executeTakeFirst();
  return row === undefined ? undefined : toPeriodRecord(row);
}

export async function selectPeriods(
  db: TenantDatabase,
  filter: { readonly status?: PeriodStatus } = {},
): Promise<readonly PeriodRecord[]> {
  let query = db.selectFrom('fiscal_periods').select(PERIOD_COLUMNS).orderBy('start_date');

  // Ordered by `start_date` rather than by `created_at`: a fiscal year generated
  // after the one that follows it chronologically must still list in period order,
  // since the caller is reading a calendar.
  if (filter.status !== undefined) {
    query = query.where('status', '=', filter.status);
  }

  const rows = await query.execute();
  return rows.map(toPeriodRecord);
}

export async function insertPeriods(
  db: TenantDatabase,
  periods: readonly NewPeriod[],
): Promise<void> {
  if (periods.length === 0) return;

  // One statement for the whole fiscal year, so twelve periods either all exist or
  // none do. Twelve round trips would leave a half-generated year behind on the
  // failure of the eleventh — recoverable, but only by someone who knows to look.
  await db
    .insertInto('fiscal_periods')
    .values(
      periods.map((period) => ({
        id: period.id,
        name: period.name,
        start_date: period.startDate,
        end_date: period.endDate,
      })),
    )
    .execute();
}

/** Returns the number of rows changed, so the caller can detect a vanished row. */
export async function updatePeriodClosure(
  db: TenantDatabase,
  id: Buffer,
  closure: PeriodClosure,
): Promise<number> {
  const results = await db
    .updateTable('fiscal_periods')
    .set({
      status: closure.status,
      closed_at: closure.closedAt,
      closed_by_user_id: closure.closedByUserId,
    })
    .where('id', '=', id)
    .execute();

  return Number(results[0]?.numUpdatedRows ?? 0n);
}

/**
 * The org's fiscal-year start month (1-12), from `orgs`.
 *
 * `systemDb` rather than `tenantDb`, because `orgs` has no `org_id` — its own `id` is
 * the org id, and `0001_tenancy` says so: "the tenant root. Its own `id` IS the
 * org_id, so it is reached by id rather than through the org-scoped wrapper." The id
 * passed here comes from request context and never from a caller, so there is no
 * cross-org read to guard.
 *
 * One consequence of using `systemDb` that callers should know: returning `undefined`
 * means no such org row, which for an org id taken from a live request context is a
 * fault rather than a caller error. The service says so.
 *
 * This comment previously warned that `systemDb()` does **not** join an ambient
 * transaction while `tenantDb()` does. That asymmetry was real when this was written
 * and has since been fixed — `systemDb()` now consults `ambientTransaction()` too,
 * because registration writes `users` and `orgs` through it alongside `org_members`
 * through the wrapper, and on two connections a half-created account could survive a
 * rollback. So this read *does* join a surrounding transaction, and the OB-026 races
 * depend on exactly that.
 */
export async function selectFiscalYearStartMonth(orgId: OrgId): Promise<number | undefined> {
  const row = await systemDb()
    .selectFrom('orgs')
    .select('fiscal_year_start_month')
    .where('id', '=', orgId)
    .executeTakeFirst();

  return row?.fiscal_year_start_month;
}

/**
 * `.forUpdate()` applied conditionally.
 *
 * Generic over the builder rather than typed to Kysely's `SelectQueryBuilder`: the
 * concrete builder type differs per column selection, and restating it by hand
 * produces a type that drifts on every Kysely upgrade — the same argument
 * `TenantDatabase` makes for inferring its own return types.
 */
function withLock<Q extends { forUpdate(): Q }>(query: Q, options: LockOption): Q {
  return options.lock === true ? query.forUpdate() : query;
}

interface PeriodRow {
  readonly id: Buffer;
  readonly name: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly status: PeriodStatus;
  readonly closed_at: Date | null;
  readonly closed_by_user_id: Buffer | null;
}

function toPeriodRecord(row: PeriodRow): PeriodRecord {
  return {
    id: row.id,
    name: row.name,
    // `start_date` and `end_date` arrive as strings, not `Date`s: the driver's
    // `typeCast` and the codegen overrides both make `DATE` a string on purpose
    // (see `src/db/migrations/README.md`). Nothing in this module converts them.
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
    closedByUserId: row.closed_by_user_id,
  };
}
