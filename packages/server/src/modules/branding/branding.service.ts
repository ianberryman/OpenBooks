import type { OrgBranding, UpdateOrgBrandingRequest } from '@openbooks/shared-types';
import { updateOrgBrandingRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import { newUuid } from '../../db';
import { assertFound, InternalError, parseInput } from '../../errors';
import { storageProvider } from '../../providers';
import { requirePermission } from '../permissions';

import type { BrandingPatch, BrandingRow, OrgIdentityRow } from './branding.repository';
import { orgScope, selectBranding, selectOrgIdentity, upsertBranding } from './branding.repository';

/**
 * The letterhead an org's invoices print under (OB-124, Phase 1 delivery).
 *
 * Three operations, and every one of them checks `branding.read` or
 * `branding.write` **before** touching the payload — `invoices.service.ts`'s rule,
 * restated here because this is the first module to apply it to a resource that has
 * no lifecycle of its own, just a row.
 *
 * ## Why `getBranding` never throws 404
 *
 * Every other singleton-per-org setting in this codebase (`org_accounting_settings`)
 * answers "nothing nominated" with nulls rather than a miss, because no row and a
 * row of nulls mean the same thing. Branding carries that one step further: even the
 * *name* on an unconfigured letterhead has an answer — the org's own name, which
 * exists from the moment the org does — so there is no state this read has to
 * refuse. A client building an invoice preview before anyone has opened the
 * branding settings gets something to render rather than a 404 it has to special-case.
 *
 * ## Why the org's own name, not `null`
 *
 * `display_name` is the one `NOT NULL` column in `org_branding`
 * (`0007_invoice_delivery`): a rendered invoice cannot print under no name at all.
 * The org's name is the only value available before anyone has filled in a
 * letterhead, so it is what a first `updateBranding`/`uploadLogo` write falls back
 * to as well — see `resolveFallbackDisplayName` below.
 */

const BRANDING_RESOURCE = 'org_branding';

export async function getBranding(
  ctx: RequestContext = getContext('getBranding()'),
): Promise<OrgBranding> {
  await requirePermission(ctx, 'branding.read');

  const row = await selectBranding(orgScope(ctx));
  if (row !== undefined) return toOrgBranding(row);

  const identity = await requireOrgIdentity(ctx);
  return {
    displayName: identity.name,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    email: null,
    phone: null,
    website: null,
    taxNumber: null,
    logoStorageKey: null,
    brandColor: null,
    invoiceFooter: null,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.createdAt.toISOString(),
  };
}

/**
 * Creates or edits the org's letterhead.
 *
 * The whole operation — resolving a fallback name, writing the patch, reading the
 * result back — runs in one transaction, for `updateControlAccounts`'s reason: it
 * is the shape that makes `resolveFallbackDisplayName`'s extra read (see below) and
 * the upsert agree on the same view of the row rather than racing a concurrent
 * write between them.
 */
export async function updateBranding(
  patch: UpdateOrgBrandingRequest,
  ctx: RequestContext = getContext('updateBranding()'),
): Promise<OrgBranding> {
  await requirePermission(ctx, 'branding.write');
  const input = parseInput(updateOrgBrandingRequestSchema, patch);

  return orgScope(ctx).transaction(async (trx) => {
    const fallbackDisplayName = await resolveFallbackDisplayName(ctx, input.displayName);

    // `null` clears, absent leaves alone — `contacts.service.ts`'s `updateContact`
    // rebuilds its patch the same way, field by field, rather than passing the
    // parsed request straight through: only `undefined` means "absent", and JSON
    // has no way to send `undefined`, so a client wanting to clear a field sends
    // `null` and gets exactly that.
    const values: BrandingPatch = {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.addressLine1 === undefined ? {} : { addressLine1: input.addressLine1 }),
      ...(input.addressLine2 === undefined ? {} : { addressLine2: input.addressLine2 }),
      ...(input.city === undefined ? {} : { city: input.city }),
      ...(input.region === undefined ? {} : { region: input.region }),
      ...(input.postalCode === undefined ? {} : { postalCode: input.postalCode }),
      ...(input.country === undefined ? {} : { country: input.country }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.phone === undefined ? {} : { phone: input.phone }),
      ...(input.website === undefined ? {} : { website: input.website }),
      ...(input.taxNumber === undefined ? {} : { taxNumber: input.taxNumber }),
      ...(input.logoStorageKey === undefined ? {} : { logoStorageKey: input.logoStorageKey }),
      ...(input.brandColor === undefined ? {} : { brandColor: input.brandColor }),
      ...(input.invoiceFooter === undefined ? {} : { invoiceFooter: input.invoiceFooter }),
    };

    await upsertBranding(trx, values, fallbackDisplayName);

    return toOrgBranding(assertFound(await selectBranding(trx), BRANDING_RESOURCE));
  });
}

