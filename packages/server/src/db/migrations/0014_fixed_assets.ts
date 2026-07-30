import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Fixed assets and recurring journals (initiative L, OB-162…169; ROADMAP D-113…D-117).
 *
 * Two standing-instruction subsystems that ride the one scheduler (OB-127), the way
 * recurring invoices (`0008`) do:
 *
 *   - `recurring_journal_templates` (+`_lines`) — a fixed-line GL journal raised each
 *     period: prepaid amortisation, an accrual, deferred-revenue recognition (D-90).
 *     A template stores its lines as `{ side, amount_minor }` and the service asserts
 *     debits equal credits before it can activate — the balance is checked once, up
 *     front, because a template that could never post is a template that should never
 *     have saved.
 *   - `fixed_assets` (+`fixed_asset_schedule`) — an asset, and the depreciation
 *     schedule its registration computes. Depreciation is **not** a recurring template
 *     (D-113): declining-balance amounts vary period to period, so a fixed-line
 *     template cannot express them. The schedule is materialised once, one row per
 *     period, and a depreciation sweep posts the earliest unposted row whose date has
 *     arrived — `posted_journal_id IS NULL` under a row lock is the once-per-period
 *     guard, the `dunning_sends` idempotency argument moved onto a mutable row.
 *
 * ## Everything here is a plan, not a ledger fact
 *
 * A template, an asset, and a schedule row are all settings — edited, and in the
 * schedule's case stamped with the journal that discharged it. The immutable record
 * of every depreciation and every recurring entry is the `journals` each one posts
 * through the ordinary `postJournal` path (`source` `'depreciation'`, `'disposal'`,
 * `'recurring'` — a free VARCHAR, no ALTER). So all four tables are **mutable**
 * (`0999_app_grants`'s `MUTABLE_TABLES`) and none is append-only, exactly as the Pay
 * Bills queue is: no financial fact lives outside the ledger to protect.
 *
 * ## Accumulated depreciation is an ordinary account, not a flagged contra
 *
 * An asset names three accounts — where its cost sits, where accumulated depreciation
 * accrues, and where the period expense lands — defaulted from the org's new
 * `org_accounting_settings` nominations (`0005`, edited in place, D-115). Accumulated
 * depreciation is a plain `type:'asset'` account carrying a credit balance; `0002_ledger`
 * deliberately declines to constrain `normal_balance` against `type`, and the balance
 * sheet flips a section off `type` rather than `normal_balance`, so a credit-balance
 * asset renders as the contra it is with no contra flag to add (D-115).
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // recurring_journal_templates — a schedule and how to raise the journal (OB-162).
  //
  // `next_run_date`/`last_run_date`/`end_date` are `recurring_invoice_templates`'
  // exact scheduler contract (0008): the sweep materialises every active template
  // whose `next_run_date` has arrived and advances it, and `last_run_date` is the
  // once-per-cycle guard that makes a restart mid-tick safe. `materialization_mode`
  // is the {draft, posted} of D-76: `posted` posts the journal directly under the
  // automation actor, `draft` lands a `journal_drafts` row (M2) for a human to post.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE recurring_journal_templates (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      name                 VARCHAR(255) NOT NULL,
      memo                 VARCHAR(512) NULL,
      materialization_mode ENUM('draft','posted') NOT NULL,
      frequency            ENUM('weekly','monthly','quarterly','yearly') NOT NULL,
      interval_count       INT UNSIGNED NOT NULL DEFAULT 1,
      next_run_date        DATE         NOT NULL,
      last_run_date        DATE         NULL,
      end_date             DATE         NULL,
      is_active            TINYINT(1)   NOT NULL DEFAULT 1,
      created_by_user_id   BINARY(16)   NOT NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_recurring_journal_templates_org_id (org_id, id),
      -- The scheduler's read: active templates that are due, org by org.
      KEY idx_recurring_journal_templates_due (org_id, is_active, next_run_date),
      CONSTRAINT fk_recurring_journal_templates_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_recurring_journal_templates_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_recurring_journal_templates_interval CHECK (interval_count >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // recurring_journal_template_lines — the fixed lines a cycle posts verbatim.
  //
  // Unlike `recurring_invoice_template_lines`, which stores pricing inputs a cycle
  // reprices, a GL line is already a posting instruction: `{ account_id, side,
  // amount_minor }` is what `postJournal`'s `JournalLineInput` takes, so it is stored
  // as-is and posted as-is. `contact_id` is the counterparty a line may name (a
  // `journal_lines` column, so naming it is part of posting — OB-059); dimensions are
  // deliberately out of the template (D-90's fixed-line scope). The service asserts
  // Σdebits = Σcredits across a template's lines before it may activate; a per-line
  // CHECK cannot express a cross-row balance, so only the per-line positivity is here.
  // `BIGINT AUTO_INCREMENT` id + `(org_id, id)` mirror `ar_document_lines`.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE recurring_journal_template_lines (
      id           BIGINT            NOT NULL AUTO_INCREMENT,
      org_id       BINARY(16)        NOT NULL,
      template_id  BINARY(16)        NOT NULL,
      line_number  SMALLINT UNSIGNED NOT NULL,
      account_id   BINARY(16)        NOT NULL,
      side         ENUM('debit','credit') NOT NULL,
      amount_minor BIGINT            NOT NULL,
      contact_id   BINARY(16)        NULL,
      description  VARCHAR(512)      NULL,
      created_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_recurring_journal_template_lines_org_id (org_id, id),
      UNIQUE KEY uq_recurring_journal_template_lines_line (org_id, template_id, line_number),
      KEY idx_recurring_journal_template_lines_org_template (org_id, template_id),
      KEY idx_recurring_journal_template_lines_org_account (org_id, account_id),
      KEY idx_recurring_journal_template_lines_org_contact (org_id, contact_id),
      CONSTRAINT fk_recurring_journal_template_lines_template
        FOREIGN KEY (org_id, template_id) REFERENCES recurring_journal_templates (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_recurring_journal_template_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_recurring_journal_template_lines_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_recurring_journal_template_lines_amount CHECK (amount_minor > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // fixed_assets — the register (OB-163). Cost, method, life, in-service date, and
  // the three accounts its depreciation posts through (D-115).
  //
  // `declining_rate_ppm` is parts-per-million (the `tax_rates.rate_ppm` convention),
  // required for `declining_balance` and forbidden for `straight_line` — a rate on a
  // method that ignores it, or a missing rate on a method that needs it, is a
  // registration that cannot compute a schedule, refused here rather than at compute.
  // `salvage_value_minor <= acquisition_cost_minor` keeps the depreciable base
  // non-negative (Σschedule = cost − salvage, L6). No money DEFAULT, for the reason
  // every `*_minor` column in this schema refuses one. `disposal_journal_id` names the
  // journal disposal posted (D-116); it stays NULL for a live asset.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE fixed_assets (
      id                                  BINARY(16)   NOT NULL,
      org_id                              BINARY(16)   NOT NULL,
      name                                VARCHAR(255) NOT NULL,
      description                         VARCHAR(512) NULL,
      asset_account_id                    BINARY(16)   NOT NULL,
      accumulated_depreciation_account_id BINARY(16)   NOT NULL,
      depreciation_expense_account_id     BINARY(16)   NOT NULL,
      acquisition_cost_minor              BIGINT       NOT NULL,
      salvage_value_minor                 BIGINT       NOT NULL,
      method                              ENUM('straight_line','declining_balance') NOT NULL,
      useful_life_months                  INT UNSIGNED NOT NULL,
      declining_rate_ppm                  INT UNSIGNED NULL,
      in_service_date                     DATE         NOT NULL,
      status                              ENUM('active','disposed') NOT NULL DEFAULT 'active',
      disposed_date                       DATE         NULL,
      disposal_journal_id                 BINARY(16)   NULL,
      created_by_user_id                  BINARY(16)   NOT NULL,
      created_at                          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at                          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                                       ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_fixed_assets_org_id (org_id, id),
      KEY idx_fixed_assets_org_status (org_id, status),
      KEY idx_fixed_assets_org_asset_account (org_id, asset_account_id),
      KEY idx_fixed_assets_org_accum_account (org_id, accumulated_depreciation_account_id),
      KEY idx_fixed_assets_org_expense_account (org_id, depreciation_expense_account_id),
      KEY idx_fixed_assets_org_disposal_journal (org_id, disposal_journal_id),
      CONSTRAINT fk_fixed_assets_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_fixed_assets_asset_account
        FOREIGN KEY (org_id, asset_account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_fixed_assets_accum_account
        FOREIGN KEY (org_id, accumulated_depreciation_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_fixed_assets_expense_account
        FOREIGN KEY (org_id, depreciation_expense_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_fixed_assets_disposal_journal
        FOREIGN KEY (org_id, disposal_journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_fixed_assets_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_fixed_assets_life CHECK (useful_life_months >= 1),
      CONSTRAINT chk_fixed_assets_salvage CHECK (salvage_value_minor >= 0),
      CONSTRAINT chk_fixed_assets_salvage_le_cost
        CHECK (salvage_value_minor <= acquisition_cost_minor),
      CONSTRAINT chk_fixed_assets_declining_rate CHECK (
        (method = 'declining_balance' AND declining_rate_ppm IS NOT NULL AND declining_rate_ppm > 0)
        OR (method = 'straight_line' AND declining_rate_ppm IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // fixed_asset_schedule — the computed schedule, one row per period (OB-164).
  //
  // Materialised whole at registration (D-113) and never re-priced once posting has
  // begun (the no-mid-life-re-forecast edge). `posted_journal_id` NULL means the
  // period is unposted; the depreciation sweep takes the earliest such row whose
  // `period_date` has arrived under `FOR UPDATE`, posts it, and stamps the journal id
  // here — the once-per-period idempotency key (L3), `dunning_sends`' unique-guard
  // argument on a mutable row. The `(org_id, posted_journal_id, period_date)` index is
  // exactly that due query. Disposal voids the remaining unposted rows (D-116).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE fixed_asset_schedule (
      id                        BINARY(16)   NOT NULL,
      org_id                    BINARY(16)   NOT NULL,
      fixed_asset_id            BINARY(16)   NOT NULL,
      period_index              INT UNSIGNED NOT NULL,
      period_date               DATE         NOT NULL,
      depreciation_amount_minor BIGINT       NOT NULL,
      posted_journal_id         BINARY(16)   NULL,
      created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                             ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_fixed_asset_schedule_org_id (org_id, id),
      UNIQUE KEY uq_fixed_asset_schedule_period (org_id, fixed_asset_id, period_index),
      -- The sweep's due read: unposted rows (posted_journal_id NULL) by date.
      KEY idx_fixed_asset_schedule_due (org_id, posted_journal_id, period_date),
      KEY idx_fixed_asset_schedule_org_asset (org_id, fixed_asset_id),
      CONSTRAINT fk_fixed_asset_schedule_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_fixed_asset_schedule_asset
        FOREIGN KEY (org_id, fixed_asset_id) REFERENCES fixed_assets (org_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_fixed_asset_schedule_posted_journal
        FOREIGN KEY (org_id, posted_journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_fixed_asset_schedule_amount CHECK (depreciation_amount_minor >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Children before parents so no composite foreign key blocks a drop.
  await sql`DROP TABLE IF EXISTS fixed_asset_schedule`.execute(db);
  await sql`DROP TABLE IF EXISTS fixed_assets`.execute(db);
  await sql`DROP TABLE IF EXISTS recurring_journal_template_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS recurring_journal_templates`.execute(db);
}
