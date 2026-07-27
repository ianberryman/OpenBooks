import type { AccountType, TaxRateApplicability, TaxRateResponse } from '@openbooks/shared-types';
import { taxRateFromUnits, taxRateToPercentString } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  isDuplicateEntryError,
  isStillReferencedError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { ConflictError, InternalError, PreconditionFailedError } from '../../errors';

/**
 * Data access for the per-org tax rate list (OB-066; ROADMAP D-35).
 *
 * Everything here goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate — including the read of `accounts`,
 * which is the whole reason the account check can produce a 404 rather than errno
 * 1452 (A7). See `selectTaxAccount`.
 *
 * The other job of this file is that no driver error escapes it. MySQL answers a
 * duplicate name with errno 1062 and a delete of a still-referenced rate with
 * errno 1451; both are the client's situation rather than a fault, and both would
 * otherwise reach `toWireError` unrecognised and become an opaque 500.
 */

/**
 * The resource token every miss on a rate reports (A7). `NotFoundError` carries
 * the token as its only content, so a cross-org rate and a nonexistent one reach
 * the same line with the same payload.
 */
export const TAX_RATE_RESOURCE = 'tax_rate';

/**
 * The token a miss on the *nominated account* reports, and it must stay equal to
 * `ACCOUNT_RESOURCE` in `modules/accounts/accounts.repository.ts`.
 *
 * A literal rather than an import for the reason `posting.service.ts` uses one:
 * importing a sibling module's repository would put an edge in the dependency
 * graph asserting that tax rates are built on the chart of accounts module, which
 * dependency-cruiser would then enforce as though it meant something. The risk
 * that the two drift is real and small — a rename would have to be deliberate —
 * and `test/tax/tax-rates.service.test.ts` asserts the wire body byte for byte
 * against the one `getAccount` produces for the same id.
 */
export const ACCOUNT_RESOURCE = 'account';

const TAX_RATE_COLUMNS = [
  'id',
  'name',
  'rate_ppm',
  'tax_account_id',
  'applies_to',
  'is_active',
  'created_at',
  'updated_at',
] as const;

