import { InternalError } from '../errors';

import { rawDb } from './client';
import { ambientTransaction } from './transaction-scope';

/**
 * The second sanctioned unauthenticated read on the API (OB-220, sibling of
 * `delivery-lookup.ts`'s OB-121/D-74 one): resolving a hosted customer-statement
 * page's capability token to the `customer_statements` row it names.
 *
 * `customer_statements` is a tenant table (`tenant-tables.ts`) and every other
 * reader of it goes through `tenantDb(orgId)`. This one cannot: the public
 * endpoint has nothing but the token in the URL, and the token is what
 * *establishes* which org the request belongs to — the same reason
 * `delivery-lookup.ts`'s header gives, and the same reason `customer_statements`'s
 * `key_prefix` index is bare (`(key_prefix)`, not `(org_id, key_prefix)`). So this
 * file is a second, narrow exception to "tenant tables are only reachable through
 * `tenantDb`", exactly as `delivery-lookup.ts` and `org-scope.ts` are.
 *
 * What it returns is deliberately minimal — enough to verify a credential and
 * nothing else. `modules/account-statements/token.ts` is the only caller, and it
 * compares `token_hash` in constant time and hands back an `orgId`; every other
 * fact about the statement (the artifact key) is read again afterwards through
 * `tenantDb(orgId)`, once the org is known, so the ordinary scoping still applies
 * to everything but this one credential check.
 */
export interface StatementCredentialRow {
  readonly id: Buffer;
  readonly orgId: Buffer;
  readonly tokenHash: Buffer;
}

export async function selectStatementCredentialByKeyPrefix(
  keyPrefix: string,
): Promise<StatementCredentialRow | undefined> {
  // Joins an ambient transaction for the reason `tenantDb`/`systemDb` do
  // (`transaction-scope.ts`): this read has no transaction of its own to open, and
  // a caller reached from inside one — a test harness, principally, since
  // production serves this from a bare request with no ambient scope — must not
  // land on a second connection that cannot see what the first has not committed.
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('customer_statements')
    .select(['id', 'org_id', 'token_hash'])
    .where('key_prefix', '=', keyPrefix)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  if (row.token_hash === null) {
    // `key_prefix` and `token_hash` are written together, exactly once, at
    // delivery time (`account-statement.service.ts#createCustomerStatement`, via
    // `token.ts#mintStatementToken`) — a statement generated without delivery
    // carries neither. A row matched by a non-null `key_prefix` therefore should
    // never carry a null `token_hash`; a bug elsewhere, not a token this function
    // should treat as merely unknown.
    throw new InternalError(
      'A customer_statements row matched by key_prefix carries no token_hash; the two columns ' +
        'are written together at delivery time and neither should exist without the other.',
    );
  }

  return { id: row.id, orgId: row.org_id, tokenHash: row.token_hash };
}
