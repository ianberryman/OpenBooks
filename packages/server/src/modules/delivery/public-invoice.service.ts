import type { PublicInvoiceView } from '@openbooks/shared-types';

import type { OrgId, TenantDatabase } from '../../db';
import { bufferToUuid, systemDb, tenantDb } from '../../db';
import { InternalError } from '../../errors';
import { storageProvider } from '../../providers';
import { selectContactById } from '../contacts/contacts.repository';
import type { DocumentLineRow, DocumentRow, TaxRateRow } from '../invoices/ar-documents.repository';
import {
  selectDocumentById,
  selectDocumentLines,
  selectTaxRates,
} from '../invoices/ar-documents.repository';
import { INVOICE_KIND } from '../invoices/kinds';
import { toDocumentLine, toTaxSummary, toTotals } from '../invoices/projection';
import { selectAllConnections } from '../payments-processing/connections.repository';

import { verifyDeliveryToken } from './token';

/**
 * The hosted invoice page's data (OB-121; ROADMAP D-74).
 *
 * `getPublicInvoiceView` and `getPublicInvoiceArtifact` are the only two functions
 * here, and both take the raw token off the URL and nothing else — no
 * `RequestContext`, no session, no permission check. The token *is* the
 * authorization: `token.ts`'s `verifyDeliveryToken` is what stands in for
 * `requirePermission` on every other read in this system, and both functions below
 * return `null` for every way the token can fail to name a viewable invoice —
 * unknown token, or (structurally impossible outside a bug elsewhere, but handled
 * the same way regardless) a delivery whose invoice has since become unreadable.
 * `transport/routes/public-invoices.ts` turns `null` into the same 404 A7 uses
 * everywhere else, so a forged token and a token for an invoice from another org
 * are indistinguishable from each other and from a token that was never issued.
 *
 * ## Why this is allowed to reach `tenantDb` with no `RequestContext`
 *
 * Spec §4's rule is that a tenant table is unreachable without an org scope, not
 * that the org has to come from a session. `verifyDeliveryToken` resolves the org
 * the same way `resolveIdentity` resolves one from a session cookie — by looking up
 * a presented credential — and everything after that point goes through
 * `tenantDb(orgId)` exactly as an authenticated request would, so cross-org
 * isolation is enforced by the same mechanism and is not weakened by the absence of
 * a session.
 *
 * ## Branding has no service to call yet, on purpose
 *
 * OB-124 (S1, branding read/write) is a sibling stream this ticket does not depend
 * on (ROADMAP "S3 ... doesn't wait on S1"), so this file reads `org_branding`
 * directly through `tenantDb` rather than importing a service that may not exist
 * yet. `org_branding` is a lazily-created row (`0007_invoice_delivery.ts`) — an org
 * that has sent an invoice without ever visiting branding settings has none — so
 * absence here falls back to the org's own `name` for `displayName` and leaves
 * every other field null, which is what an unconfigured letterhead means.
 */

/**
 * How long a logo's signed URL is valid. Regenerated on every view, so this is a
 * ceiling on how stale a cached link can get, not a session lifetime.
 */
const LOGO_SIGNED_URL_TTL_SECONDS = 3600;

export async function getPublicInvoiceView(token: string): Promise<PublicInvoiceView | null> {
  const match = await verifyDeliveryToken(token);
  if (match === null) return null;

  const db = tenantDb(match.orgId);

  const delivery = await db
    .selectFrom('invoice_deliveries')
    .select(['invoice_id'])
    .where('id', '=', match.deliveryId)
    .executeTakeFirst();
  if (delivery === undefined) return null;

  return buildInvoiceView(db, match.orgId, delivery.invoice_id, token);
}

/** What a hosted-invoice capability token names, with no view built around it yet. */
export interface PublicInvoiceIdentity {
  readonly orgId: string;
  readonly invoiceId: string;
}

/**
 * The org and invoice a token names, for the one caller besides the hosted page
 * itself that needs to act on the invoice rather than render it:
 * `transport/routes/public-pay-link.ts` (OB-150), which opens a processor
 * checkout session for this invoice with no session of its own. The same
 * token → delivery lookup `getPublicInvoiceView` performs, stopping short of
 * assembling the customer-facing view — the pay-link route has no use for the
 * lines, the totals, or the branding, only the two ids `createCheckoutLink`
 * (`modules/payments-processing`) and `runAsAutomation` need.
 */
