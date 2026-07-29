import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Cash application (initiative I, OB-134…142): payment terms, and the composite
 * foreign keys the in-place edits to `0002_ledger` and `0005_subledger` could not
 * carry themselves (ROADMAP D-15, D-79, D-105…D-108).
 *
 * ## Why this file is nearly empty of columns
 *
 * CA is additive almost everywhere it touches the schema, and D-15 says pre-release
 * additions are edited into the migration that owns the table rather than appended
 * here — so `contacts.default_payment_term_id`, `ar_documents`/
 * `ap_documents.payment_term_id`, `org_accounting_settings.discount_given_account_id`
 * / `.discount_received_account_id`, and `ar_allocations`/
 * `ap_allocations.discount_journal_id` all live in `0002_ledger` and
 * `0005_subledger` themselves. The load-bearing restructure — `bank_line_clearings`
 * splitting into parent and child (D-105) — lives in `0006_banking` for the same
 * reason: the child belongs beside its parent, not in the migration numbered after
 * every other subsystem.
 *
 * What is actually new here is `payment_terms` itself, a table with no predecessor
 * to be added to, plus the three composite foreign keys that could not be declared
 * where their columns were: `contacts`, `ar_documents`, and `ap_documents` are all
 * created by migrations that run *before* `payment_terms` exists, and MySQL refuses
 * a `FOREIGN KEY` to a table that is not there yet (`ERROR 1824`/`1215`, the same
 * fact `0999_app_grants`'s header states about `GRANT`). So the column is declared
 * nullable in its own migration and the constraint is added here, by `ALTER TABLE`,
 * once `payment_terms` exists to be pointed at.
 *
 * ## payment_terms is greenfield, and mutable
 *
 * A term is a settings-like row an org edits freely — renaming it, retiring it,
 * changing its discount window — and D-107 is explicit that none of this needs a
 * new permission: it CRUDs behind `orgs.read`/`orgs.write`, the same key the
 * control-account nominations beside it in `org_accounting_settings` already use.
 * `payment_terms` is therefore in `0999_app_grants`'s `MUTABLE_TABLES`, not
 * `APPEND_ONLY_TABLES` — editing a term moves how *future* documents compute a due
 * date and a discount window and cannot reach one already raised, for
 * `org_accounting_settings`'s own reason (a posted journal names no term at all).
 *
 * `discount_rate_ppm` and `discount_window_days` are nullable **together**
 * (`chk_payment_terms_discount`): both null is a *simple* term (net days only,
 * D-79's "simple and rich both supported"), and a half-specified discount — a rate
 * with no window to claim it in, or a window with no rate — is inexpressible. The
 * rate follows `tax_rates.rate_ppm`'s own convention: an integer scaled by
 * 1,000,000 rather than a `DECIMAL`, for the reason spec §12/D-13 gives money
 * itself — the driver returns every integer column as a `number`/`bigint`, and a
 * `DECIMAL` would arrive as a string a caller eventually parses as a float.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // payment_terms — Net 30, 2/10 Net 30, Due on receipt (ROADMAP D-79, D-107).
  //
  // `net_days` is the only thing a *simple* term needs: the due date is
  // `issue_date + net_days`. `discount_rate_ppm`/`discount_window_days` are the
  // *rich* half — an early-pay discount of that rate, available for that many days
  // from issue — and both are null together or not at all (`chk_payment_terms_discount`).
  //
  // `uq_payment_terms_org_name` follows every other settings-list table in this
  // schema (`tax_rates`, `bank_rules`): a name is how a human picks a term from a
  // list, and two terms called "Net 30" in one org is a list nobody can use.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE payment_terms (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      name                 VARCHAR(120) NOT NULL,
      net_days             INT UNSIGNED NOT NULL,
      discount_rate_ppm    INT UNSIGNED NULL,
      discount_window_days INT UNSIGNED NULL,
      is_active            TINYINT(1)   NOT NULL DEFAULT 1,
      created_by_user_id   BINARY(16)   NOT NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_payment_terms_org_id (org_id, id),
      UNIQUE KEY uq_payment_terms_org_name (org_id, name),
      KEY idx_payment_terms_org_active (org_id, is_active),
      CONSTRAINT fk_payment_terms_org FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_payment_terms_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_payment_terms_discount CHECK (
        (discount_rate_ppm IS NULL) = (discount_window_days IS NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // The three composite foreign keys `0002_ledger`/`0005_subledger` could not
  // declare on their own columns, because `payment_terms` did not exist yet. All
  // three are RESTRICT: a term still nominated by a contact's default or named on a
  // document cannot be deleted out from under it — the same shape
  // `fk_oas_receivable` takes on `org_accounting_settings`. Retiring a term is
  // `is_active = 0`, not a delete, for precisely this reason.
  // ---------------------------------------------------------------------------
  await sql`
    ALTER TABLE contacts
      ADD CONSTRAINT fk_contacts_default_payment_term
      FOREIGN KEY (org_id, default_payment_term_id) REFERENCES payment_terms (org_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  await sql`
    ALTER TABLE ar_documents
      ADD CONSTRAINT fk_ar_documents_payment_term
      FOREIGN KEY (org_id, payment_term_id) REFERENCES payment_terms (org_id, id)
      ON DELETE RESTRICT
  `.execute(db);

  await sql`
    ALTER TABLE ap_documents
      ADD CONSTRAINT fk_ap_documents_payment_term
      FOREIGN KEY (org_id, payment_term_id) REFERENCES payment_terms (org_id, id)
      ON DELETE RESTRICT
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // The foreign keys first — a table cannot be dropped while one still points at
  // it — then the table itself.
  await sql`ALTER TABLE ap_documents DROP FOREIGN KEY fk_ap_documents_payment_term`.execute(db);
  await sql`ALTER TABLE ar_documents DROP FOREIGN KEY fk_ar_documents_payment_term`.execute(db);
  await sql`ALTER TABLE contacts DROP FOREIGN KEY fk_contacts_default_payment_term`.execute(db);
  await sql`DROP TABLE IF EXISTS payment_terms`.execute(db);
}
