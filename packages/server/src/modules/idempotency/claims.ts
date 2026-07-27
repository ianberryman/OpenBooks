import type { Kysely } from 'kysely';

import type { DB, TenantDatabase } from '../../db';
import { withTransaction } from '../../db';

/**
 * The two namespaces a claim can live in, behind one interface (migration
 * `0003_idempotency`).
 *
 * `idempotency_keys.org_id` is nullable and the unique key is on `claim_scope`, a
 * stored generated column that is the org id when there is one and an all-zero
 * sentinel otherwise. `0003` explains why at length; the consequence here is that
 * the table is reached two different ways and neither can be expressed in terms of
 * the other:
 *
 *  - **Org claims** go through `TenantDatabase`, which injects `org_id = ?` before
 *    the caller sees the builder. That is the D-01 guarantee and it is not weakened
 *    for this table.
 *  - **Global claims** have no org to inject, so they cannot go through the tenant
 *    wrapper at all — `insertInto` would write the scope buffer into `org_id` and
 *    fail `fk_idempotency_org`, and `selectFrom` would compare a NULL column with
 *    `=`, which is NULL and never true. They go through the system handle with
 *    `claim_scope = <sentinel>` written out instead, which is the same one predicate
 *    the unique index is built on, so the read is still a single index lookup.
 *
 * The interface exists so `service.ts` states the claim protocol once. Everything
 * that decides *whether* a key is free, replayed, or in conflict lives there; a
 * store only knows how to address the row.
 */

/**
 * The `claim_scope` value for a claim with no org: sixteen zero bytes, matching
 * `COALESCE(org_id, 0x00000000000000000000000000000000)` in `0003`.
 *
 * Not a valid org id — every real one is a v4 UUID, whose version nibble is 4 — so
 * global claims share one namespace with each other and can never collide with a
 * tenant's.
 */
const GLOBAL_CLAIM_SCOPE = Buffer.alloc(16);

/** The columns `settleExistingClaim` decides on. */
const CLAIM_COLUMNS = [
  'id',
  'request_fingerprint',
  'response_status',
  'response_body',
  'completed_at',
  'expires_at',
] as const;

export interface ClaimRecord {
  readonly id: Buffer;
  readonly request_fingerprint: string;
  readonly response_status: number | null;
  readonly response_body: unknown;
  readonly completed_at: Date | null;
  readonly expires_at: Date;
}

export interface NewClaim {
  readonly id: Buffer;
  readonly key: string;
  readonly endpoint: string;
  readonly fingerprint: string;
  readonly expiresAt: Date;
}

/**
 * Row-level access to one claim namespace.
 *
 * `H` is the handle the guarded operation is given — the org-scoped
 * `TenantDatabase` for an org claim, the transactional system handle for a global
 * one. It is a type parameter rather than a field on `IdempotencySpec` because the
 * two operations are genuinely different shapes: an org write is handed a scoped
 * builder it must use, and a global write joins the claim's transaction ambiently
 * and needs nothing passed to it.
 */
export interface ClaimStore<H> {
  /** The handle to run the guarded operation on. */
  readonly handle: H;
  transaction<R>(body: (store: ClaimStore<H>) => Promise<R>): Promise<R>;
  find(key: string): Promise<ClaimRecord | undefined>;
  /** Throws the driver's `ER_DUP_ENTRY` when the key is already claimed. */
  insert(claim: NewClaim): Promise<void>;
  /** Rows updated — zero is the fault `completeClaim` reports. */
  complete(id: Buffer, status: number, body: string, completedAt: Date): Promise<number>;
  discard(id: Buffer): Promise<void>;
  purgeExpired(now: Date, batchSize: number): Promise<number>;
}

export function orgClaims(db: TenantDatabase): ClaimStore<TenantDatabase> {
  return {
    handle: db,

    transaction: (body) => db.transaction((trx) => body(orgClaims(trx))),

    find: (key) =>
      db
        .selectFrom('idempotency_keys')
        .select(CLAIM_COLUMNS)
        // The unique index is `(claim_scope, idempotency_key)` and the wrapper has
        // already added `org_id`, which for a tenant row is `claim_scope`, so this is
        // one index lookup. It is also why the same key in two orgs is two claims.
        .where('idempotency_key', '=', key)
        .executeTakeFirst(),

    insert: async (claim) => {
      await db
        .insertInto('idempotency_keys')
        .values({
          id: claim.id,
          idempotency_key: claim.key,
          endpoint: claim.endpoint,
          request_fingerprint: claim.fingerprint,
          expires_at: claim.expiresAt,
        })
        .execute();
    },

    complete: async (id, status, body, completedAt) => {
      const results = await db
        .updateTable('idempotency_keys')
        .set({ response_status: status, response_body: body, completed_at: completedAt })
        .where('id', '=', id)
        .execute();
      return Number(results[0]?.numUpdatedRows ?? 0n);
    },

    discard: async (id) => {
      await db.deleteFrom('idempotency_keys').where('id', '=', id).execute();
    },

    purgeExpired: async (now, batchSize) => {
      const results = await db
        .deleteFrom('idempotency_keys')
        .where('expires_at', '<=', now)
        .limit(batchSize)
        .execute();
      return Number(results[0]?.numDeletedRows ?? 0n);
    },
  };
}

export function globalClaims(db: Kysely<DB>): ClaimStore<Kysely<DB>> {
  return {
    handle: db,

    // `withTransaction` and not `db.transaction()`: the guarded operation is
    // `register` or `createOrg`, each of which opens a system transaction of its own,
    // and joining requires the ambient scope to be published. See
    // `src/db/transaction-scope.ts`.
    transaction: (body) => withTransaction(db, (trx) => body(globalClaims(trx))),

    find: (key) =>
      db
        .selectFrom('idempotency_keys')
        .select(CLAIM_COLUMNS)
        .where('claim_scope', '=', GLOBAL_CLAIM_SCOPE)
        .where('idempotency_key', '=', key)
        .executeTakeFirst(),

    insert: async (claim) => {
      await db
        .insertInto('idempotency_keys')
        // Explicitly null, which is what makes `claim_scope` compute to the sentinel.
        // There is no org for this write to belong to and no `fk_idempotency_org` row
        // it could point at.
        .values({
          id: claim.id,
          org_id: null,
          idempotency_key: claim.key,
          endpoint: claim.endpoint,
          request_fingerprint: claim.fingerprint,
          expires_at: claim.expiresAt,
        })
        .execute();
    },

    complete: async (id, status, body, completedAt) => {
      const results = await db
        .updateTable('idempotency_keys')
        .set({ response_status: status, response_body: body, completed_at: completedAt })
        .where('id', '=', id)
        // Redundant beside the primary key and kept anyway: every statement in this
        // store carries the scope predicate, so none of them can be copied into a
        // context where it would address a tenant's row.
        .where('claim_scope', '=', GLOBAL_CLAIM_SCOPE)
        .execute();
      return Number(results[0]?.numUpdatedRows ?? 0n);
    },

    discard: async (id) => {
      await db
        .deleteFrom('idempotency_keys')
        .where('id', '=', id)
        .where('claim_scope', '=', GLOBAL_CLAIM_SCOPE)
        .execute();
    },

    purgeExpired: async (now, batchSize) => {
      const results = await db
        .deleteFrom('idempotency_keys')
        .where('claim_scope', '=', GLOBAL_CLAIM_SCOPE)
        .where('expires_at', '<=', now)
        .limit(batchSize)
        .execute();
      return Number(results[0]?.numDeletedRows ?? 0n);
    },
  };
}
