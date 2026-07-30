import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Accountant access & period close (initiative P, OB-192…199; ROADMAP D-96…D-98).
 *
 * Two append-only records and no new working state, because the working state P
 * needs already exists. Period close is a workflow *over* the M1 period lock
 * (`fiscal_periods.status`, D-97), not a new lock — `closePeriod`/`reopenPeriod`
 * and `assertPostable` were built in 0002_ledger. Adjusting entries are ordinary
 * journals marked as such (D-98), and `journals.source` is the free-form origin
 * string that marks them (`'adjusting'`/`'reclassifying'`, beside `'reversal'` and
 * `'opening'`) — a VARCHAR precisely so a new nature needs no ALTER (0002_ledger's
 * own note). So this migration adds only the two things P records that nothing else
 * does: the sign-off event and the statement-package artifact.
 *
 * ## `period_close_events` — the sign-off, and the reopen audit trail (D-97/D-98)
 *
 * One row per close or reopen. Append-only for `reconciliation_session_events`'
 * own reason (0999_app_grants): reopening a closed period is permission-gated and
 * must leave a record of who and when, and a deletable audit trail satisfies
 * neither half. The period's *status* is the mutable lock (`fiscal_periods`, taken
 * `FOR UPDATE` by `transitionPeriod`); its *history* is these immutable rows beside
 * it — the same split the reconciliation session already takes.
 *
 * The `checklist` is the advisory completeness snapshot the workflow recomputes
 * server-side at close time (D-97): unposted drafts in the period, unreconciled
 * bank lines, whether the prior period is still open. Advisory — a warning never
 * blocks the close (the lock is the hard mechanism, and the ledger kernel already
 * guarantees every journal balances) — so the value of recording it is that the
 * sign-off names what was outstanding when it was given. JSON for
 * `idempotency_keys.response_body`'s reason: a shape the report owns, not one the
 * schema should pin. NULL for a reopen, which carries a `note` (the reason) and no
 * checklist.
 *
 * ## `statement_packages` — the rendered artifact (D-98's sibling, P5)
 *
 * The record that a branded P&L/BS/cash-flow bundle was rendered for a date range,
 * and where the PDF is stored — `invoice_deliveries`' argument applied to an
 * accountant deliverable (D-42): a re-render is a new row, and the artifact it
 * names was frozen at render time. Append-only for the same reason. The bytes live
 * behind the `StorageProvider` (the INV foundation), reached by `artifact_storage_key`
 * the way a delivery reaches its frozen invoice.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE period_close_events (
      id            BINARY(16)    NOT NULL,
      org_id        BINARY(16)    NOT NULL,
      period_id     BINARY(16)    NOT NULL,
      action        ENUM('close','reopen') NOT NULL,
      -- The advisory checklist recomputed at close time (D-97), a JSON array of
      -- { key, status, count } — the report owns the shape. NULL for a reopen.
      checklist     JSON          NULL,
      -- The sign-off note on a close, or the reason on a reopen. Optional: the
      -- who-and-when is the audit, the note is the human context.
      note          VARCHAR(1000) NULL,
      -- Nullable, mirroring fiscal_periods.closed_by_user_id (0002_ledger): a close
      -- is normally a human sign-off (D-97), but an automation or an API-key actor
      -- that holds periods.close may still transition a period, and that must record
      -- a null closer rather than fail — the same reason the period's own closer
      -- column is nullable. ON DELETE SET NULL for the same reason it uses it.
      actor_user_id BINARY(16)    NULL,
      created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_period_close_events_org_id (org_id, id),
      -- The read is "this period's close history, newest first" and "this org's
      -- recent sign-offs" — both served by (org_id, period_id, created_at).
      KEY idx_pce_org_period (org_id, period_id, created_at),
      KEY idx_pce_org_created (org_id, created_at),
      CONSTRAINT fk_pce_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      -- The two-column composite the tenancy pattern uses everywhere: the event's
      -- org and the period's org are the same fact, not two a bad write could split.
      CONSTRAINT fk_pce_period
        FOREIGN KEY (org_id, period_id) REFERENCES fiscal_periods (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_pce_actor
        FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE statement_packages (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      -- A date range rather than a period id, so a package can cover a quarter or a
      -- year, not only one fiscal period. The three statements are run over [start,end].
      period_start         DATE         NOT NULL,
      period_end           DATE         NOT NULL,
      basis                ENUM('accrual','cash') NOT NULL,
      -- The StorageProvider key of the frozen PDF (the INV foundation), reached the
      -- way invoice_deliveries.artifact_storage_key reaches a sent invoice's artifact.
      artifact_storage_key VARCHAR(512) NOT NULL,
      generated_by_user_id BINARY(16)   NOT NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_statement_packages_org_id (org_id, id),
      KEY idx_sp_org_created (org_id, created_at),
      CONSTRAINT fk_sp_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_sp_author
        FOREIGN KEY (generated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_statement_packages_range CHECK (period_end >= period_start)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS statement_packages`.execute(db);
  await sql`DROP TABLE IF EXISTS period_close_events`.execute(db);
}
