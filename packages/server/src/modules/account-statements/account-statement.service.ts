import type {
  CreateCustomerStatementRequest,
  CustomerStatement,
  CustomerStatementList,
} from '@openbooks/shared-types';
import { createCustomerStatementRequestSchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, newUuid, orgScope as toOrgId, tenantDb, uuidToBuffer } from '../../db';
import { assertFound, InternalError, parseInput, UnauthenticatedError } from '../../errors';
import { outboundEmail, storageProvider } from '../../providers';
import type { BrandingRow, OrgIdentityRow } from '../branding/branding.repository';
import { selectBranding, selectOrgIdentity } from '../branding/branding.repository';
import {
  CONTACT_RESOURCE,
  contactIdBytes,
  selectContactById,
} from '../contacts/contacts.repository';
import { requirePermission } from '../permissions';
// Imported from the service file rather than from `modules/reports/index.ts`,
// mirroring `transport/routes/reports.ts`'s own deviation and for its exact
// reason: `getAging` is not re-exported by that barrel, and widening it is not
// this ticket's (OB-220) to make. The import is legal — this is neither a
// `*.repository.ts` nor `src/db` — and the signature is the ordinary
// `(query, ctx)` every other report service has.
import { getAging } from '../reports/aging.service';

import { createStatementRenderer } from './renderer';
import type { CustomerStatementBranding } from './renderer/types';
import type { CustomerStatementRow } from './account-statement.repository';
import {
  insertCustomerStatement,
  listCustomerStatements as selectCustomerStatements,
  selectContactNames,
  selectUserDisplayNames,
} from './account-statement.repository';
import { mintStatementToken } from './token';

/**
 * The customer statement of account (OB-220 part 1) — an open-item AR statement
 * for one contact, rendered to a branded PDF, stored behind the `StorageProvider`,
 * and recorded in `customer_statements` (append-only) so it is re-downloadable and
 * — when requested — emailed with a hosted, unauthenticated link.
 *
 * ## Surface
 *
 * | Operation                                    | Permission     |
 * | --------------------------------------------- | -------------- |
 * | `createCustomerStatement(input, ctx)`        | `reports.read` |
 * | `listCustomerStatements(contactId, ctx)`     | `reports.read` |
 *
 * Gated by `reports.read` alone, the same rationale
 * `statement-package.service.ts`'s header states: a statement is `getAging`
 * (OB-065) with `contactId` and `detail` set — "there is no second report for
 * 'what does this customer owe and since when'" (`aging.service.ts`'s own file
 * header) — rendered to a branded PDF and optionally emailed. It needs no
 * permission that report does not.
 *
 * ## Why branding is read through the repository, not through `getBranding`
 *
 * The same reason `statement-package.service.ts#resolveBranding` gives:
 * `branding.service.ts#getBranding` additionally requires `branding.read`, which
 * `apOnly` and `arOnly` do not hold despite holding `reports.read`
 * (`0001_tenancy.ts`'s per-role grants). `resolveBranding` below is copied from
 * that file rather than shared, for the same "two call sites, one small function"
 * reasoning `renderer/index.ts`'s header gives for its own duplication.
 *
 * ## Why `closingBalanceMinor` is recomputed on every list read, never stored
 *
 * `customer_statements` carries no balance column. A stored figure would be a
 * second, silently staler definition of "what this contact owes" the moment a
 * later payment or credit note posts — D-34's "outstanding has exactly one
 * definition" applied to a snapshot table. Recomputing is safe because it is
 * cheap to be safe about: D-40 makes aging *reproducible* — "as at a past date
 * must use the allocations that existed then, so the same request answers the
 * same way after a later payment lands" (`aging.service.ts`'s file header) — so
 * `getAging({ contactId, asOf: row.asOf, … })` run again today returns the exact
 * figure this statement carried at render time.
 *
 * ## Why a list row's `publicUrl` is always `null`
 *
 * The raw token is never stored — only `key_prefix` (an index key) and
 * `SHA-256(token)` (`token.ts#verifyStatementToken`'s header) — so there is no
 * stored value a list read could reconstruct it from. `publicUrl` is only ever
 * non-null on the response to the `createCustomerStatement` call that minted it,
 * the same "shown once" shape an invite token or a session cookie takes elsewhere
 * in this codebase.
 */

const DOWNLOAD_URL_TTL_SECONDS = 3600;

const ZERO_AGING_AMOUNTS = {
  current: '0',
  days1To30: '0',
  days31To60: '0',
  days61To90: '0',
  days90Plus: '0',
  total: '0',
} as const;

