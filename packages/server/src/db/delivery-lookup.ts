import { rawDb } from './client';
import { ambientTransaction } from './transaction-scope';

/**
 * The one sanctioned unauthenticated read on the whole API (OB-121, ROADMAP D-74):
 * resolving a hosted invoice page's capability token to the delivery row it names.
 *
 * `invoice_deliveries` is a tenant table (`tenant-tables.ts`) and every other reader
 * of it goes through `tenantDb(orgId)`. This one cannot: the public endpoint has
 * nothing but the token in the URL, and the token is what *establishes* which org
 * the request belongs to — `0007_invoice_delivery.ts`'s header states the same
 * reason the row's `key_prefix` index is bare (`(key_prefix)`, not
 * `(org_id, key_prefix)`). So this file is a second, narrow exception to "tenant
 * tables are only reachable through `tenantDb`", exactly as `org-scope.ts` is an
 * exception for converting a context's `orgId` and for the same kind of reason: one
 * function, in `src/db/`, doing the one thing that cannot otherwise be expressed.
 *
 * What it returns is deliberately minimal — enough to verify a credential and
 * nothing else. `packages/server/src/modules/delivery/token.ts` is the only caller,
 * and it compares `token_hash` in constant time and hands back an `orgId`; every
 * other fact about the delivery (the invoice, the artifact key) is read again
 * afterwards through `tenantDb(orgId)`, once the org is known, so the ordinary
 * scoping still applies to everything but this one credential check — defense in
 * depth, not a shortcut around it.
 */
export interface DeliveryCredentialRow {
  readonly id: Buffer;
  readonly orgId: Buffer;
  readonly tokenHash: Buffer;
}

export async function selectDeliveryCredentialByKeyPrefix(
  keyPrefix: string,
): Promise<DeliveryCredentialRow | undefined> {
  // Joins an ambient transaction for the reason `tenantDb`/`systemDb` do
  // (`transaction-scope.ts`): this read has no transaction of its own to open, and a
  // caller reached from inside one — a test harness, principally, since production
  // serves this from a bare request with no ambient scope — must not land on a
  // second connection that cannot see what the first has not committed.
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('invoice_deliveries')
    .select(['id', 'org_id', 'token_hash'])
    .where('key_prefix', '=', keyPrefix)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return { id: row.id, orgId: row.org_id, tokenHash: row.token_hash };
}
