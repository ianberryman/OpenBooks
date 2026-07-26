import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Idempotency keys (ROADMAP D-04).
 *
 * Spec §12 requires idempotency keys on *every* write endpoint, not only the
 * posting API: "a retried payment record must not double-post". §7 lists no
 * table for them, so this is an addition.
 *
 * The row is claimed inside the same transaction as the write it guards. That
 * placement is the whole design:
 *
 *   - Two concurrent requests with the same key race on `uq_idempotency_org_key`.
 *     Exactly one wins the insert; the other blocks and then sees the committed
 *     row. Spec §11's concurrency requirement ("duplicate idempotency key yields
 *     one journal") is satisfied by the unique index, not by application logic.
 *
 *   - If the write rolls back, the claim rolls back with it, so a genuine retry
 *     after a failure can re-claim the key rather than being permanently poisoned
 *     by a request that never succeeded.
 *
 * `request_fingerprint` is what makes replay safe rather than merely
 * deduplicated. Returning a cached response for a *different* request body that
 * happened to reuse a key would be silent data loss, so that case is a conflict.
 *
 * ## Why `org_id` is nullable and the unique key is on a generated column
 *
 * Some writes have no org to claim against. Registration creates the user *and* the
 * org, so it predates both; an org switch would otherwise claim against the org being
 * left. With `org_id NOT NULL` and a foreign key, those endpoints could not claim at
 * all — so they accepted an `Idempotency-Key` header and ignored it, which is worse
 * than not accepting one: a client retrying a create-org would get two orgs while the
 * API documented the opposite.
 *
 * Making `org_id` nullable alone does not fix it. MySQL treats NULLs as distinct in a
 * unique index, so `UNIQUE (org_id, idempotency_key)` would permit unlimited duplicate
 * global claims — the guarantee would silently evaporate for exactly the endpoints it
 * was extended to cover.
 *
 * Hence `claim_scope`: a stored generated column that is the org id when there is one
 * and an all-zero sentinel otherwise, with the unique key on that. Global claims
 * therefore share one namespace and collide properly, while org claims stay isolated.
 * The sentinel is not a valid org id — every real one is a v4 UUID — so it cannot
 * collide with a genuine org's namespace.
 *
 * ## Why the foreign key is RESTRICT and not CASCADE
 *
 * Not a preference. MySQL refuses a foreign key *action* on a column that a STORED
 * generated column is computed from: with `ON DELETE CASCADE` this table fails to
 * create at all, with `ERROR 1215 Cannot add foreign key constraint`. Verified against
 * MySQL 8.4 — `RESTRICT` on the identical table is accepted.
 *
 * So deleting an org is blocked while any of its claims survive, rather than taking
 * them with it. The trade is acceptable and arguably better: claims are ephemeral, they
 * carry `expires_at`, and `purgeExpiredIdempotencyKeys` reclaims them, so the blocking
 * window is bounded. Nothing deletes an org in M1; when data deletion arrives (M7), the
 * purge is an explicit step in it — which is the right shape for an operation whose
 * whole job is to know what it is removing.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE idempotency_keys (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NULL,
      claim_scope          BINARY(16)   AS (COALESCE(org_id, 0x00000000000000000000000000000000))
                                        STORED NOT NULL,
      idempotency_key      VARCHAR(255) NOT NULL,
      endpoint             VARCHAR(255) NOT NULL,
      request_fingerprint  CHAR(64)     NOT NULL,
      response_status      SMALLINT UNSIGNED NULL,
      response_body        JSON         NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      completed_at         DATETIME(3)  NULL,
      expires_at           DATETIME(3)  NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_idempotency_scope_key (claim_scope, idempotency_key),
      KEY idx_idempotency_expires (expires_at),
      CONSTRAINT fk_idempotency_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE RESTRICT,
      CONSTRAINT chk_idempotency_completion CHECK (
        (completed_at IS NULL     AND response_status IS NULL) OR
        (completed_at IS NOT NULL AND response_status IS NOT NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS idempotency_keys`.execute(db);
}
