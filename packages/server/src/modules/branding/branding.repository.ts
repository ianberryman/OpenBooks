import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { orgScope as toOrgId, systemDb, tenantDb } from '../../db';

/**
 * Data access for `org_branding` (OB-124, Phase 1 delivery).
 *
 * Shaped exactly like `org_accounting_settings` (`settings/settings.repository.ts`):
 * the row is created lazily by an upsert, `org_id` is the whole primary key
 * (`0007_invoice_delivery`), and every read of it goes through `tenantDb`. The one
 * column that differs from that model is `display_name` — it is `NOT NULL` with no
 * column default, because a rendered invoice always needs a name to print at the
 * top, so the upsert that creates the row is the one place a value for it is
 * manufactured when the caller's patch didn't send one.
 */

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/** The org's branding row, in the shape the service maps to the wire contract. */
export interface BrandingRow {
  readonly displayName: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly taxNumber: string | null;
  readonly logoStorageKey: string | null;
  readonly brandColor: string | null;
  readonly invoiceFooter: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What `getBranding` needs from the org row when no branding row exists yet. */
export interface OrgIdentityRow {
  readonly name: string;
  readonly createdAt: Date;
}

/**
 * The org's own name and the date it was created, read directly off `orgs` rather
 * than through `modules/orgs` — the same choice `periods.repository.ts` makes for
 * `selectFiscalYearStartMonth`, and for the same reason: `orgs` is a system table,
 * not a tenant one (it has no `org_id` column to scope by; it *is* the org), and an
 * import from `modules/orgs` would put an edge in the dependency graph asserting
 * that branding is built on the orgs module for a two-column read of a table it is
 * free to read directly. Scoped by `where('id', '=', orgId)` rather than by
 * `tenantDb`, since `orgs` sits outside `TENANT_TABLES`.
 */
export async function selectOrgIdentity(ctx: RequestContext): Promise<OrgIdentityRow | undefined> {
  const row = await systemDb()
    .selectFrom('orgs')
    .select(['name', 'created_at'])
    .where('id', '=', toOrgId(ctx.orgId))
    .executeTakeFirst();

  return row === undefined ? undefined : { name: row.name, createdAt: row.created_at };
}

/** The org's branding row, or `undefined` when it has never written one. */
export async function selectBranding(db: TenantDatabase): Promise<BrandingRow | undefined> {
  const row = await db.selectFrom('org_branding').selectAll().executeTakeFirst();
  return row === undefined ? undefined : toBrandingRow(row);
}

/**
 * The patch shape, in which `null` and absent are different values — the same
 * distinction `ControlAccountsPatch` carries down from its wire contract.
 * `displayName` has two states here rather than three: `updateOrgBrandingRequestSchema`
 * makes it `.optional()` and not nullish, because it cannot be cleared, only left
 * alone or replaced.
 */
export interface BrandingPatch {
  readonly displayName?: string;
  readonly addressLine1?: string | null;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly website?: string | null;
  readonly taxNumber?: string | null;
  readonly logoStorageKey?: string | null;
  readonly brandColor?: string | null;
  readonly invoiceFooter?: string | null;
}

/**
 * Writes the patch, creating the branding row if this is the org's first write.
 *
 * `INSERT … ON DUPLICATE KEY UPDATE`, for `upsertControlAccounts`'s reason: a
 * read-then-branch loses a race with itself — two concurrent first writes both see
 * no row, both insert, and the loser gets errno 1062 on a primary key. The upsert is
 * one statement holding one row lock, and `PRIMARY KEY (org_id)` is what makes the
 * conflict target unambiguous.
 *
 * The insert side and the update side deliberately build two different objects,
 * unlike `upsertControlAccounts`'s single shared one, because `display_name` is not
 * three-valued the way every other column here is. `fallbackDisplayName` (the org's
 * own name, resolved by the caller — see `branding.service.ts`) fills the insert
 * side whenever the patch didn't name one, since `display_name` is `NOT NULL` with
 * no column default and the statement must supply *some* value the moment it also
 * happens to be the statement that creates the row. The update side omits
 * `display_name` entirely under that same condition, so a patch that never
 * mentioned it leaves an existing name alone rather than overwriting it with the
 * fallback on every subsequent write.
 */
export async function upsertBranding(
  db: TenantDatabase,
  patch: BrandingPatch,
  fallbackDisplayName: string,
): Promise<void> {
  const rest = {
    ...(patch.addressLine1 === undefined ? {} : { address_line1: patch.addressLine1 }),
    ...(patch.addressLine2 === undefined ? {} : { address_line2: patch.addressLine2 }),
    ...(patch.city === undefined ? {} : { city: patch.city }),
    ...(patch.region === undefined ? {} : { region: patch.region }),
    ...(patch.postalCode === undefined ? {} : { postal_code: patch.postalCode }),
    ...(patch.country === undefined ? {} : { country: patch.country }),
    ...(patch.email === undefined ? {} : { email: patch.email }),
    ...(patch.phone === undefined ? {} : { phone: patch.phone }),
    ...(patch.website === undefined ? {} : { website: patch.website }),
    ...(patch.taxNumber === undefined ? {} : { tax_number: patch.taxNumber }),
    ...(patch.logoStorageKey === undefined ? {} : { logo_storage_key: patch.logoStorageKey }),
    ...(patch.brandColor === undefined ? {} : { brand_color: patch.brandColor }),
    ...(patch.invoiceFooter === undefined ? {} : { invoice_footer: patch.invoiceFooter }),
  };

  await db
    .insertInto('org_branding')
    .values({ display_name: patch.displayName ?? fallbackDisplayName, ...rest })
    .onDuplicateKeyUpdate({
      ...(patch.displayName === undefined ? {} : { display_name: patch.displayName }),
      ...rest,
    })
    .execute();
}

function toBrandingRow(row: {
  readonly display_name: string;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postal_code: string | null;
  readonly country: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly tax_number: string | null;
  readonly logo_storage_key: string | null;
  readonly brand_color: string | null;
  readonly invoice_footer: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}): BrandingRow {
  return {
    displayName: row.display_name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    email: row.email,
    phone: row.phone,
    website: row.website,
    taxNumber: row.tax_number,
    logoStorageKey: row.logo_storage_key,
    brandColor: row.brand_color,
    invoiceFooter: row.invoice_footer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
