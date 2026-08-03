import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Operational application logs, persisted to the database (OB-255; ROADMAP
 * § Operations — persist application logs to the DB).
 *
 * ## What this is, and what it is not
 *
 * The logger is pino → stdout (`src/logging/logger.ts`): structured JSON captured
 * by `docker compose logs`, with actor provenance on every line (A13). Nothing was
 * ever written to the database. This table is the self-host answer to "let an
 * operator query the logs in SQL without a separate log stack" — the `db`
 * `LogSinkProvider` (D-255-1) batches lines into it off the request path (D-255-2).
 *
 * It is deliberately *not* one of the DB-persisted domain records (`event_log`,
 * `security_events`, journal provenance): those are business facts. A log line is
 * operational output — debug/info telemetry — so, unlike them, it is neither a
 * financial record nor evidence, and the two constraints that follow are chosen on
 * that basis.
 *
 * ## System-scoped, `roles`' precedent — not `event_log`'s
 *
 * `org_id` is NULLABLE. A boot, shutdown, or migration line has no actor and no org
 * (`provenanceMixin` returns `{}` outside a request scope), and a request line
 * carries whichever org made it. Nullable-`org_id` means "shared / system", exactly
 * the `roles` case (`tenant-tables.ts`): the row is reached through `systemDb`, not
 * `tenantDb`, so `logs` is added to `SharedScopeTable` and excluded from
 * `TENANT_TABLES`. It is NOT `event_log`'s model — that table's `org_id` is
 * `NOT NULL` and it is a tenant table. No FK to `orgs`: a log line is telemetry, it
 * outlives the org it names, and an FK check on a high-volume append path buys
 * nothing here.
 *
 * ## Mutable, so retention can prune it as the app user (D-255-3)
 *
 * Logs are high-volume and must be pruned to a window (`LOG_RETENTION_DAYS`,
 * default 30). The append-only grant (`0999_app_grants`) gives the app no `DELETE`,
 * and there is no maintenance-role prune job in this codebase to copy — the only
 * existing purge (`purgeExpiredIdempotencyKeys`) runs as the app user precisely
 * because `idempotency_keys` is mutable. So `logs` is a MUTABLE table: the daily
 * retention sweep (`modules/log-retention`) deletes beyond the window as the app
 * user, the idempotency-purge shape. A log line is not a financial record, so
 * granting it `UPDATE`/`DELETE` weakens no ledger guarantee.
 *
 * Sorts between 0025 and 0999 so the grants migration still runs last (0999 names
 * `logs` in `MUTABLE_TABLES`, and a GRANT needs the table to exist).
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE logs (
      id          BINARY(16)  NOT NULL,
      -- The instant the line was emitted. DATETIME(3) is a real instant (kept as a
      -- Date, unlike a calendar DATE); the retention prune deletes on it.
      logged_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      -- pino's level label ('info', 'warn', …) and which of the three roles
      -- (api/worker/migrate) produced the line (config.role, A on every base line).
      level       VARCHAR(16) NOT NULL,
      role        VARCHAR(16) NOT NULL,
      message     TEXT        NOT NULL,
      -- Nullable = shared/system (the roles precedent); resolved via systemDb, never
      -- tenantDb. No FK: telemetry outlives the org it names.
      org_id      BINARY(16)  NULL,
      -- The already-redacted structured payload (the mixin's provenance plus the
      -- caller's fields, minus the credential-bearing email body the db sink drops,
      -- D-255-4). bigint money was stringified upstream by serialize.ts, so this is
      -- always JSON-serialisable.
      fields      JSON        NOT NULL,
      PRIMARY KEY (id),
      -- The retention prune's access path: DELETE FROM logs WHERE logged_at < cutoff.
      KEY idx_logs_logged_at (logged_at),
      -- Per-org querying — the whole reason org_id is a column and not just a field.
      KEY idx_logs_org_logged (org_id, logged_at),
      KEY idx_logs_level_logged (level, logged_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS logs`.execute(db);
}
