import type {
  CreateStatementPackageRequest,
  StatementPackage,
  StatementPackageList,
} from '@openbooks/shared-types';
import { createStatementPackageRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, newUuid, orgScope as toOrgId, tenantDb, uuidToBuffer } from '../../db';
import { InternalError, parseInput, UnauthenticatedError } from '../../errors';
import { storageProvider } from '../../providers';
import type { BrandingRow, OrgIdentityRow } from '../branding/branding.repository';
import { selectBranding, selectOrgIdentity } from '../branding/branding.repository';
import { requirePermission } from '../permissions';
import { getBalanceSheet, getProfitAndLoss, getStatementOfCashFlows } from '../reports';

import { createStatementPackageRenderer } from './renderer';
import type { StatementPackageBranding } from './renderer/types';
import type { StatementPackageRow } from './statement-package.repository';
import {
  insertStatementPackage,
  listStatementPackages as selectStatementPackages,
  selectUserDisplayNames,
} from './statement-package.repository';

/**
 * The statement package (initiative P, OB-195; ROADMAP P5) — a branded P&L /
 * Balance Sheet / Cash Flow bundle rendered to one PDF for a date range, stored
 * behind the `StorageProvider`, and recorded in `statement_packages` so it is
 * re-downloadable and audited.
 *
 * ## Surface
 *
 * | Operation                             | Permission     |
 * | -------------------------------------- | -------------- |
 * | `createStatementPackage(input, ctx)`  | `reports.read` |
 * | `listStatementPackages(ctx)`          | `reports.read` |
 *
 * Gated by `reports.read` alone — it renders reports the holder can already run,
 * and no more.
 *
 * ## Why branding is read through the repository, not through `getBranding`
 *
 * `branding.service.ts#getBranding` additionally requires `branding.read`, which
 * `apOnly` and `arOnly` do not hold despite holding `reports.read`
 * (`0001_tenancy.ts`'s per-role grants). Calling it here would silently widen this
 * operation's gate past the one line above, so `resolveBranding` below reads
 * `org_branding` straight off `selectBranding`/`selectOrgIdentity`
 * (`branding.repository.ts`) and reproduces `getBranding`'s own default-name
 * synthesis for the org that has never opened its letterhead.
 *
 * ## Why the effective basis is read off the P&L, not re-resolved here
 *
 * `getProfitAndLoss` already resolves `request.basis ?? org default`
 * (`profit-and-loss.service.ts#resolveBasis`) and reports the result on
 * `ProfitAndLoss.basis`. Re-deriving it here would be a second read of
 * `org_accounting_settings` that could, in principle, race a concurrent change
 * and disagree with the one the P&L actually used — so this service takes the
 * P&L's answer and passes it on to `getStatementOfCashFlows` explicitly, and
 * stores that same value on the row. The balance sheet takes no `basis` at all
 * (D-22: accrual only in M2) and is unaffected either way.
 */

const DOWNLOAD_URL_TTL_SECONDS = 3600;

