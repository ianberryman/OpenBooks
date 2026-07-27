import type {
  CreateTaxRateRequest,
  ListTaxRatesQuery,
  TaxRatePage,
  TaxRateResponse,
  UpdateTaxRateRequest,
} from '@openbooks/shared-types';
import {
  createTaxRateRequestSchema,
  listTaxRatesQuerySchema,
  taxRateFromPercentString,
  taxRateUnits,
  updateTaxRateRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { resolvePageLimit } from '../../db';
import { assertFound, parseInput } from '../../errors';
import { requirePermission } from '../permissions';
import type { TaxRatePatch } from './tax-rates.repository';
import {
  ACCOUNT_RESOURCE,
  deleteTaxRateRow,
  hasApDocumentLines,
  hasArDocumentLines,
  insertTaxRate,
  orgScope,
  selectTaxAccount,
  selectTaxRateById,
  selectTaxRateByIdForUpdate,
  selectTaxRatesPage,
  TAX_RATE_RESOURCE,
  taxAccountInactiveError,
  taxAccountTypeError,
  taxRateIdBytes,
  taxRateInUseError,
  toTaxRate,
  updateTaxRateRow,
} from './tax-rates.repository';

/**
 * The per-org tax rate list (OB-066; ROADMAP D-35).
 *
 * Read `index.ts` for the surface and for the four decisions this module records
 * — the create-only percentage, archive versus delete, what a tax account may be,
 * and zero-rated versus exempt — and `packages/shared-types/src/tax/` for the rate
 * representation and the wire contract. The arithmetic that consumes a rate is
 * `shared-types/src/tax/compute.ts` and is not reimplemented here.
 *
 * Three things are uniform across every operation below and stated once here
 * rather than at each, following `dimensions.service.ts`:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else; validating first would
 *    describe an API surface they are not entitled to. Enforcement is
 *    service-layer only (spec §2.4, §5).
 *
 * 2. **Every payload is parsed with the shared zod schema**, because the HTTP
 *    route is not the only caller (spec §12; see `parseInput`).
 *
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined the read to the context's org, so a cross-org id returns no
 *    row and reaches the same line a nonexistent id reaches (A7). That applies to
 *    the *nominated account* as well as to the rate — see `resolveTaxAccount`.
 */

/**
 * Creates one rate, active.
 *
 * `tax_rates.write` alone and not also `tax_rates.read`, even though this returns
 * the created row: reading back what you just wrote is part of the write, and
 * requiring both would make every write role a read role for no gain. The same
 * applies to every other write below.
 *
 * The percentage is parsed by `taxRateFromPercentString` rather than by anything
 * this module derives. That is the one route a percentage takes into the system,
 * so `"08"`, `"20%"`, `"-5"`, `"0.00001"` and `"101"` are refused with the
 * parser's own reason, and the stored integer is exact by construction. `"0"` is
 * *not* among them: a zero-rated supply is a rate, and the argument for why is on
 * `index.ts`.
 *
 * No transaction. The two writes a create would need to serialize — the account
 * check and the insert — are already covered: `fk_tax_rates_account` is the
 * guarantee that the account exists and is this org's, and the check exists for
 * the error surface rather than for integrity (A7). A deactivation racing this
 * create is possible and accepted, on the same terms `assertAccountsPostable`
 * accepts it: the account still exists, and the rate can be repointed.
 */
export async function createTaxRate(
  input: CreateTaxRateRequest,
  ctx: RequestContext,
): Promise<TaxRateResponse> {
  await requirePermission(ctx, 'tax_rates.write');
  const request = parseInput(createTaxRateRequestSchema, input);

  const db = orgScope(ctx);
  const accountId = await resolveTaxAccount(db, request.accountId);

  const row = await insertTaxRate(db, {
    name: request.name,
    ratePpm: toRatePpm(request.percentage),
    taxAccountId: accountId,
    // Omitted rather than defaulted here, so `both` is the column's default in one
    // place (`0005_subledger`) instead of two that can disagree.
    ...(request.appliesTo === undefined ? {} : { appliesTo: request.appliesTo }),
  });

  return toTaxRate(row);
}

export async function getTaxRate(taxRateId: string, ctx: RequestContext): Promise<TaxRateResponse> {
  await requirePermission(ctx, 'tax_rates.read');

  const db = orgScope(ctx);
  const id = assertFound(taxRateIdBytes(taxRateId), TAX_RATE_RESOURCE);

  return toTaxRate(assertFound(await selectTaxRateById(db, id), TAX_RATE_RESOURCE));
}

/**
 * One page of the org's rates, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`, because the schema is a
 * restatement and the function is the authority — spec §12 puts an MCP tool and
 * the workflow engine on this service with no schema in front of them.
 *
 * The `appliesTo` filter asks which rates a document of that kind may *use*, so it
 * is not an equality on the column: `sales` returns the sales-only rates and the
 * unrestricted ones, because a `both` rate is one a sales document may cite. An
 * equality would hide every unrestricted rate from both pickers, which is every
 * rate an org that does not reclaim input tax holds. The predicate is in
 * `selectTaxRatesPage`, next to the column it reads.
 */
export async function listTaxRates(
  query: ListTaxRatesQuery,
  ctx: RequestContext,
): Promise<TaxRatePage> {
  await requirePermission(ctx, 'tax_rates.read');
  const filters = parseInput(listTaxRatesQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectTaxRatesPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toTaxRate), nextCursor: page.nextCursor };
}

