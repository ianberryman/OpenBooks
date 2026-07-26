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
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE idempotency_keys (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      idempotency_key      VARCHAR(255) NOT NULL,
      endpoint             VARCHAR(255) NOT NULL,
      request_fingerprint  CHAR(64)     NOT NULL,
      response_status      SMALLINT UNSIGNED NULL,
      response_body        JSON         NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      completed_at         DATETIME(3)  NULL,
      expires_at           DATETIME(3)  NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_idempotency_org_key (org_id, idempotency_key),
      KEY idx_idempotency_expires (expires_at),
      CONSTRAINT fk_idempotency_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
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
