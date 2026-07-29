import { rawDb } from './client';
import { ambientTransaction } from './transaction-scope';

/**
 * A new kind of sanctioned exception to "tenant tables are only reachable
 * through `tenantDb`" — `src/db/` already carries several (`delivery-lookup.ts`,
 * `api-key-lookup.ts`, `oauth-lookup.ts`), but each of those resolves an
 * identity *before* an org is known, which `secrets` never needs to: it is
 * deliberately not a tenant table at all — see `0011_payment_processing`'s
 * header — so there is no `orgId` to scope it by. `name` is the opaque handle
 * that already folds the org (and the connection) in, exactly as an external
 * secrets manager namespaces by prefix rather than by a first-class tenant
 * column. This file is the one place that reads or writes the row, and
 * `providers/secrets/local.ts` is its only caller.
 *
 * The pattern otherwise matches those files precisely: one function per
 * direction, in `src/db/`, joining an ambient transaction for the reason
 * `tenantDb`/`systemDb` do (`transaction-scope.ts`) — connecting a processor
 * (initiative J) writes both a `processor_connections` row (tenant, through
 * `tenantDb`) and a `secrets` row (here) in the same request, and a rollback of
 * one must not leave the other committed on a second connection.
 */
export async function upsertSecret(name: string, ciphertext: Buffer): Promise<void> {
  await (ambientTransaction() ?? rawDb())
    .insertInto('secrets')
    .values({ name, ciphertext })
    .onDuplicateKeyUpdate({ ciphertext })
    .execute();
}

export async function readSecret(name: string): Promise<Buffer | undefined> {
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('secrets')
    .select('ciphertext')
    .where('name', '=', name)
    .executeTakeFirst();

  return row?.ciphertext;
}