/**
 * Renames a rate, repoints it at a different tax account, or both.
 *
 * ## The percentage is not here, and cannot be reached from here
 *
 * D-35's rule, argued at length on `updateTaxRateRequestSchema`: a rate a posted
 * document names must not change, because the document's tax was computed from it
 * once and the journal is immutable (spec §2.2). Change the percentage and
 * recomputing January's invoice from its own lines yields a figure the January
 * journal disagrees with — the subledger and the ledger giving two answers, which
 * is the divergence D-34 refuses to make possible. It is also not what a rate
 * change *is*: when a jurisdiction moves VAT from 17.5% to 20% both rates are
 * true, of different dates, and one row that silently became 20% cannot express
 * that.
 *
 * Enforced in three independent places, so no single edit relaxes it:
 *
 * 1. `updateTaxRateRequestSchema` is a `strictObject` with no `percentage`, so
 *    `parseInput` answers a supplied one with a `validation_failed` naming the
 *    field — a visible refusal rather than a silent drop.
 * 2. `TaxRatePatch` has no rate field, so an update statement that set `rate_ppm`
 *    does not typecheck. That is what covers the callers spec §12 puts on this
 *    service with no schema in front of them.
 * 3. `updateTaxRateRow` names the three columns it may set.
 *
 * The correction path is `createTaxRate` at the right percentage plus
 * `archiveTaxRate` on the old one, which is the same shape the delete refusal
 * points at.
 *
 * `accountId` *is* mutable, and the contrast is the test of the argument: it
 * changes where future tax posts and leaves every past posting exactly where it
 * was. `isActive` is absent too — archiving decides whether the rate is offered
 * for a new line, which is not a side effect of relabelling it.
 */
export async function updateTaxRate(
  taxRateId: string,
  input: UpdateTaxRateRequest,
  ctx: RequestContext,
): Promise<TaxRateResponse> {
  await requirePermission(ctx, 'tax_rates.write');
  const request = parseInput(updateTaxRateRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(taxRateIdBytes(taxRateId), TAX_RATE_RESOURCE);
  assertFound(await selectTaxRateById(db, id), TAX_RATE_RESOURCE);

  const accountId =
    request.accountId === undefined ? undefined : await resolveTaxAccount(db, request.accountId);

  const patch: TaxRatePatch = {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(accountId === undefined ? {} : { taxAccountId: accountId }),
    ...(request.appliesTo === undefined ? {} : { appliesTo: request.appliesTo }),
  };

  await updateTaxRateRow(db, id, patch);
  return toTaxRate(assertFound(await selectTaxRateById(db, id), TAX_RATE_RESOURCE));
}

/**
 * Takes a rate out of circulation without removing it from the books.
 *
 * This is the only form of removal available to a rate a document names, and it is
 * what the delete path's error points at. Idempotent: an already-archived rate is
 * returned unchanged rather than refused, because a retry of an archive is a retry
 * and not a conflict.
 *
 * The nominated account is deliberately not re-checked. Archiving is how an org
 * retires a rate whose account it has already deactivated, and a check here would
 * make that state one nothing can leave.
 */
export async function archiveTaxRate(
  taxRateId: string,
  ctx: RequestContext,
): Promise<TaxRateResponse> {
  return setTaxRateActive(taxRateId, false, ctx);
}

/**
 * The counterpart, and not an optional convenience — `reactivateAccount`'s
 * argument. Without it, archiving is a one-way door: the only other way out is
 * deletion, which is exactly what a rate a document cites cannot do, and
 * `uq_tax_rates_org_name` covers archived rows, so the name could not be reused
 * either.
 */
export async function unarchiveTaxRate(
  taxRateId: string,
  ctx: RequestContext,
): Promise<TaxRateResponse> {
  return setTaxRateActive(taxRateId, true, ctx);
}

/**
 * Deletes a rate no document line cites.
 *
 * ROADMAP D-16 settles that ledger entries are never deleted, and a rate is not a
 * ledger entry — it is configuration, a percentage a document was computed from. A
 * rate nothing cites has never been computed from, so deleting it changes no past
 * figure.
 *
 * Refusing outright would have a real cost, the one `deleteAccount` and
 * `deleteDimensionValue` both name: archiving is not equivalent, because
 * `uq_tax_rates_org_name` covers archived rows, so an org that typed `VAT 20%` at
 * 2% during setup would carry that row and that name forever — and, because the
 * percentage is immutable, would have to name the corrected rate something else.
 * Deletion is what keeps the create-only rule from turning every typo into a
 * permanent one.
 *
 * ## The pre-checks are not what makes this safe
 *
 * `fk_ar_document_lines_tax_rate` and `fk_ap_document_lines_tax_rate` are both
 * `ON DELETE RESTRICT`, so the database refuses regardless of what this service
 * concluded, and `deleteTaxRateRow` translates errno 1451 into the same token the
 * pre-checks raise — the losing race is invisible to the caller rather than a
 * different failure, and never a 500. The pre-checks exist to name *which* side
 * cites the rate, because "an invoice uses it" and "a bill uses it" send someone
 * to different screens.
 *
 * The row lock narrows the window between check and delete and deliberately does
 * not close it: closing it would require OB-062 and OB-063 to lock a rate row
 * before every document-line insert, which is a lock on the hottest configuration
 * row in the invoicing path bought for no integrity the `RESTRICT` does not
 * already provide. `test/tax/tax-rates.service.test.ts` therefore asserts the
 * refusal against a real referencing row through the repository — the path with no
 * pre-check in front of it — as well as through the service.
 */
export async function deleteTaxRate(taxRateId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'tax_rates.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(taxRateIdBytes(taxRateId), TAX_RATE_RESOURCE);

    // Establishes existence, so deleting a rate that never existed — or one
    // belonging to another org — is a 404 rather than a silent success.
    assertFound(await selectTaxRateByIdForUpdate(trx, id), TAX_RATE_RESOURCE);

    if (await hasArDocumentLines(trx, id)) {
      throw taxRateInUseError(
        'At least one invoice or credit note line carries this tax rate, so it cannot be deleted.',
      );
    }
    if (await hasApDocumentLines(trx, id)) {
      throw taxRateInUseError(
        'At least one bill or vendor credit line carries this tax rate, so it cannot be deleted.',
      );
    }

    await deleteTaxRateRow(trx, id);
  });
}