export async function createStatementPackage(
  input: CreateStatementPackageRequest,
  ctx: RequestContext = getContext('createStatementPackage()'),
): Promise<StatementPackage> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(createStatementPackageRequestSchema, input);

  // `generated_by_user_id` is `NOT NULL` (`0017_accountant_close`): a package
  // this operation renders always has a human accountable for it, unlike a field
  // that merely records an actor when one happens to be present.
  if (ctx.userId === null) throw new UnauthenticatedError();
  const userId = ctx.userId;
  const generatedByUserId = uuidToBuffer(userId);

  const orgId = toOrgId(ctx.orgId);
  const db = tenantDb(orgId);

  // The balance sheet and the branding read have no dependency on the P&L's
  // resolved basis, so all three run together; the cash-flow statement is
  // requested afterward, carrying the P&L's own resolved basis forward (see the
  // file header for why it is not re-resolved independently).
  const [profitAndLoss, balanceSheet, branding] = await Promise.all([
    getProfitAndLoss(
      {
        from: request.periodStart,
        to: request.periodEnd,
        ...(request.basis === undefined ? {} : { basis: request.basis }),
      },
      ctx,
    ),
    getBalanceSheet({ asOf: request.periodEnd }, ctx),
    resolveBranding(db, ctx),
  ]);

  const cashFlow = await getStatementOfCashFlows(
    { from: request.periodStart, to: request.periodEnd, basis: profitAndLoss.basis },
    ctx,
  );

  const logo =
    branding.logoStorageKey === null
      ? undefined
      : await storageProvider().get(branding.logoStorageKey);

  const pdf = await createStatementPackageRenderer().render({
    branding: toRenderBranding(branding),
    ...(logo === undefined ? {} : { logo }),
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    basis: profitAndLoss.basis,
    generatedAt: todayCalendarDate(),
    profitAndLoss,
    balanceSheet,
    cashFlow,
  });

  const packageUuid = newUuid();
  const id = uuidToBuffer(packageUuid);
  // Mirrors `sendInvoice`'s key shape (`org/{orgId}/deliveries/{uuid}.pdf`): one
  // artifact per rendered package, named by an id nothing but this row holds.
  const artifactStorageKey = `org/${ctx.orgId}/statements/${packageUuid}.pdf`;
  await storageProvider().put(artifactStorageKey, pdf, 'application/pdf');

  // A tenant transaction for the write itself, even though it is a single insert
  // with no companion write in this org's tables today — matching
  // `updateBranding`'s shape rather than a bare `insertStatementPackage(db, …)`
  // keeps every write to a tenant table in this module going through the same
  // seam, so a future second write here does not have to notice this call site
  // was the one still outside a transaction.
  const created = await db.transaction((trx) =>
    insertStatementPackage(trx, {
      id,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      basis: profitAndLoss.basis,
      artifactStorageKey,
      generatedByUserId,
    }),
  );

  const names = await selectUserDisplayNames([generatedByUserId]);

  return toWire(created, userId, names.get(generatedByUserId.toString('hex')) ?? null);
}

/**
 * Every package this org has rendered, newest first, each carrying a freshly
 * minted signed URL — `statementPackageSchema`'s own contract: a download link is
 * "signed at read time and short-lived", so a list read mints one per row rather
 * than reusing whatever was signed at create time.
 */
export async function listStatementPackages(
  ctx: RequestContext = getContext('listStatementPackages()'),
): Promise<StatementPackageList> {
  await requirePermission(ctx, 'reports.read');

  const db = tenantDb(toOrgId(ctx.orgId));
  const rows = await selectStatementPackages(db);

  const names = await selectUserDisplayNames(rows.map((row) => row.generatedByUserId));

  const packages = await Promise.all(
    rows.map((row) => {
      const authorUuid = bufferToUuid(row.generatedByUserId);
      const name = names.get(row.generatedByUserId.toString('hex')) ?? null;
      return toWire(row, authorUuid, name);
    }),
  );

  return { packages };
}

async function resolveBranding(db: TenantDatabase, ctx: RequestContext): Promise<BrandingRow> {
  const row = await selectBranding(db);
  if (row !== undefined) return row;

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
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
  };
}

/** `branding.service.ts#requireOrgIdentity`'s reasoning: a miss here is a wiring fault. */
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

function toRenderBranding(row: BrandingRow): StatementPackageBranding {
  return {
    displayName: row.displayName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    brandColor: row.brandColor,
  };
}

/** A `YYYY-MM-DD` calendar date off the wall clock, for the cover page's "Generated" line. */
function todayCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function toWire(
  row: StatementPackageRow,
  generatedByUserId: string,
  generatedByName: string | null,
): Promise<StatementPackage> {
  return {
    id: bufferToUuid(row.id),
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    basis: row.basis,
    downloadUrl: await storageProvider().signedUrl(
      row.artifactStorageKey,
      DOWNLOAD_URL_TTL_SECONDS,
    ),
    generatedByUserId,
    generatedByName,
    createdAt: row.createdAt.toISOString(),
  };
}
