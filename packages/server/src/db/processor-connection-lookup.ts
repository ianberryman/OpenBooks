import type { ProcessorKind } from '@openbooks/plugin-api';

import { rawDb } from './client';
import { ambientTransaction } from './transaction-scope';
import { tryUuidToBuffer } from './uuid';

/**
 * A second unauthenticated read, alongside `delivery-lookup.ts`'s (OB-148; ROADMAP
 * D-85): resolving a processor webhook's `:connectionId` path segment to the org and
 * processor it names, before any org is known.
 *
 * `processor_connections` is a tenant table (`tenant-tables.ts`) and every other
 * reader of it goes through `tenantDb(orgId)` (see `connections.repository.ts`). This
 * one cannot: Stripe and Square post to this endpoint with no session and no org
 * header, only the connection id in the URL — the same shape `delivery-lookup.ts`'s
 * header describes for the hosted invoice page's token, applied to a webhook instead
 * of a capability link. The connection id is not itself a secret the way the
 * delivery token is (D-74's capability token has to be unguessable; a UUID path
 * segment here is not the authorization) — the request's signature, verified against
 * the connection's own `webhook_secret_ref` once the org is resolved, is what proves
 * the delivery is genuine (D-85). This lookup only answers "whose connection is
 * this," the question that has to be answered before a secret can even be fetched.
 *
 * Returns `undefined` for every way the id can fail to name a live connection —
 * malformed, or naming no row — so the route's `NotFoundError` (A7) cannot
 * distinguish a bad UUID from a genuine miss, the same collapse
 * `connectionIdBytes`/`assertFound` gives every authenticated caller of this module.
 */
export interface ProcessorConnectionLookupRow {
  readonly orgId: Buffer;
  readonly processor: ProcessorKind;
}

export async function selectProcessorConnectionOrgAndProcessor(
  connectionId: string,
): Promise<ProcessorConnectionLookupRow | undefined> {
  const bytes = tryUuidToBuffer(connectionId);
  if (bytes === undefined) return undefined;

  // Joins an ambient transaction for `delivery-lookup.ts`'s exact reason: a caller
  // reached from inside one (principally a test harness) must not land on a second
  // connection that cannot see what the first has not committed.
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('processor_connections')
    .select(['org_id', 'processor'])
    .where('id', '=', bytes)
    .executeTakeFirst();

  if (row === undefined) return undefined;
  return { orgId: row.org_id, processor: row.processor };
}
