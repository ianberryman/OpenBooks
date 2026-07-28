import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Recurring invoices and dunning, Phase 4 (OB-122): the standing instructions that let
 * the scheduler (OB-127) raise invoices and chase overdue ones without a human each time.
 *
 * Its own file for the reason every subsystem since `0005_subledger` has one; `0999_app_grants`
 * still sorts last. Five tables across the mutable/append-only split (D-15's grants):
 *
 *   - `recurring_invoice_templates` + `recurring_invoice_template_lines` — a template invoice
 *     and its schedule. **Mutable**: a template is a setting, edited freely; changing it
 *     changes the *next* cycle and reaches no invoice already raised.
 *   - `dunning_policies` + `dunning_stages` — an ordered ladder of reminders. **Mutable**, the
 *     same reasoning.
 *   - `dunning_sends` — the record that one stage was sent for one invoice. **Append-only**
 *     (`invoice_deliveries`' argument, 0007): it is both evidence a reminder went out and the
 *     once-per-stage guard (D-77), and a guard the application can rewrite guards nothing.
 *
 * ## The template stores inputs, not a rendered invoice
 *
 * `recurring_invoice_template_lines` mirrors `ar_document_lines` (0005) in its input columns —
 * `quantity_micros`, `unit_amount_minor`, `account_id`, `tax_rate_id` — and deliberately omits
 * the computed ones (`line_amount_minor`, `tax_amount_minor`). A template is not a posted
 * document: each cycle it is fed through `createInvoice`, which reprices and posts (D-35's
 * per-line rounding happens then, once, in the one place it lives). Storing the computed
 * amounts here would be a second pricing that the first edit of a tax rate would falsify.
 *
 * ## Money and quantity keep their ledger representations
 *
 * `unit_amount_minor` is minor units as a `BIGINT` and `quantity_micros` is a count scaled by
 * 1,000,000, exactly as `ar_document_lines` carries them (0005's header on why a quantity is
 * not a money type). A template that stored a decimal string would reintroduce the float the
 * whole schema exists to keep out.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // recurring_invoice_templates — a customer, a schedule, and how to raise the invoice.
  //
  // `next_run_date` is the scheduler's whole query: each day it materialises every active
  // template whose `next_run_date` has arrived, then advances it. `last_run_date` is the
  // once-per-cycle guard (D-76) — a template already run for a date is not run again, so a
  // restart mid-tick cannot double-raise. `end_date` NULL is open-ended.
  //
  // `materialization_mode` is the {draft, approved} choice (H7): `approved` posts the journal
  // and takes the number through the same `approveInvoice` path a human uses, unattended;
  // `draft` lands an editable draft. `tax_mode` is the {inclusive, exclusive} of D-35, carried
  // so a cycle reprices its lines the way the template's author meant. `due_days` is the net
  // term — there is no payment-terms model yet, so the template names the offset itself and the
  // cycle sets `due_date = issue_date + due_days`.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE recurring_invoice_templates (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      contact_id           BINARY(16)   NOT NULL,
      name                 VARCHAR(255) NOT NULL,
      materialization_mode VARCHAR(16)  NOT NULL,
      tax_mode             VARCHAR(16)  NOT NULL,
      frequency            VARCHAR(16)  NOT NULL,
      interval_count       INT UNSIGNED NOT NULL DEFAULT 1,
      due_days             INT UNSIGNED NOT NULL DEFAULT 0,
      memo                 VARCHAR(512) NULL,
      next_run_date        DATE         NOT NULL,
      last_run_date        DATE         NULL,
      end_date             DATE         NULL,
      is_active            TINYINT(1)   NOT NULL DEFAULT 1,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_recurring_templates_org_id (org_id, id),
      -- The scheduler's read: active templates that are due, org by org.
      KEY idx_recurring_templates_due (org_id, is_active, next_run_date),
      KEY idx_recurring_templates_org_contact (org_id, contact_id),
      CONSTRAINT fk_recurring_templates_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_recurring_templates_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_recurring_templates_mode
        CHECK (materialization_mode IN ('draft', 'approved')),
      CONSTRAINT chk_recurring_templates_tax_mode
        CHECK (tax_mode IN ('inclusive', 'exclusive')),
      CONSTRAINT chk_recurring_templates_frequency
        CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
      CONSTRAINT chk_recurring_templates_interval CHECK (interval_count >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // recurring_invoice_template_lines — the line template, mirroring ar_document_lines' inputs.
  //
  // `BIGINT AUTO_INCREMENT` id and the `(org_id, id)` unique key follow ar_document_lines
  // exactly. Only the inputs are stored (see the header); the cycle computes the rest.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE recurring_invoice_template_lines (
      id                BIGINT            NOT NULL AUTO_INCREMENT,
      org_id            BINARY(16)        NOT NULL,
      template_id       BINARY(16)        NOT NULL,
      line_number       SMALLINT UNSIGNED NOT NULL,
      description       VARCHAR(512)      NULL,
      quantity_micros   BIGINT            NOT NULL,
      unit_amount_minor BIGINT            NOT NULL,
      account_id        BINARY(16)        NOT NULL,
      tax_rate_id       BINARY(16)        NULL,
      created_at        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_recurring_template_lines_org_id (org_id, id),
      UNIQUE KEY uq_recurring_template_lines_line (org_id, template_id, line_number),
      KEY idx_recurring_template_lines_org_template (org_id, template_id),
      KEY idx_recurring_template_lines_org_account (org_id, account_id),
      KEY idx_recurring_template_lines_org_tax_rate (org_id, tax_rate_id),
      CONSTRAINT fk_recurring_template_lines_template
        FOREIGN KEY (org_id, template_id) REFERENCES recurring_invoice_templates (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_recurring_template_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_recurring_template_lines_tax_rate
        FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_recurring_template_lines_quantity CHECK (quantity_micros > 0),
      CONSTRAINT chk_recurring_template_lines_unit CHECK (unit_amount_minor >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // dunning_policies — a named ladder of reminders. Mutable, one row per named policy.
  //
  // A policy is org-level in v1: the dunning engine walks active policies and applies their
  // stages to overdue invoices. `is_active` retires a policy without deleting the history its
  // `dunning_sends` reference (which RESTRICT would forbid anyway).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE dunning_policies (
      id         BINARY(16)   NOT NULL,
      org_id     BINARY(16)   NOT NULL,
      name       VARCHAR(255) NOT NULL,
      is_active  TINYINT(1)   NOT NULL DEFAULT 1,
      created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                              ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_dunning_policies_org_id (org_id, id),
      KEY idx_dunning_policies_org_active (org_id, is_active),
      CONSTRAINT fk_dunning_policies_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // dunning_stages — the ordered rungs of a policy (OB-122's "ordered offset + template +
  // optional late fee").
  //
  // `offset_days` is relative to the invoice's due date: negative is a courtesy reminder
  // before the date, zero is on it, positive is a chase after. `stage_number` orders the
  // ladder and is the stage identity `dunning_sends` guards against. `late_fee_minor` is the
  // optional punitive twin of the settlement discount (D-77) — when set, reaching this stage
  // posts a fee; NULL is the ordinary case of a reminder that costs nothing.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE dunning_stages (
      id             BINARY(16)        NOT NULL,
      org_id         BINARY(16)        NOT NULL,
      policy_id      BINARY(16)        NOT NULL,
      stage_number   SMALLINT UNSIGNED NOT NULL,
      offset_days    INT               NOT NULL,
      subject        VARCHAR(255)      NOT NULL,
      body           TEXT              NOT NULL,
      late_fee_minor BIGINT            NULL,
      created_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_dunning_stages_org_id (org_id, id),
      UNIQUE KEY uq_dunning_stages_policy_stage (org_id, policy_id, stage_number),
      KEY idx_dunning_stages_org_policy (org_id, policy_id),
      CONSTRAINT fk_dunning_stages_policy
        FOREIGN KEY (org_id, policy_id) REFERENCES dunning_policies (org_id, id) ON DELETE CASCADE,
      CONSTRAINT chk_dunning_stages_late_fee CHECK (late_fee_minor IS NULL OR late_fee_minor > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // dunning_sends — one reminder sent for one invoice at one stage. Append-only (0999).
  //
  // The `(org_id, invoice_id, stage_id)` unique key IS the once-per-stage guard (D-77, H8): a
  // second attempt at the same stage for the same invoice is a duplicate-key refusal, not a
  // second email. It is also evidence — a reminder went out, at this time, to this address —
  // so it is append-only for `invoice_deliveries`' reason, and a failed attempt is its own row
  // (`status = 'failed'`) rather than an overwrite. Both foreign keys RESTRICT: the invoice and
  // the stage a send references cannot be deleted out from under the record.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE dunning_sends (
      id                  BINARY(16)   NOT NULL,
      org_id              BINARY(16)   NOT NULL,
      invoice_id          BINARY(16)   NOT NULL,
      stage_id            BINARY(16)   NOT NULL,
      recipient_email     VARCHAR(320) NOT NULL,
      provider_message_id VARCHAR(255) NULL,
      status              VARCHAR(16)  NOT NULL,
      sent_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_dunning_sends_org_id (org_id, id),
      -- The once-per-stage guard: a stage sends at most once per invoice (D-77).
      UNIQUE KEY uq_dunning_sends_invoice_stage (org_id, invoice_id, stage_id),
      KEY idx_dunning_sends_org_invoice (org_id, invoice_id),
      CONSTRAINT fk_dunning_sends_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_dunning_sends_invoice
        FOREIGN KEY (org_id, invoice_id) REFERENCES ar_documents (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_dunning_sends_stage
        FOREIGN KEY (org_id, stage_id) REFERENCES dunning_stages (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_dunning_sends_status CHECK (status IN ('sent', 'failed'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order, children before parents so the composite foreign keys drop cleanly.
  await sql`DROP TABLE IF EXISTS dunning_sends`.execute(db);
  await sql`DROP TABLE IF EXISTS dunning_stages`.execute(db);
  await sql`DROP TABLE IF EXISTS dunning_policies`.execute(db);
  await sql`DROP TABLE IF EXISTS recurring_invoice_template_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS recurring_invoice_templates`.execute(db);
}
