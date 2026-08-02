import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Automatic Stripe payout sync → summary-sales journals (OB-237). For an org whose
 * sales and invoicing live entirely in Stripe (OpenBooks is the GL, not the AR
 * system), each weekly payout becomes **one grossed-up summary journal** — Dr
 * Clearing / Dr Fees … Cr Revenue / Cr Sales Tax Payable — not the net deposit
 * booked as revenue (the commonest Stripe bookkeeping error, which understates
 * sales and hides the fee). See ROADMAP OB-237 for the settled forks (D-237-1…7);
 * the three per-connection columns this feature needs (`sync_mode`, `auto_post`,
 * `event_cursor`) are added in place on `processor_connections` in
 * `0011_payment_processing` (D-15). This file holds the two tables that are new.
 *
 * The next free prefix after `0022_account_statements`/`0023_ten99` is `0024`.
 * Payout sync folds into the `payments-processing` module, but a new feature gets
 * its own migration file (`0009_bill_capture`'s reason) rather than swelling
 * `0011`.
 *
 * ## `payout_account_map` (mutable) — reporting_category → GL account (D-237-6)
 *
 * The per-connection mapping the summary-journal builder resolves each Stripe
 * `reporting_category` through, the `bank_rules.set_account_id` shape (a condition
 * key → a nominated GL account, D-23 "nominate, don't invent"). `charge` maps to a
 * revenue account, `refund` to a contra-revenue account, `tax` to Sales Tax
 * Payable (only when the org uses Stripe Tax — otherwise there is no `tax`
 * category and tax rides `charge` gross, D-237-6), `dispute` to a loss account,
 * `adjustment` to a catch-all. `fee` maps to a fee account; the clearing plug is
 * always the connection's own `clearing_account_id`, never the map. `status`/
 * closed sets are `VARCHAR + CHECK`, the `customer_statements.status` precedent —
 * no `generated.ts` literal-union ripple.
 *
 * ## `payout_syncs` (mutable) — the review-first staging surface (D-237-2)
 *
 * A machine-written staging row a human reviews, then posts — modelled on OCR's
 * `document_captures`, **not** `journal_drafts` (which refuses a non-user author
 * and carries no origin column, so an automation-run sync cannot draft). `status`
 * legitimately moves (`pending_review→posted|skipped`), so it is mutable, like a
 * reconciliation session. `journal_id` is set once the summary journal is posted
 * (append-only; the sync row remembers which one). `external_payout_id` is the
 * object-idempotency key — a webhook and the poll reporting the same payout must
 * collapse to one row (the `processor_events` two-level idempotency argument,
 * one level up). `breakdown` is the per-category cents-string aggregation the
 * builder consumed — money is a cents string inside JSON (D-13, the F7 site).
 *
 * Both tables are tenant tables (`tenant-tables.ts`) and both are `MUTABLE_TABLES`
 * in `0999_app_grants`.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE payout_account_map (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      connection_id      BINARY(16)   NOT NULL,
      reporting_category VARCHAR(16)  NOT NULL,
      account_id         BINARY(16)   NOT NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_payout_account_map_org_id (org_id, id),
      -- One account per (connection, category): the resolve is a point lookup.
      UNIQUE KEY uq_payout_account_map_category (org_id, connection_id, reporting_category),
      KEY idx_payout_account_map_account (org_id, account_id),
      CONSTRAINT fk_payout_account_map_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_payout_account_map_connection
        FOREIGN KEY (org_id, connection_id) REFERENCES processor_connections (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_payout_account_map_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_payout_account_map_user
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_payout_account_map_category
        CHECK (reporting_category IN ('charge', 'refund', 'fee', 'tax', 'dispute', 'adjustment'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE payout_syncs (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      connection_id      BINARY(16)   NOT NULL,
      external_payout_id VARCHAR(255) NOT NULL,
      -- Cents (D-13). gross = sum of charge + tax; net = the clearing plug.
      gross_minor        BIGINT       NOT NULL,
      fee_minor          BIGINT       NOT NULL,
      net_minor          BIGINT       NOT NULL,
      currency           CHAR(3)      NOT NULL,
      status             VARCHAR(16)  NOT NULL DEFAULT 'pending_review',
      -- The per-category aggregation the builder consumed; money is a cents string
      -- inside the JSON (D-13, F7 — never JSON.stringify a bigint to a number).
      -- Empty ([]) for a skipped sync (e.g. an unsupported manual payout).
      breakdown          JSON         NOT NULL,
      -- Set once the summary journal is posted (append-only; the sync remembers it).
      journal_id         BINARY(16)   NULL,
      -- Why a sync was skipped rather than posted (unmapped category, non-usd, a
      -- breakdown fetch that failed, or a manual payout — which has no per-payout
      -- breakdown in any Stripe API; OB-237b correction / D-237-11, the
      -- visible-failure line). Full manual-payout support is OB-237c.
      skip_reason        VARCHAR(255) NULL,
      occurred_at        DATETIME(3)  NOT NULL,
      posted_by_user_id  BINARY(16)   NULL,
      posted_at          DATETIME(3)  NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_payout_syncs_org_id (org_id, id),
      -- Object-level idempotency: a webhook + the poll reporting one payout collapse here.
      UNIQUE KEY uq_payout_syncs_external (org_id, connection_id, external_payout_id),
      -- The review list: a connection's syncs by status, newest first.
      KEY idx_payout_syncs_conn_status (org_id, connection_id, status, occurred_at),
      CONSTRAINT fk_payout_syncs_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_payout_syncs_connection
        FOREIGN KEY (org_id, connection_id) REFERENCES processor_connections (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_payout_syncs_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_payout_syncs_posted_by
        FOREIGN KEY (posted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_payout_syncs_status
        CHECK (status IN ('pending_review', 'posted', 'skipped'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS payout_syncs`.execute(db);
  await sql`DROP TABLE IF EXISTS payout_account_map`.execute(db);
}