export async function resolvePublicInvoiceIdentity(
  token: string,
): Promise<PublicInvoiceIdentity | null> {
  const match = await verifyDeliveryToken(token);
  if (match === null) return null;

  const delivery = await tenantDb(match.orgId)
    .selectFrom('invoice_deliveries')
    .select(['invoice_id'])
    .where('id', '=', match.deliveryId)
    .executeTakeFirst();
  if (delivery === undefined) return null;

  return { orgId: bufferToUuid(match.orgId), invoiceId: bufferToUuid(delivery.invoice_id) };
}

/**
 * Assembles the customer-safe view of one invoice — shared by the hosted page
 * (`getPublicInvoiceView`, which reaches it through a token) and `sendInvoice` (C1,
 * OB-126), which renders this exact view to the PDF it retains. The page a customer
 * opens and the PDF they download are therefore the same document by construction,
 * not two projections kept in step by hand. `token` is woven into `pdfUrl` and
 * nowhere else — the view carries no other trace of it, and no internal id at all.
 *
 * Returns `null` when `invoiceId` names no readable invoice: the honest answer on
 * the public path, and a state the send path never reaches (C1 has just loaded and
 * validated the same row), where the caller treats a `null` as the internal fault it
 * would be.
 */
export async function buildInvoiceView(
  db: TenantDatabase,
  orgId: OrgId,
  invoiceId: Buffer,
  token: string,
): Promise<PublicInvoiceView | null> {
  const row = await selectDocumentById(db, INVOICE_KIND, invoiceId);
  if (row === undefined) return null;

  const lines = await selectDocumentLines(db, row.id);
  const rates = await selectTaxRates(db, rateIds(lines));

  const contact = await selectContactById(db, row.contact_id);
  if (contact === undefined) {
    // `fk_invoice_deliveries_invoice` and the AR document's own contact reference
    // are both RESTRICT; a delivered invoice naming a contact that no longer exists
    // would mean one of those constraints is gone. An operator fault, not a miss a
    // customer holding a valid link should see as "not found".
    throw new InternalError(
      'A delivered invoice names a contact that could not be read; ' +
        'fk_ar_documents_contact should make that impossible.',
    );
  }

  const net = sumOf(lines, (line) => line.line_amount_minor);
  const tax = sumOf(lines, (line) => line.tax_amount_minor);

  return {
    documentNumber: documentNumber(row),
    reference: row.reference,
    issueDate: row.issue_date,
    dueDate: row.due_date ?? row.issue_date,
    lines: lines.map((line) => toPublicLine(line, rates)),
    totals: toTotals(net, tax),
    taxSummary: toTaxSummary(lines, rates).map(({ taxRateId: _taxRateId, ...rest }) => rest),
    memo: row.memo,
    customerName: contact.display_name,
    branding: await publicBranding(db, orgId),
    pdfUrl: `/public/invoices/${token}/pdf`,
    payable: await isOrgPayable(db),
  };
}

/**
 * Whether the org has anywhere to send a payment right now (OB-150) — an active
 * `processor_connections` row, checked the same way `resolveActiveConnectionForOrg`
 * does, but with no `RequestContext` to check a permission against: this is a
 * public, unauthenticated read the same way the rest of this file is, so it goes
 * straight to `selectAllConnections` rather than through the ctx-gated service
 * function `modules/payments-processing` exports for its own authenticated
 * callers. Only a boolean crosses that boundary — never a connection id or which
 * processor it is, which the hosted page has no business knowing.
 */
async function isOrgPayable(db: TenantDatabase): Promise<boolean> {
  const connections = await selectAllConnections(db);
  return connections.some((connection) => connection.is_active !== 0);
}

/**
 * The org's logo object-store key, or `null`. `sendInvoice` (C1) fetches the bytes
 * behind it to embed in the PDF, which needs the raw image rather than the signed
 * URL `publicBranding` derives for the hosted page — so the one place that knows how
 * branding is stored hands out both forms rather than C1 reaching into `org_branding`
 * itself.
 */
export async function selectLogoStorageKey(db: TenantDatabase): Promise<string | null> {
  const row = await db.selectFrom('org_branding').select('logo_storage_key').executeTakeFirst();
  return row?.logo_storage_key ?? null;
}

