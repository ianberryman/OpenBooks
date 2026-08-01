import { tenantDb } from '../../db';
import { storageProvider } from '../../providers';

import { verifyStatementToken } from './token';

/**
 * The hosted customer-statement page's data (OB-220), sibling of
 * `delivery/public-invoice.service.ts`'s OB-121/D-74 one.
 *
 * `getPublicStatementArtifact` is the only function here, and it takes the raw
 * token off the URL and nothing else — no `RequestContext`, no session, no
 * permission check. The token *is* the authorization: `token.ts`'s
 * `verifyStatementToken` is what stands in for `requirePermission` on every other
 * read in this system, and it returns `null` for every way the token can fail to
 * name a viewable statement — unknown token, or (structurally impossible outside a
 * bug elsewhere, but handled the same way regardless) a statement row whose
 * artifact has since become unreadable. `transport/routes/public-statements.ts`
 * turns `null` into the same 404 A7 uses everywhere else, so a forged token, a
 * token for another org's statement, and a URL that was never issued are
 * indistinguishable from each other.
 *
 * Unlike `public-invoice.service.ts`, there is no hosted *page* here — v1 offers
 * only the retained PDF (OB-220 part 1's scope), so this file has one function
 * where that one has three.
 *
 * ## Why this is allowed to reach `tenantDb` with no `RequestContext`
 *
 * Spec §4's rule is that a tenant table is unreachable without an org scope, not
 * that the org has to come from a session. `verifyStatementToken` resolves the org
 * the same way `resolveIdentity` resolves one from a session cookie — by looking
 * up a presented credential — and everything after that point goes through
 * `tenantDb(orgId)` exactly as an authenticated request would.
 */
export interface PublicStatementArtifact {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export async function getPublicStatementArtifact(
  token: string,
): Promise<PublicStatementArtifact | null> {
  const match = await verifyStatementToken(token);
  if (match === null) return null;

  const statement = await tenantDb(match.orgId)
    .selectFrom('customer_statements')
    .select(['artifact_storage_key'])
    .where('id', '=', match.statementId)
    .executeTakeFirst();
  if (statement === undefined) return null;

  const bytes = await storageProvider().get(statement.artifact_storage_key);
  return { bytes, contentType: 'application/pdf' };
}
