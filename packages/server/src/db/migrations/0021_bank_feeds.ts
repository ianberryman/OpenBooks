import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Live bank feeds (OB-227, ROADMAP D-126…D-131): an org connects its own Stripe
 * Financial Connections credential and a daily job pulls transactions into the
 * existing `bank_statement_lines` → match → reconcile pipeline.
 *
 * Its own file for `0011_payment_processing`'s reason — a new subsystem gets one,
 * and the next free prefix after `0020_contact_address` is `0021`.
 *
 * ## One table, and it mirrors `processor_connections` without overloading it
 *
 * A live feed is PAY rebuilt for a *data* surface: it reuses the per-org AES-GCM
 * `secrets` store (0011), the `runAsAutomation` daily tick (0008), and the whole
 * banking ingest. So this migration adds exactly one table. `bank_feed_connections`
 * deliberately does **not** reuse `processor_connections`: Stripe Financial
 * Connections is a distinct Stripe product from PAY's charge/payout use (D-126),
 * the two carry different credentials and lifecycles, and sharing a row would make
 * one connection answer to two subsystems. It is a tenant table and mutable —
 * added to `TENANT_TABLES` (`tenant-tables.ts`) and to `MUTABLE_TABLES`
 * (`0999_app_grants`).
 *
 * ## A connection stores a name, never a key
 *
 * `secret_ref` names a row in `secrets` (0011), not the restricted key itself
 * (D-101) — the connect service calls `SecretsProvider.put` once and persists only
 * the handle, exactly as `processor_connections.secret_ref` does. v1 is
 * bring-your-own only (D-131): the org supplies its own Stripe restricted key,
 * Stripe bills the org directly, and `credential_source` carries `'bring_your_own'`.
 * The `'managed'` member exists so the deferred managed model (OpenBooks' own
 * platform key, re-metered to the org) drops in later without a schema change; v1
 * writes only `'bring_your_own'`.
 *
 * ## Idempotency is the fingerprint, and the cursor is its own column
 *
 * There is no event log here and no `external_refs` linkage (D-127): the provider's
 * stable transaction id rides into `bank_statement_lines.bank_reference`, so
 * `computeFingerprint` + `uq_bank_statement_lines_fingerprint` collapse a re-synced
 * overlap on `INSERT IGNORE` — the same exactly-once the CSV path already has. What
 * a feed *does* need that a file does not is a pull cursor, and it is `sync_cursor`
 * here rather than a reused timestamp (D-128, learning from PAY's poll): it is
 * advanced only when a sync commits, so a mid-sync failure re-pulls rather than skips.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // bank_feed_connections — an org's own live feed for one bank account (D-126).
  //
  // `bank_account_id` nominates an existing `bank_accounts` row (itself a ledger
  // account plus import metadata, D-46), and `uq_bank_feed_connections_account`
  // makes it one live feed per bank account: two feeds racing to pull the same
  // account would give one account two cursors and two answers to "what has
  // arrived". Connecting flips `bank_accounts.feed_source` to this connection's
  // `feed_source`; disconnecting (a soft `is_active = 0`) flips it back to 'file'.
  //
  // `secret_ref` names a row in `secrets`, never the key value — see the header.
  // `sync_cursor` is the pull cursor (D-128); `last_synced_at`/`last_sync_error` are
  // the advisory sync-health surface the management screen reads.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bank_feed_connections (
      id                  BINARY(16)   NOT NULL,
      org_id              BINARY(16)   NOT NULL,
      bank_account_id     BINARY(16)   NOT NULL,
      feed_source         ENUM('stripe_financial_connections','fake') NOT NULL,
      credential_source   ENUM('bring_your_own','managed') NOT NULL DEFAULT 'bring_your_own',
      secret_ref          VARCHAR(255) NOT NULL,
      external_account_id VARCHAR(255) NOT NULL,
      institution         VARCHAR(255) NULL,
      -- sync_cursor, not cursor: the latter is a MySQL reserved word (the reason
      -- bank_match_proposals.rank is backquoted in 0006). The name says what it is.
      sync_cursor         VARCHAR(255) NULL,
      last_synced_at      DATETIME(3)  NULL,
      last_sync_error     VARCHAR(512) NULL,
      is_active           TINYINT(1)   NOT NULL DEFAULT 1,
      created_by_user_id  BINARY(16)   NOT NULL,
      created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bank_feed_connections_org_id (org_id, id),
      -- One live feed per bank account (see the header above).
      UNIQUE KEY uq_bank_feed_connections_account (org_id, bank_account_id),
      -- The list read and the cross-org sweep: an org's feeds by lifecycle state.
      KEY idx_bank_feed_connections_org_active (org_id, is_active),
      CONSTRAINT fk_bank_feed_connections_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bank_feed_connections_account
        FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_bank_feed_connections_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS bank_feed_connections`.execute(db);
}