/** The retained PDF for a token, or `null` when the token names no viewable invoice. */
export interface PublicInvoiceArtifact {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export async function getPublicInvoiceArtifact(
  token: string,
): Promise<PublicInvoiceArtifact | null> {
  const match = await verifyDeliveryToken(token);
  if (match === null) return null;

  const delivery = await tenantDb(match.orgId)
    .selectFrom('invoice_deliveries')
    .select(['artifact_storage_key'])
    .where('id', '=', match.deliveryId)
    .executeTakeFirst();
  if (delivery === undefined) return null;

  const bytes = await storageProvider().get(delivery.artifact_storage_key);
  return { bytes, contentType: 'application/pdf' };
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

function toPublicLine(
  line: DocumentLineRow,
  rates: ReadonlyMap<string, TaxRateRow>,
): PublicInvoiceView['lines'][number] {
  // `toDocumentLine` needs a tag map to fill `dimensionValueIds`, which the public
  // view has no field for — an empty map costs one lookup miss per line rather than
  // a second line-projection function to keep in step with the first.
  const wire = toDocumentLine(line, EMPTY_TAGS, rates);
  return {
    description: wire.description,
    quantity: wire.quantity,
    unitAmount: wire.unitAmount,
    netAmount: wire.netAmount,
    taxAmount: wire.taxAmount,
    grossAmount: wire.grossAmount,
  };
}

const EMPTY_TAGS: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * A sent invoice is always numbered (`invoiceDeliverySchema`'s own description of
 * `publicUrl` says as much) — approval allocates the number and `sendInvoice`
 * (C1) has nothing to send until approval has happened. A `null` here would mean a
 * delivery row was created for a draft, which nothing in this system does.
 */
function documentNumber(row: Pick<DocumentRow, 'sequence_number'>): string {
  if (row.sequence_number === null) {
    throw new InternalError(
      'A delivered invoice has no document number. Approval allocates one before a delivery can ' +
        'exist, so a delivery naming an unapproved invoice means that ordering was not kept.',
    );
  }
  return row.sequence_number.toString();
}

async function publicBranding(
  db: TenantDatabase,
  orgId: OrgId,
): Promise<PublicInvoiceView['branding']> {
  const row = await db
    .selectFrom('org_branding')
    .select([
      'display_name',
      'address_line1',
      'address_line2',
      'city',
      'region',
      'postal_code',
      'country',
      'logo_storage_key',
      'brand_color',
      'invoice_footer',
    ])
    .executeTakeFirst();

  if (row === undefined) {
    return {
      displayName: await fallbackOrgName(orgId),
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
      logoUrl: null,
      brandColor: null,
      invoiceFooter: null,
    };
  }

  return {
    displayName: row.display_name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    logoUrl:
      row.logo_storage_key === null
        ? null
        : await storageProvider().signedUrl(row.logo_storage_key, LOGO_SIGNED_URL_TTL_SECONDS),
    brandColor: row.brand_color,
    invoiceFooter: row.invoice_footer,
  };
}

/**
 * `orgs.name` when the org has never set up branding (`org_branding` is created
 * lazily — `0007_invoice_delivery.ts`). `orgs` is reached through `systemDb`
 * because it carries no `org_id` column of its own to scope on (it *is* the org).
 */
async function fallbackOrgName(orgId: OrgId): Promise<string> {
  const row = await systemDb()
    .selectFrom('orgs')
    .select('name')
    .where('id', '=', orgId)
    .executeTakeFirst();

  if (row === undefined) {
    // `invoice_deliveries.org_id` and `org_branding.org_id` both `REFERENCES orgs
    // (id) ON DELETE CASCADE`; reaching this delivery at all means its org still
    // exists.
    throw new InternalError(
      'A delivery names an org that could not be read; fk_invoice_deliveries_org should make ' +
        'that impossible.',
    );
  }
  return row.name;
}

function rateIds(lines: readonly DocumentLineRow[]): readonly Buffer[] {
  const ids = lines.map((line) => line.tax_rate_id).filter((id): id is Buffer => id !== null);
  return [...new Map(ids.map((id) => [id.toString('hex'), id])).values()];
}

function sumOf(lines: readonly DocumentLineRow[], of: (line: DocumentLineRow) => bigint): bigint {
  return lines.reduce((total, line) => total + of(line), 0n);
}
