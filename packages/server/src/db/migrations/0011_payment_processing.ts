import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Payment-processor integration (initiative J, OB-143…153): connecting an org's
 * own Stripe or Square, and the webhook/poll event log that keeps a replayed
 * or reordered delivery from becoming two payments.
 *
 * Its own file for `0009_bill_capture`'s reason: a new subsystem gets one, and
 * the next free prefix after `0010_platform` is `0011`.
 *
 * ## Three tables, one of them not tenant-scoped
 *
 * `secrets` is infrastructure, not tenant data — see its own header below — and
 * is deliberately absent from `TENANT_TABLES`. `processor_connections` and
 * `processor_events` are ordinary tenant tables, added to that list and to
 * `MUTABLE_TABLES` in `0999_app_grants` (all three; see that file's own
 * comment for why a secret store is mutable rather than append-only).
 *
 * ## A processor connection never stores a key, only a name
 *
 * `secret_ref` and `webhook_secret_ref` on `processor_connections` are rows'
 * names in `secrets`, not the values themselves (D-101). The service that
 * connects a processor calls `SecretsProvider.put` once per credential and
 * persists only the name it stored each under — the same separation
 * `invoice_deliveries.token_hash` keeps between a credential and the row that
 * names it, one level further from the value: this is not even a hash, since
 * the plaintext must be recoverable to call Stripe or Square, only a lookup
 * key into an encrypted store.
 *
 * ## Two-level idempotency (D-85, F9)
 *
 * `processor_events` is the append point for both idempotency guarantees a
 * processor integration needs. `uq_processor_events_external` on
 * `(org_id, processor, external_event_id)` is event-level: a webhook redelivers
 * at least once, and a replay must collapse to the row already on file rather
 * than a second write. `idx_processor_events_org_object` on
 * `(org_id, external_object_id)` is object-level correlation: a poll and a
 * webhook can both report the *same* charge or payout as two different
 * deliveries, and this is what lets the posting service recognise it already
 * has one. The `external_refs` table (`0010_platform`) is the third layer —
 * the correlation from a processor object id to the OpenBooks payment it
 * produced — and is unaffected by this migration.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // secrets — the encrypted-at-rest store the D-101 write seam
  // (`SecretsProvider.put`) targets.
  //
  // Deliberately no `org_id`: this is infra, keyed by an opaque handle exactly
  // as an external secrets manager namespaces by prefix rather than by a
  // first-class tenant column — the org (and the connection) are folded into
  // `name` by the caller, not by this table. It is reached through the
  // sanctioned raw handle in `src/db/secrets-store.ts`, never through
  // `tenantDb`, for the same reason `delivery-lookup.ts` cannot go through it:
  // there is nothing here to scope by.
  //
  // `ciphertext` holds `iv (12 bytes) || authTag (16 bytes) || ciphertext`
  // (AES-256-GCM; see `providers/secrets/local.ts`) — the row alone is not the
  // key, the app's `SECRETS_ENCRYPTION_KEY` is, and that key lives only in
  // config, never in a domain table (D-101, D-83).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE secrets (
      name       VARCHAR(255)    NOT NULL,
      ciphertext VARBINARY(4096) NOT NULL,
      created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // processor_connections — an org's own Stripe or Square (D-82, D-103).
  //
  // `clearing_account_id` and `fee_account_id` nominate two existing ledger
  // accounts (D-23, D-46's "a bank account is a ledger account plus import
  // metadata" applied to a processor): a charge clears AR into the clearing
  // account immediately, and the per-charge fee posts to the fee account
  // (D-84/D-104) — never accounts this migration invents, for
  // `org_accounting_settings`'s reason (`0005_subledger`).
  //
  // `uq_processor_connections_org_processor` is one connection per processor
  // per org — connecting Stripe twice would mean two clearing accounts racing
  // to explain one processor's payouts, which is not a configuration v1 needs
  // to support.
  //
  // `secret_ref`/`webhook_secret_ref` name rows in `secrets` above, never the
  // key value — see this file's own header.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE processor_connections (
      id                  BINARY(16)   NOT NULL,
      org_id              BINARY(16)   NOT NULL,
      processor           ENUM('stripe','square','fake') NOT NULL,
      clearing_account_id BINARY(16)   NOT NULL,
      fee_account_id      BINARY(16)   NOT NULL,
      publishable_key     VARCHAR(255) NULL,
      secret_ref          VARCHAR(255) NOT NULL,
      webhook_secret_ref  VARCHAR(255) NOT NULL,
      external_account_id VARCHAR(120) NULL,
      last_polled_at      DATETIME(3)  NULL,
      reconciled_through  DATETIME(3)  NULL,
      is_active           TINYINT(1)   NOT NULL DEFAULT 1,
      created_by_user_id  BINARY(16)   NOT NULL,
      created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_processor_connections_org_id (org_id, id),
      -- One connection per processor per org (see the header above).
      UNIQUE KEY uq_processor_connections_org_processor (org_id, processor),
      -- The list read: an org's connections by lifecycle state.
      KEY idx_processor_connections_org_active (org_id, is_active),
      -- Declared rather than left to InnoDB's automatic index, for
      -- org_accounting_settings's reason: the covering index for a composite
      -- foreign key is visible where the constraint is.
      KEY idx_processor_connections_clearing (org_id, clearing_account_id),
      KEY idx_processor_connections_fee (org_id, fee_account_id),
      CONSTRAINT fk_processor_connections_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_processor_connections_clearing
        FOREIGN KEY (org_id, clearing_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_processor_connections_fee
        FOREIGN KEY (org_id, fee_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_processor_connections_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // processor_events — the webhook/poll event log and its two-level
  // idempotency (D-85, F9) — see this file's own header for the full argument.
  //
  // `payload` is the normalised event as `NormalizedProcessorEvent` JSON;
  // every money field inside it is a cents string (D-13, F7's own site), never
  // a JSON number. `status` is the processing lifecycle: `received` on
  // insert, `processed` once the posting service has recorded a payment (or
  // fee, refund, dispute, payout) from it, `ignored` for an event kind this
  // connection has nothing to do with, `failed` with `processing_error` set
  // otherwise.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE processor_events (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      connection_id      BINARY(16)   NOT NULL,
      processor          ENUM('stripe','square','fake') NOT NULL,
      external_event_id  VARCHAR(255) NOT NULL,
      external_object_id VARCHAR(255) NOT NULL,
      event_type         ENUM('charge','fee','refund','dispute','payout') NOT NULL,
      status             ENUM('received','processed','ignored','failed') NOT NULL,
      payload            JSON         NOT NULL,
      processing_error   VARCHAR(512) NULL,
      received_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      processed_at       DATETIME(3)  NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_processor_events_org_id (org_id, id),
      -- Event-level idempotency (F9): a webhook redelivery collapses to this row.
      UNIQUE KEY uq_processor_events_external (org_id, processor, external_event_id),
      -- Object-level correlation: a poll and a webhook reporting the same charge
      -- or payout as two different deliveries are recognisable as one object.
      KEY idx_processor_events_org_object (org_id, external_object_id),
      -- The queue read: a connection's events by processing state.
      KEY idx_processor_events_conn_status (org_id, connection_id, status),
      CONSTRAINT fk_processor_events_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_processor_events_connection
        FOREIGN KEY (org_id, connection_id) REFERENCES processor_connections (org_id, id)
        ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order, children before parents so the composite foreign
  // keys drop cleanly.
  await sql`DROP TABLE IF EXISTS processor_events`.execute(db);
  await sql`DROP TABLE IF EXISTS processor_connections`.execute(db);
  await sql`DROP TABLE IF EXISTS secrets`.execute(db);
}