export async function createCustomerStatement(
  input: CreateCustomerStatementRequest,
  ctx: RequestContext = getContext('createCustomerStatement()'),
): Promise<CustomerStatement> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(createCustomerStatementRequestSchema, input);

  // `generated_by_user_id` is `NOT NULL` (`0022_account_statements`): a statement
  // this operation renders always has a human accountable for it, the same
  // invariant `statement-package.service.ts#createStatementPackage` enforces for
  // `statement_packages.generated_by_user_id`.
  if (ctx.userId === null) throw new UnauthenticatedError();
  const userId = ctx.userId;
  const generatedByUserId = uuidToBuffer(userId);

  const orgId = toOrgId(ctx.orgId);
  const db = tenantDb(orgId);

  // Resolved before the aging read below, so a cross-org or malformed contactId
  // fails on this org's own `contacts` table first, through the ordinary A7 path
  // (`assertFound` → `NotFoundError('contact')`) — the same miss `getAging` would
  // itself produce, reached here first because this function also needs the
  // contact's own name for the zero-balance case, which `getAging` does not return
  // when the contact owes nothing (`aging.service.ts#isEmpty` drops that row).
  const contactBytes = assertFound(contactIdBytes(request.contactId), CONTACT_RESOURCE);
  const contact = assertFound(await selectContactById(db, contactBytes), CONTACT_RESOURCE);

  const [aging, branding] = await Promise.all([
    getAging(
      { ledger: 'receivable', contactId: request.contactId, asOf: request.asOf, detail: true },
      ctx,
    ),
    resolveBranding(db, ctx),
  ]);

  const agingRow = aging.rows.find((candidate) => candidate.contactId === request.contactId);
  const documents = agingRow?.documents ?? [];
  const bucketTotals = agingRow?.amounts ?? ZERO_AGING_AMOUNTS;
  const closingBalanceMinor = bucketTotals.total;
  const contactName = agingRow?.contactName ?? contact.display_name;

  const logo =
    branding.logoStorageKey === null
      ? undefined
      : await storageProvider().get(branding.logoStorageKey);

  const pdf = await createStatementRenderer().render({
    branding: toRenderBranding(branding),
    ...(logo === undefined ? {} : { logo }),
    contactName,
    asOf: request.asOf,
    generatedAt: todayCalendarDate(),
    documents,
    bucketTotals,
    closingBalanceMinor,
  });

  const statementUuid = newUuid();
  const id = uuidToBuffer(statementUuid);
  // Mirrors `sendInvoice`'s and `createStatementPackage`'s key shapes: one
  // artifact per rendered statement, named by an id nothing but this row holds.
  const artifactStorageKey = `org/${ctx.orgId}/statements/customer/${statementUuid}.pdf`;
  await storageProvider().put(artifactStorageKey, pdf, 'application/pdf');

  let status: 'generated' | 'sent' | 'failed' = 'generated';
  let recipientEmail: string | null = null;
  let keyPrefix: string | null = null;
  let tokenHash: Buffer | null = null;
  let publicUrl: string | null = null;

  if (request.delivery !== undefined) {
    const minted = mintStatementToken();
    const { provider, logger, appBaseUrl } = outboundEmail();
    // `APP_BASE_URL` absent → a path, per `providers/index.ts`: the server cannot
    // infer its own public origin, and a path is still a working link once one is
    // configured. Uses the `/public/*` prefix the invoice hosted artifact takes so
    // the one existing proxy rule reaches it (`public-statements.ts`'s header).
    publicUrl = `${appBaseUrl ?? ''}/public/statements/${minted.token}/pdf`;
    recipientEmail = request.delivery.recipientEmail;
    keyPrefix = minted.keyPrefix;
    tokenHash = minted.tokenHash;

    // A provider rejection is a `status = 'failed'` row and a 200 whose body says
    // `failed`, never a 5xx — `send-invoice.service.ts`'s header: the artifact was
    // genuinely rendered and stored, and whether the provider accepted the mail is
    // data the caller asked for, not a server fault.
    status = await deliver(provider, {
      to: recipientEmail,
      contactName,
      from: branding.displayName,
      publicUrl,
    }).catch((error: unknown) => {
      logger.error(
        { err: error, contactId: request.contactId, statementId: statementUuid },
        'Customer statement delivery email was rejected by the provider.',
      );
      return 'failed' as const;
    });
  }

  // A tenant transaction for the write itself, matching
  // `createStatementPackage`'s own reasoning: every write to a tenant table in
  // this module goes through the same seam, so a future second write here does
  // not have to notice this call site was the one still outside a transaction.
  const created = await db.transaction((trx) =>
    insertCustomerStatement(trx, {
      id,
      contactId: contactBytes,
      asOf: request.asOf,
      status,
      recipientEmail,
      artifactStorageKey,
      keyPrefix,
      tokenHash,
      providerMessageId: null,
      generatedByUserId,
    }),
  );

  const names = await selectUserDisplayNames([generatedByUserId]);

  return toWire(
    created,
    contactName,
    closingBalanceMinor,
    publicUrl,
    userId,
    names.get(generatedByUserId.toString('hex')) ?? null,
  );
}