/**
 * Uploads a logo and points the branding row at it.
 *
 * `storageProvider().put` runs before the transaction rather than inside it,
 * matching `outboundEmail`/`storageProvider`'s own shape (`providers/index.ts`):
 * the object store is not transactional with MySQL, so nothing about wrapping the
 * `put` in the database transaction would make the two consistent, and it would
 * only hold a row lock for the duration of a network call. What is written to
 * `org_branding` — the key the bytes were actually stored under — is what the
 * transaction below has to get right, and that is a plain upsert.
 */
export async function uploadLogo(
  bytes: Uint8Array,
  contentType: string,
  ctx: RequestContext = getContext('uploadLogo()'),
): Promise<OrgBranding> {
  await requirePermission(ctx, 'branding.write');

  const key = `org/${ctx.orgId}/branding/${newUuid()}`;
  await storageProvider().put(key, bytes, contentType);

  return orgScope(ctx).transaction(async (trx) => {
    const fallbackDisplayName = await resolveFallbackDisplayName(ctx, undefined);
    await upsertBranding(trx, { logoStorageKey: key }, fallbackDisplayName);

    return toOrgBranding(assertFound(await selectBranding(trx), BRANDING_RESOURCE));
  });
}

/**
 * The name `upsertBranding` falls back to when a patch has no `displayName`.
 *
 * Reads `orgs` even when the branding row already exists and the fallback will go
 * unused — `upsertBranding`'s update side omits `display_name` whenever the caller
 * didn't send one, so the value resolved here is discarded on every write but the
 * first. That costs one extra indexed read on a write that already touches the
 * database, in exchange for not having to ask "does this org have a branding row
 * yet" before deciding whether to ask "what is this org called" — which would be
 * the read-then-branch race `upsertBranding`'s own comment rules out, moved up a
 * layer instead of removed.
 */
async function resolveFallbackDisplayName(
  ctx: RequestContext,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) return requested;
  return (await requireOrgIdentity(ctx)).name;
}

/**
 * The org row a context's `orgId` must name, or an `InternalError`.
 *
 * Not a 404: by the time a service sees `ctx`, `orgId` has already come through a
 * resolved session (`org-scope.ts`'s reasoning for why *its* failure is a 500 and
 * not a 400 applies identically here) — a miss is a wiring fault in this process,
 * never a shape of client input, and answering it with the same `NotFoundError` a
 * client-supplied id gets would misdescribe what went wrong.
 */
async function requireOrgIdentity(ctx: RequestContext): Promise<OrgIdentityRow> {
  const identity = await selectOrgIdentity(ctx);
  if (identity === undefined) {
    throw new InternalError(
      `Context named an org (${ctx.orgId}) with no row in \`orgs\`. This context's orgId ` +
        'originates from a resolved session, so a miss here is a server-side wiring fault ' +
        'rather than client input.',
    );
  }
  return identity;
}

function toOrgBranding(row: BrandingRow): OrgBranding {
  return {
    displayName: row.displayName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    email: row.email,
    phone: row.phone,
    website: row.website,
    taxNumber: row.taxNumber,
    logoStorageKey: row.logoStorageKey,
    brandColor: row.brandColor,
    invoiceFooter: row.invoiceFooter,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
