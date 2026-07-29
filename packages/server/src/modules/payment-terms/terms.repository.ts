import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import {
  isDuplicateEntryError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  tryUuidToBuffer,
} from '../../db';
import { ConflictError, InternalError } from '../../errors';

/**
 * Data access for `payment_terms` and the one column on `contacts` its resolution
 * reads (OB-136; ROADMAP D-79, D-107, `0012_cash_application`).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate — a cross-org term id matches no
 * row, and the service's `assertFound` turns that into the one error a miss may
 * produce (A7). Same construction as `tax-rates.repository.ts`, which this file
 * otherwise follows column for column: a settings-list table, mutable
 * (`0999_app_grants`'s `MUTABLE_TABLES`), `uq_payment_terms_org_name` answered as
 * a `ConflictError` rather than left to reach `toWireError` as an opaque 500.
 */

/** The resource token every miss on a term reports (A7). */
export const PAYMENT_TERM_RESOURCE = 'payment_term';

const PAYMENT_TERM_COLUMNS = [
  'id',
  'name',
  'net_days',
  'discount_rate_ppm',
  'discount_window_days',
  'is_active',
  'created_at',
  'updated_at',
] as const;

export interface PaymentTermRow {
  readonly id: Buffer;
  readonly name: string;
  readonly net_days: number;
  readonly discount_rate_ppm: number | null;
  readonly discount_window_days: number | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewPaymentTermRow {
  readonly name: string;
  readonly netDays: number;
  /** Both supplied or both absent — `createPaymentTermRequestSchema`'s own pairing. */
  readonly discountRatePpm?: number | undefined;
  readonly discountWindowDays?: number | undefined;
  readonly createdByUserId: Buffer;
}

/**
 * The patch shape. `discountRatePpm`/`discountWindowDays` pair here exactly as
 * they do on create — `updatePaymentTermRequestSchema` refuses one without the
 * other before this is ever built — and there is no way to *clear* a discount
 * back to null through this shape: see that schema for why a term that should
 * stop discounting is deactivated and replaced rather than edited into a
 * different kind of term.
 */
export interface PaymentTermPatch {
  readonly name?: string;
  readonly netDays?: number;
  readonly discountRatePpm?: number;
  readonly discountWindowDays?: number;
  readonly isActive?: boolean;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied term id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (A7).
 */
export function paymentTermIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

export async function insertPaymentTerm(
  db: TenantDatabase,
  input: NewPaymentTermRow,
): Promise<PaymentTermRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('payment_terms')
      .values({
        id,
        name: input.name,
        net_days: input.netDays,
        discount_rate_ppm: input.discountRatePpm ?? null,
        discount_window_days: input.discountWindowDays ?? null,
        created_by_user_id: input.createdByUserId,
      })
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, input.name);
  }

  const row = await selectPaymentTermById(db, id);
  if (row === undefined) {
    throw new InternalError('The payment term inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectPaymentTermById(
  db: TenantDatabase,
  id: Buffer,
): Promise<PaymentTermRow | undefined> {
  return db
    .selectFrom('payment_terms')
    .select(PAYMENT_TERM_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The org's terms, active first, by name — a settings-list picker order, not a
 * keyset page. `payment_terms` holds one row per named term an org bothered to
 * define, the same handful-of-rows shape `tax_rates` has, so there is no cursor
 * contract to design against a table this small (see `taxRatePageSchema`'s
 * argument for why *that* list still pages: this one does not carry the same
 * history, and OB-139 is free to add a cursor if the shape ever needs one).
 */
export async function listPaymentTermRows(
  db: TenantDatabase,
  filters: { readonly isActive?: boolean | undefined } = {},
): Promise<readonly PaymentTermRow[]> {
  let query = db.selectFrom('payment_terms').select(PAYMENT_TERM_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  return query.orderBy('is_active', 'desc').orderBy('name').execute();
}

export async function updatePaymentTermRow(
  db: TenantDatabase,
  id: Buffer,
  patch: PaymentTermPatch,
): Promise<void> {
  try {
    await db
      .updateTable('payment_terms')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.netDays === undefined ? {} : { net_days: patch.netDays }),
        ...(patch.discountRatePpm === undefined
          ? {}
          : { discount_rate_ppm: patch.discountRatePpm }),
        ...(patch.discountWindowDays === undefined
          ? {}
          : { discount_window_days: patch.discountWindowDays }),
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
      })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, patch.name ?? '');
  }

  // Affected-row count deliberately not consulted, matching `updateTaxRateRow`:
  // mysql2 does not set `CLIENT_FOUND_ROWS`, so a no-op rename reports zero rows
  // exactly as a statement matching nothing does. The caller's own read (or the
  // `assertFound` before this is called) establishes existence.
}

/**
 * The contact's default term, `undefined` when the contact does not exist in
 * this org and `null` when it exists but has never nominated one.
 *
 * Reads `contacts` directly rather than importing `modules/contacts` for the
 * reason `ar-documents.repository.ts`'s own `selectContact` does: an edge from
 * this module to the contacts module would assert that resolving a document's
 * term is *built on* the contacts module, which dependency-cruiser would then
 * enforce as though it meant something. The column is one this module reads,
 * not a capability it borrows.
 */
export async function selectContactDefaultTermId(
  db: TenantDatabase,
  contactId: Buffer,
): Promise<Buffer | null | undefined> {
  const row = await db
    .selectFrom('contacts')
    .select('default_payment_term_id')
    .where('id', '=', contactId)
    .executeTakeFirst();

  return row === undefined ? undefined : row.default_payment_term_id;
}

/**
 * `uq_payment_terms_org_name` as a `ConflictError`, matching
 * `tax-rates.repository.ts`'s `translateDuplicateName` column for column. Free
 * text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, name)`, so the colliding row is inside the caller's own org.
 */
function translateDuplicateName(error: unknown, name: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `A payment term named ${JSON.stringify(name)} already exists in this organization. Names ` +
      'are compared case- and accent-insensitively under the column’s `utf8mb4_0900_ai_ci` ' +
      'collation. A term superseded by a change in its window or rate is usually named for its ' +
      'own shape — rename this one, or archive it and create the new one — rather than reusing ' +
      'the name.',
    { name },
  );
}