/**
 * The nominated account, resolved to bytes, or the reason it cannot be nominated.
 *
 * Three refusals, in the order they can be decided:
 *
 * **Not a uuid, not in this org, or not there at all — a 404 on `account`.** The
 * read goes through `tenantDb`, so another org's account produces no row and
 * reaches the same `assertFound` a nonexistent id reaches, with `NotFoundError`
 * carrying nothing but the token (A7). Letting `fk_tax_rates_account` refuse
 * instead would be equivalent for integrity and wrong for the error surface: a
 * cross-org id would arrive as MySQL errno 1452 and become an opaque 500, which is
 * distinguishable from a nonexistent id and therefore an existence oracle.
 *
 * **The wrong kind of account — `precondition_failed`.** See `index.ts` for what
 * "sane" means here and why it is two of the five types rather than one.
 *
 * **Deactivated — `precondition_failed`, sharing `account_inactive`.** A rate
 * pointing at a deactivated account is a refusal deferred to invoice approval,
 * which is the worst moment to discover it.
 */
async function resolveTaxAccount(
  db: ReturnType<typeof orgScope>,
  accountId: string,
): Promise<Buffer> {
  const bytes = assertFound(taxRateIdBytes(accountId), ACCOUNT_RESOURCE);
  const account = assertFound(await selectTaxAccount(db, bytes), ACCOUNT_RESOURCE);

  if (account.type !== 'liability' && account.type !== 'asset') {
    throw taxAccountTypeError(account.type);
  }
  if (!account.isActive) throw taxAccountInactiveError();

  return bytes;
}

async function setTaxRateActive(
  taxRateId: string,
  isActive: boolean,
  ctx: RequestContext,
): Promise<TaxRateResponse> {
  await requirePermission(ctx, 'tax_rates.write');

  const db = orgScope(ctx);
  const id = assertFound(taxRateIdBytes(taxRateId), TAX_RATE_RESOURCE);
  assertFound(await selectTaxRateById(db, id), TAX_RATE_RESOURCE);

  await updateTaxRateRow(db, id, { isActive });
  return toTaxRate(assertFound(await selectTaxRateById(db, id), TAX_RATE_RESOURCE));
}

/**
 * The wire percentage as the integer the column holds.
 *
 * `Number` of a `bigint` bounded at 1,000,000 by `taxRateFromUnits`, which is four
 * orders of magnitude below `Number.MAX_SAFE_INTEGER` and eleven below the point
 * D-13 worries about — so this conversion is exact, unlike the one D-13 forbids
 * for money. It is needed because `rate_ppm` is `INT UNSIGNED` and the driver
 * returns and accepts an `INT` as a `number`; a `BIGINT` would have arrived as a
 * `bigint` and needed none of this.
 */
function toRatePpm(percentage: string): number {
  return Number(taxRateUnits(taxRateFromPercentString(percentage)));
}