export interface TaxRateRow {
  readonly id: Buffer;
  readonly name: string;
  readonly rate_ppm: number;
  readonly tax_account_id: Buffer;
  readonly applies_to: TaxRateApplicability;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewTaxRateRow {
  readonly name: string;
  /** Parts per million, already through `taxRateFromPercentString`'s bounds. */
  readonly ratePpm: number;
  readonly taxAccountId: Buffer;
  /** Omitted means the column's default, `both` — see `0005_subledger`. */
  readonly appliesTo?: TaxRateApplicability;
}

/**
 * `ratePpm` is deliberately absent, and its absence is load-bearing.
 *
 * D-35 and `shared-types/src/tax/tax.ts` make the percentage create-only: a rate
 * that changed would restate the tax on documents already posted at the old one.
 * The wire schema enforces that at the boundary by not having the field; this
 * type enforces it one layer down, so an update statement that set `rate_ppm`
 * does not typecheck even when reached from a caller that never sees a schema —
 * an MCP tool or the workflow engine (spec §12).
 */
export interface TaxRatePatch {
  readonly name?: string;
  readonly taxAccountId?: Buffer;
  /**
   * Mutable where `ratePpm` is not, and the contrast is the test of that argument
   * (`updateTaxRateRequestSchema`): narrowing a rate to `sales` restates no posted
   * journal, because a document line records the tax it computed and the rate it
   * used. It changes which documents may cite the rate *next*.
   */
  readonly appliesTo?: TaxRateApplicability;
  readonly isActive?: boolean;
}

/** What the account check needs, and nothing more. */
export interface TaxAccountRow {
  readonly type: AccountType;
  readonly isActive: boolean;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function taxRateIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

export async function insertTaxRate(db: TenantDatabase, input: NewTaxRateRow): Promise<TaxRateRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('tax_rates')
      .values({
        id,
        name: input.name,
        rate_ppm: input.ratePpm,
        tax_account_id: input.taxAccountId,
        ...(input.appliesTo === undefined ? {} : { applies_to: input.appliesTo }),
      })
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, input.name);
  }

  const row = await selectTaxRateById(db, id);
  if (row === undefined) {
    throw new InternalError('The tax rate inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectTaxRateById(
  db: TenantDatabase,
  id: Buffer,
): Promise<TaxRateRow | undefined> {
  return db
    .selectFrom('tax_rates')
    .select(TAX_RATE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * Used by the delete path. `tax_rates` is in `0999_app_grants`'s `MUTABLE_TABLES`,
 * so the app user may take a locking read on it — the journal tables are not,
 * which is why nothing in this codebase locks a journal row (D-14).
 *
 * Unlike the dimensions and contacts delete paths, this lock does **not** make the
 * in-use pre-check exact. Those paths serialize because the *other* side takes the
 * same lock before inserting a reference; nothing in OB-062/OB-063 locks a rate
 * row before writing `ar_document_lines.tax_rate_id`, and asking them to would be
 * a lock on the hottest configuration row in the invoicing path for no integrity
 * gain. InnoDB still needs a shared lock on this row to validate that insert, so
 * holding an exclusive one narrows the window rather than closing it, and the
 * `RESTRICT` below is what actually guarantees the rule.
 */
export async function selectTaxRateByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<TaxRateRow | undefined> {
  return db
    .selectFrom('tax_rates')
    .select(TAX_RATE_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * The nominated liability account, read through the tenant wrapper.
 *
 * That is the whole A7 mechanism for this module. `fk_tax_rates_account` is a
 * composite `(org_id, tax_account_id)` key, so another org's account id is already
 * refused for integrity — but it is refused as MySQL errno 1452, which reaches
 * `toWireError` unrecognised and becomes a 500. Resolving here first means the row
 * simply does not appear, and the service's `assertFound` turns that into exactly
 * the 404 a nonexistent id produces. Same construction as
 * `selectPostableAccounts` in `ledger/posting.repository.ts`.
 */
export async function selectTaxAccount(
  db: TenantDatabase,
  accountId: Buffer,
): Promise<TaxAccountRow | undefined> {
  const row = await db
    .selectFrom('accounts')
    .select(['type', 'is_active'])
    .where('id', '=', accountId)
    .executeTakeFirst();

  return row === undefined ? undefined : { type: row.type, isActive: row.is_active !== 0 };
}

/**
 * `(created_at, id)` — the general ordering D-21 names, and the one this list has
 * to use rather than merely may.
 *
 * `taxRatePageSchema` argues it: `name` is mutable, a keyset over a mutable column
 * silently drops the rows that moved behind the cursor, and the immutable
 * alternative D-27 gave the chart of accounts is not available because a rate has
 * no code. Both columns here are written once.
 *
 * Unlike `idx_contacts_org_created`, there is no `(org_id, created_at, id)` index
 * on `tax_rates` — `0005_subledger` gives it `(org_id, is_active)` only — so a page
 * is a scan of the org's rates plus a sort rather than a range scan. That is
 * accepted rather than overlooked: an org's rate list is a handful of rows (D-35
 * puts compound and multi-jurisdiction rates out of scope, which is what makes
 * lists of hundreds impossible), and adding an index belongs to whoever owns the
 * migration rather than to this module.
 */
const TAX_RATE_KEYSET: KeysetOrdering<TaxRateRow> = [
  instantKey('tax_rates.created_at', (row) => row.created_at),
  uuidKey('tax_rates.id', (row) => row.id),
];

export async function selectTaxRatesPage(
  db: TenantDatabase,
  filters: {
    readonly isActive?: boolean | undefined;
    readonly appliesTo?: TaxRateApplicability | undefined;
    readonly cursor?: string | undefined;
  },
  limit: number,
): Promise<KeysetPage<TaxRateRow>> {
  let query = db.selectFrom('tax_rates').select(TAX_RATE_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  // `appliesTo` filters by *usability*, not by equality, and that is the whole
  // point of the filter: the caller asking for `sales` is a sales document's rate
  // picker, and a `both` rate is one it may use. Matching the stored value exactly
  // would hide every unrestricted rate from both pickers, which is every rate an
  // org that does not reclaim input tax holds. `both` asks for no restriction and
  // therefore filters nothing.
  if (filters.appliesTo !== undefined && filters.appliesTo !== 'both') {
    query = query.where('applies_to', 'in', [filters.appliesTo, 'both']);
  }

  // The filter goes on first so the keyset predicate composes with it rather than
  // with a different result set: a page of "active only" has to end where the next
  // page of "active only" begins.
  const rows = await applyKeyset(query, TAX_RATE_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, TAX_RATE_KEYSET, limit);
}

export async function updateTaxRateRow(
  db: TenantDatabase,
  id: Buffer,
  patch: TaxRatePatch,
): Promise<void> {
  try {
    await db
      .updateTable('tax_rates')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.taxAccountId === undefined ? {} : { tax_account_id: patch.taxAccountId }),
        ...(patch.appliesTo === undefined ? {} : { applies_to: patch.appliesTo }),
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
      })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, patch.name ?? '');
  }

  // The affected-row count is deliberately not consulted, for the reason
  // `updateAccountRow` states: mysql2 does not set `CLIENT_FOUND_ROWS`, so
  // renaming a rate to the name it already has reports zero affected rows exactly
  // as a statement that matched nothing does. Existence is established by the
  // caller's read.
}

/**
 * Deletes the rate, or refuses because a document line still cites it.
 *
 * The refusal is the database's, not this function's, and that ordering is the
 * point of the ticket: `fk_ar_document_lines_tax_rate` and
 * `fk_ap_document_lines_tax_rate` are both `ON DELETE RESTRICT`, so a cited rate
 * cannot be removed regardless of what any caller concluded. The service's
 * pre-checks are a better *message* for the ordinary case; this is the guarantee.
 *
 * Both constraints raise the same errno and this cannot tell them apart, so it
 * answers in the general wording. The service, which can tell them apart, raises
 * the same token with prose naming the side it found.
 */
export async function deleteTaxRateRow(db: TenantDatabase, id: Buffer): Promise<void> {
  try {
    await db.deleteFrom('tax_rates').where('id', '=', id).execute();
  } catch (error) {
    if (!isStillReferencedError(error)) throw error;
    throw taxRateInUseError();
  }
}

/**
 * Whether any AR document line cites this rate. Reads
 * `idx_ar_document_lines_org_tax_rate`.
 *
 * Existence, not a count: nothing needs the number, and `SELECT … LIMIT 1` stops
 * at the first match instead of scanning every line a rate has accumulated.
 *
 * Deliberately not filtered to *approved* documents. A draft invoice's lines live
 * in `ar_document_lines` exactly as an approved one's do (`0005_subledger`), the
 * `RESTRICT` does not distinguish them, and a pre-check that did would promise a
 * delete the database then refused with errno 1451 — the one outcome this module
 * exists to prevent.
 */
export async function hasArDocumentLines(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('ar_document_lines')
    .select('id')
    .where('tax_rate_id', '=', id)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/** The payables twin. `idx_ap_document_lines_org_tax_rate`. */
export async function hasApDocumentLines(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('ap_document_lines')
    .select('id')
    .where('tax_rate_id', '=', id)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * "A document cites this rate", from the pre-check and from the `RESTRICT`
 * backstop, so the race is invisible to the caller rather than a different
 * failure.
 *
 * `PreconditionFailedError` and not `ConflictError`: the request is well-formed
 * and permitted, and it is the state that forbids it. The remedy in the message is
 * the one D-35 provides — archive — and the reason it is the *only* remedy is that
 * the rate's percentage is what a posted journal was computed from, so removing
 * the row would leave a tax figure in the ledger that nothing explains.
 */
export function taxRateInUseError(detail?: string): PreconditionFailedError {
  return new PreconditionFailedError(
    'tax_rate_in_use',
    `${
      detail ?? 'A document line cites this tax rate, so it cannot be deleted.'
    } The line records the tax that was computed from this rate and posted to the ledger, so ` +
      'deleting the rate would leave a figure on an invoice — and in the tax account — that ' +
      'nothing explains. Archive it instead: an archived rate stays on every document that used ' +
      'it and is offered for no new line. If the percentage was wrong, create a new rate at the ' +
      'correct percentage and archive this one; a rate is never edited into a different rate.',
  );
}

/**
 * The rate's account is not one tax can post to.
 *
 * `precondition_failed` rather than `validation_failed`, and the distinction is
 * the one `errors.ts` draws: the id is a well-formed uuid naming a real account in
 * this org, and it is that account's *state* — its type — that forbids the
 * nomination. A different chart would make the same request valid.
 */
export function taxAccountTypeError(type: AccountType): PreconditionFailedError {
  return new PreconditionFailedError(
    'tax_account_not_a_balance_sheet_account',
    `Tax must post to a balance-sheet account, and the nominated account is of type ` +
      `${JSON.stringify(type)}. Tax collected on a sale is owed to the tax authority and tax ` +
      'paid on a purchase is reclaimable from it; either way the balance is a claim outstanding ' +
      'until the return is filed and settled, which is a liability or an asset and never income ' +
      'or expenditure. Nominating a revenue account would report the tax as turnover — ' +
      'overstating the profit by exactly the amount owed — and an expense account would do the ' +
      'mirror image, with nothing in the trial balance to show either had happened.',
  );
}

/**
 * The account exists and has been deactivated.
 *
 * Shares `assertAccountsPostable`'s token deliberately: the machine-readable fact
 * is one fact — this account cannot receive a posting — and a client branching on
 * it should not have to learn a second name for it depending on which service
 * noticed. Checked here so the refusal lands when the rate is defined rather than
 * when an invoice using it is approved, which is the point at which it would be a
 * customer waiting.
 */
export function taxAccountInactiveError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'account_inactive',
    'The nominated tax account is deactivated, so nothing can post to it. A rate pointing at it ' +
      'would fail at the moment an invoice was approved rather than now. Reactivate the account ' +
      'or nominate another.',
  );
}

/**
 * `uq_tax_rates_org_name` as a `ConflictError`.
 *
 * Free text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, name)`, so the row this collides with is inside the caller's own org
 * and naming it discloses nothing they cannot already read. Any other driver error
 * is rethrown untouched — this function knows about one constraint and must not
 * guess about the rest.
 */
function translateDuplicateName(error: unknown, name: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `A tax rate named ${JSON.stringify(name)} already exists in this organization. Names are ` +
      'compared case- and accent-insensitively under the column’s `utf8mb4_0900_ai_ci` ' +
      'collation, so a name differing only in case or in accents is the same name. A rate ' +
      'superseded by a change in the published percentage is usually named for its period — ' +
      '`VAT 17.5% (to 2011)` — rather than reusing the old name.',
    { name },
  );
}

export function toTaxRate(row: TaxRateRow): TaxRateResponse {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    // Through the primitive rather than by dividing: `rate_ppm / 10_000` is a
    // float, and `taxRateToPercentString` is the canonical spelling two clients
    // comparing rates as strings have to agree on (`shared-types/src/tax/rate.ts`).
    percentage: taxRateToPercentString(taxRateFromUnits(BigInt(row.rate_ppm))),
    accountId: bufferToUuid(row.tax_account_id),
    appliesTo: row.applies_to,
    isActive: row.is_active !== 0,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants and this is a lossless
    // rendering of one.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
