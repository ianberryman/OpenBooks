import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * 1099 contractor tax reporting (OB-228). A reporting/compliance overlay — it posts
 * **no journals** (like budgets and the audit report), so there is no ledger risk;
 * the subtlety is sensitive PII, a calendar-year cash-paid rollup, and immutable filed
 * records. Three tenant tables here; the one-column change on `accounts`
 * (`excluded_from_1099`, D-228-3) is an in-place edit of `0002_ledger` per D-15, not an
 * ALTER here — the feed_source precedent.
 *
 * ## `vendor_tax_profiles` — the W-9 data, TIN encrypted in a column (D-228-2)
 *
 * One row per 1099 vendor. The **TIN is per-vendor PII at unbounded cardinality**, so it
 * is an **app-encrypted column** (`tax_id_ciphertext`, the `providers/secrets/local.ts`
 * AES-256-GCM envelope via `crypto/field-encryption.ts`), **not** a `secrets`-table row:
 * the `secrets` store is only for an org's bounded credential secrets (API/webhook keys),
 * it has no `org_id`, and it sits outside the `tenantDb()` guard — so per-row PII there
 * would forfeit tenancy. Only `tax_id_last4` is ever read back to the wire. The e-file
 * *vendor* API key, by contrast, is a bounded credential and does go through `SecretsProvider`.
 *
 * ## `ten99_form_runs` (mutable) + `ten99_forms` (append-only) — the header/detail split
 *
 * A run is working state whose status legitimately moves (`draft→generated→submitted→
 * accepted|rejected`) as e-file progresses, like a reconciliation session — mutable. The
 * per-vendor form snapshot is a **record of what was filed** and is **append-only**: a
 * correction is a NEW row carrying `corrects_form_id` (the reversing-entry house style,
 * D-02), never a mutation. Worksheet numbers are computed live from `payments`; "Generate"
 * is what freezes the immutable `ten99_forms`.
 *
 * ## Closed sets are `VARCHAR + CHECK`, not `ENUM`
 *
 * `status` / `form_type` / `tax_id_type` etc. are `VARCHAR` + a `CHECK`, the
 * `customer_statements.status` precedent — the app reads them as a union and a new member
 * is a CHECK edit with no `generated.ts` literal-union ripple.
 *
 * All three are tenant tables (`tenant-tables.ts`); `vendor_tax_profiles` and
 * `ten99_form_runs` are `MUTABLE_TABLES`, `ten99_forms` is `APPEND_ONLY_TABLES`
 * (`0999_app_grants`). The next free prefix after `0022_account_statements` is `0023`.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE vendor_tax_profiles (
      id                  BINARY(16)     NOT NULL,
      org_id              BINARY(16)     NOT NULL,
      contact_id          BINARY(16)     NOT NULL,
      is_1099_eligible    TINYINT(1)     NOT NULL DEFAULT 1,
      -- iv(12) || authTag(16) || ciphertext, one Buffer — the local secrets envelope,
      -- keyed by SECRETS_ENCRYPTION_KEY. Never read back to the wire; only last4 is.
      tax_id_ciphertext   VARBINARY(255) NULL,
      tax_id_last4        CHAR(4)        NULL,
      tax_id_type         VARCHAR(8)     NULL,
      tax_classification  VARCHAR(24)    NULL,
      default_form        VARCHAR(16)    NOT NULL DEFAULT '1099_nec',
      default_box         VARCHAR(8)     NOT NULL DEFAULT 'nec_1',
      legal_name_override VARCHAR(255)   NULL,
      w9_received_on      DATE           NULL,
      created_by_user_id  BINARY(16)     NOT NULL,
      created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_vendor_tax_profiles_org_id (org_id, id),
      -- One profile per vendor.
      UNIQUE KEY uq_vendor_tax_profiles_contact (org_id, contact_id),
      CONSTRAINT fk_vendor_tax_profiles_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_vendor_tax_profiles_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_vendor_tax_profiles_user
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_vendor_tax_profiles_id_type
        CHECK (tax_id_type IS NULL OR tax_id_type IN ('ein', 'ssn', 'itin')),
      CONSTRAINT chk_vendor_tax_profiles_classification
        CHECK (tax_classification IS NULL OR tax_classification IN
          ('individual', 'c_corp', 's_corp', 'partnership', 'llc', 'other')),
      CONSTRAINT chk_vendor_tax_profiles_default_form
        CHECK (default_form IN ('1099_nec', '1099_misc'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE ten99_form_runs (
      id                   BINARY(16)        NOT NULL,
      org_id               BINARY(16)        NOT NULL,
      tax_year             SMALLINT UNSIGNED NOT NULL,
      status               VARCHAR(16)       NOT NULL DEFAULT 'draft',
      efile_provider       VARCHAR(16)       NULL,
      efile_ref            VARCHAR(255)       NULL,
      -- The reporting threshold in force for this run, cents (D-13); $600.00 default for NEC.
      threshold_minor      BIGINT            NOT NULL DEFAULT 60000,
      generated_by_user_id BINARY(16)        NOT NULL,
      created_at           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                             ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ten99_form_runs_org_id (org_id, id),
      KEY idx_ten99_form_runs_org_year (org_id, tax_year, created_at),
      CONSTRAINT fk_ten99_form_runs_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ten99_form_runs_user
        FOREIGN KEY (generated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_ten99_form_runs_status
        CHECK (status IN ('draft', 'generated', 'submitted', 'accepted', 'rejected')),
      CONSTRAINT chk_ten99_form_runs_provider
        CHECK (efile_provider IS NULL OR efile_provider IN ('manual', 'iris'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  await sql`
    CREATE TABLE ten99_forms (
      id                         BINARY(16)        NOT NULL,
      org_id                     BINARY(16)        NOT NULL,
      run_id                     BINARY(16)        NOT NULL,
      contact_id                 BINARY(16)        NOT NULL,
      tax_year                   SMALLINT UNSIGNED NOT NULL,
      form_type                  VARCHAR(16)       NOT NULL,
      box_code                   VARCHAR(8)        NOT NULL,
      amount_minor               BIGINT            NOT NULL,
      recipient_legal_name       VARCHAR(255)      NOT NULL,
      recipient_tin_last4        CHAR(4)           NULL,
      recipient_address_snapshot VARCHAR(1024)     NULL,
      -- A correction is a new row pointing at the form it supersedes (D-02 house style).
      corrects_form_id           BINARY(16)        NULL,
      pdf_storage_key            VARCHAR(512)      NULL,
      created_at                 DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_ten99_forms_org_id (org_id, id),
      KEY idx_ten99_forms_org_run (org_id, run_id),
      KEY idx_ten99_forms_org_contact_year (org_id, contact_id, tax_year),
      CONSTRAINT fk_ten99_forms_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_ten99_forms_run
        FOREIGN KEY (org_id, run_id) REFERENCES ten99_form_runs (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ten99_forms_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_ten99_forms_corrects
        FOREIGN KEY (org_id, corrects_form_id) REFERENCES ten99_forms (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_ten99_forms_form_type
        CHECK (form_type IN ('1099_nec', '1099_misc')),
      CONSTRAINT chk_ten99_forms_amount_nonneg CHECK (amount_minor >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS ten99_forms`.execute(db);
  await sql`DROP TABLE IF EXISTS ten99_form_runs`.execute(db);
  await sql`DROP TABLE IF EXISTS vendor_tax_profiles`.execute(db);
}