/**
 * Every statement this org has rendered, newest first, optionally narrowed to one
 * contact — each with a freshly minted signed `downloadUrl` (the wire contract's
 * own convention, `statementPackageSchema`'s doc comment, restated for
 * `customerStatementSchema`) and a recomputed `closingBalanceMinor` (see the file
 * header). `publicUrl` is always `null` on a list row, for the same header's
 * reason.
 */
export async function listCustomerStatements(
  contactId: string | undefined,
  ctx: RequestContext = getContext('listCustomerStatements()'),
): Promise<CustomerStatementList> {
  await requirePermission(ctx, 'reports.read');

  const db = tenantDb(toOrgId(ctx.orgId));

  // An unresolvable filter matches no row rather than throwing (A7): a cross-org
  // or malformed contactId used to narrow a list must read as "nothing to show",
  // the same answer a contact this org genuinely has none for produces — not a
  // distinguishable error the filter's shape alone would give away.
  let contactFilter: Buffer | undefined;
  if (contactId !== undefined) {
    const bytes = contactIdBytes(contactId);
    if (bytes === undefined) return { statements: [] };
    contactFilter = bytes;
  }

  const rows = await selectCustomerStatements(db, contactFilter);

  const [names, contactNames] = await Promise.all([
    selectUserDisplayNames(rows.map((row) => row.generatedByUserId)),
    selectContactNames(
      db,
      rows.map((row) => row.contactId),
    ),
  ]);

  const statements = await Promise.all(
    rows.map(async (row) => {
      const contactName = contactNames.get(row.contactId.toString('hex'));
      if (contactName === undefined) {
        // `fk_customer_statements_contact` is `ON DELETE RESTRICT`; a statement
        // naming a contact that cannot be read would mean that constraint is gone.
        throw new InternalError(
          'A customer statement names a contact that could not be read; ' +
            'fk_customer_statements_contact should make that impossible.',
        );
      }

      const closingBalanceMinor = await closingBalanceFor(
        ctx,
        bufferToUuid(row.contactId),
        row.asOf,
      );
      const authorUuid = bufferToUuid(row.generatedByUserId);
      const authorName = names.get(row.generatedByUserId.toString('hex')) ?? null;

      return toWire(row, contactName, closingBalanceMinor, null, authorUuid, authorName);
    }),
  );

  return { statements };
}

async function closingBalanceFor(
  ctx: RequestContext,
  contactId: string,
  asOf: string,
): Promise<string> {
  const aging = await getAging({ ledger: 'receivable', contactId, asOf, detail: false }, ctx);
  const row = aging.rows.find((candidate) => candidate.contactId === contactId);
  return row?.amounts.total ?? ZERO_AGING_AMOUNTS.total;
}

interface StatementEmail {
  readonly to: string;
  readonly contactName: string;
  readonly from: string;
  readonly publicUrl: string;
}

/**
 * Hands the message to the provider and reports whether it took it. A thrown
 * rejection is turned into `'failed'` by the caller; a clean return is `'sent'` —
 * `send-invoice.service.ts#deliver`'s own shape.
 */
async function deliver(
  provider: ReturnType<typeof outboundEmail>['provider'],
  email: StatementEmail,
): Promise<'sent'> {
  const subject = `Statement of account from ${email.from}`;
  const text =
    `${email.from} has sent ${email.contactName} a statement of account.\n\n` +
    `View and download it here: ${email.publicUrl}\n`;
  const html =
    `<p>${email.from} has sent ${email.contactName} a statement of account.</p>` +
    `<p><a href="${email.publicUrl}">View and download the statement</a></p>`;

  await provider.send({ to: email.to, subject, text, html });
  return 'sent';
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

function toRenderBranding(row: BrandingRow): CustomerStatementBranding {
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

/** A `YYYY-MM-DD` calendar date off the wall clock, for the letterhead's "Generated" line. */
function todayCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function toWire(
  row: CustomerStatementRow,
  contactName: string,
  closingBalanceMinor: string,
  publicUrl: string | null,
  generatedByUserId: string,
  generatedByName: string | null,
): Promise<CustomerStatement> {
  return {
    id: bufferToUuid(row.id),
    contactId: bufferToUuid(row.contactId),
    contactName,
    asOf: row.asOf,
    status: row.status,
    recipientEmail: row.recipientEmail,
    closingBalanceMinor,
    downloadUrl: await storageProvider().signedUrl(
      row.artifactStorageKey,
      DOWNLOAD_URL_TTL_SECONDS,
    ),
    publicUrl,
    generatedByUserId,
    generatedByName,
    createdAt: row.createdAt.toISOString(),
  };
}
