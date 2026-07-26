import type { Selectable } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db';
import type { ValidationIssue } from '../../errors';
import { ValidationError } from '../../errors';
import { MONTHS_PER_YEAR } from './calendar';

/**
 * The validated boundary of the periods service (spec §3).
 *
 * ## Why the service parses input the transport already validated
 *
 * OB-023's routes will validate against these same schemas through
 * `fastify-type-provider-zod`, so on the HTTP path this parse is a second check.
 * It is not redundant, because HTTP is not the only caller: spec §2.4 puts one
 * service layer behind many transports, and the MCP tool surface (M5) and the
 * workflow engine (M6) both arrive with values the compiler has already widened to
 * these interfaces without anything having checked them. A service whose
 * validation lived only in its transport would be validated on one of its three
 * entry points.
 *
 * ## Why the schemas are here and not in `@openbooks/shared-types`
 *
 * The convention (OB-022) is that Zod schemas live in `shared-types`. Two things
 * argue against moving these there *now* rather than with OB-023, which owns the
 * wire surface:
 *
 *  1. `shared-types` is aliased as a single module in `vitest.config.ts` and in the
 *     esbuild bundle, with no subpath alias. A `@openbooks/shared-types/periods`
 *     import therefore resolves in `tsc` (which has the `paths` wildcard) and not
 *     in the test runner, and the failure appears as a missing module in an
 *     unrelated suite. Wiring the alias means editing files this ticket does not
 *     own.
 *  2. `periodStatusSchema` is tied to the `fiscal_periods.status` column below, and
 *     `shared-types` cannot import the server's generated schema — nor should it.
 *
 * When OB-023 lifts the request and response shapes into `shared-types`, these stay
 * as the service's own contract and the wire schemas are derived from them.
 */

/**
 * The `open` / `closed` pair, taken from the column rather than restated.
 *
 * ROADMAP D-08 fixes the M1 status set to these two, and `0002_ledger` declares them
 * as a MySQL `ENUM`. A hand-written union here would be a second source of truth
 * that a later migration could silently outgrow; deriving it means a new status is a
 * compile error at every `switch` instead of a value the schema rejects at runtime.
 */
export type PeriodStatus = Selectable<DB['fiscal_periods']>['status'];

export const periodStatusSchema = z.enum(['open', 'closed']);

/**
 * Both directions, so the schema and the column cannot drift apart: a status the
 * column allows but the schema omits fails here, and so does the reverse. The same
 * technique as the permission catalog's `_CatalogSize`, and for the same reason —
 * the failure lands in the file that caused it rather than in a database test.
 */
type AssertAssignable<_Narrow extends _Wide, _Wide> = true;
export type _SchemaStatusesExistOnColumn = AssertAssignable<
  z.infer<typeof periodStatusSchema>,
  PeriodStatus
>;
export type _ColumnStatusesExistInSchema = AssertAssignable<
  PeriodStatus,
  z.infer<typeof periodStatusSchema>
>;

/**
 * A calendar date, `YYYY-MM-DD`.
 *
 * `z.iso.date()` and not a regular expression: verified against the installed Zod
 * (4.4.3) to reject impossible dates and not merely malformed ones — `2026-02-30`,
 * `2026-04-31`, and `2026-02-29` are all refused while `2024-02-29` passes. A regex
 * accepts every one of them, and an `entry_date` of `2026-02-30` would then reach
 * MySQL to be coerced or rejected by the driver rather than answered as a validation
 * failure.
 *
 * Deliberately not `z.coerce.date()` or anything else producing a `Date`. See the
 * header of `calendar.ts`.
 */
export const calendarDateSchema = z.iso.date();

/**
 * MySQL's `DATE` range starts at 1000-01-01, and a fiscal year with a non-January
 * start month extends into the following calendar year — so the last year that can
 * be generated in full is 9998, not 9999. The bound exists to turn a typo'd year
 * into a validation failure rather than a driver error from the twelfth insert of a
 * partially-written fiscal year.
 */
export const MIN_FISCAL_YEAR = 1000;
export const MAX_FISCAL_YEAR = 9998;

const fiscalYearSchema = z.int().min(MIN_FISCAL_YEAR).max(MAX_FISCAL_YEAR);

const monthNumberSchema = z.int().min(1).max(MONTHS_PER_YEAR);

/**
 * `strictObject`, so an unrecognised key is a validation failure rather than a
 * silently ignored one. A caller who sends `{ fiscal_year: 2026 }` to an operation
 * expecting `fiscalYear` would otherwise get a "required" error for the field they
 * believe they sent, and a client who mistypes `status` on a list request would get
 * an unfiltered list they read as filtered.
 */
export const generateFiscalYearInputSchema = z.strictObject({
  fiscalYear: fiscalYearSchema,
});

/**
 * A single period is named by the calendar month it covers, not by a start and end
 * date.
 *
 * ROADMAP D-17 says a fiscal period *is* a calendar month. Accepting an arbitrary
 * range here would demote that from a fact to a convention, and the first
 * consequence would be periods of unequal length in a system whose reports assume
 * monthly comparability. The range is derived in `calendar.ts` instead, which is
 * also why no request can produce `end_date < start_date` and trip
 * `chk_fiscal_periods_range`.
 */
export const createPeriodInputSchema = z.strictObject({
  year: fiscalYearSchema,
  month: monthNumberSchema,
});

export const listPeriodsInputSchema = z.strictObject({
  status: periodStatusSchema.optional(),
});

/**
 * A period is addressed by its UUID.
 *
 * A malformed id is a `400` here, while a well-formed id naming no visible row is a
 * `404` — and that is not in tension with A7. A7 requires a *cross-org* read to be
 * indistinguishable from a nonexistent one, and both of those carry well-formed
 * UUIDs, so they meet in `assertFound`. `tryUuidToBuffer`'s own commentary describes
 * the case where a malformed id must also answer `404`: an org id at an org switch,
 * where the value being probed is the tenant itself. A period id is not that.
 */
export const periodRefSchema = z.strictObject({
  periodId: z.uuid(),
});

export type GenerateFiscalYearInput = z.infer<typeof generateFiscalYearInputSchema>;
export type CreatePeriodInput = z.infer<typeof createPeriodInputSchema>;
export type ListPeriodsInput = z.infer<typeof listPeriodsInputSchema>;
export type PeriodRef = z.infer<typeof periodRefSchema>;

/**
 * Parses at the service boundary, turning a Zod failure into the error the rest of
 * the system already understands.
 *
 * `ValidationError` and not a raw `ZodError`: `src/errors/errors.ts` states that
 * schema violations map here, and `toWireError` only knows how to serialize an
 * `OpenBooksError` — anything else becomes a bare `internal_error`, so a mistyped
 * field would reach a client as a 500.
 */
export function parseServiceInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  subject: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError(`Invalid ${subject}.`, result.error.issues.map(toValidationIssue));
}

function toValidationIssue(issue: z.core.$ZodIssue): ValidationIssue {
  return { path: formatIssuePath(issue.path), message: issue.message };
}

/**
 * `ValidationIssue.path` is documented as a dotted path. Zod's path segments are
 * `PropertyKey`s, and `Array.prototype.join` throws outright on a symbol — no schema
 * here has a symbol key, but a `TypeError` raised while reporting a validation
 * failure would replace a 400 with a 500, so the segments are stringified
 * defensively rather than joined directly.
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => (typeof segment === 'symbol' ? segment.toString() : String(segment)))
    .join('.');
}
