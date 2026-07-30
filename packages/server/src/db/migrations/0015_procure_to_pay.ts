import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Procure-to-pay: purchase orders and estimates (initiative M, OB-170…179;
 * ROADMAP D-92).
 *
 * ## Non-posting pre-documents, not a third subledger
 *
 * A purchase order and an estimate carry lines and their own numbering, exactly as
 * `ar_documents`/`ap_documents` do (`0005_subledger`), but **post no journal**
 * (D-92). They are operational — approve, send, track — not ledger events, so
 * `journal_id`/`void_journal_id`, the pair that makes an AR/AP document's lifecycle
 * derivable rather than stored (D-38), have no counterpart here. There is instead a
 * `converted_*_id`/`converted_at` pair: converting a PO creates a bill, an estimate
 * an invoice, carrying every line across, and that conversion is the one financial
 * event either document ever causes. Until it happens, nothing below touches a
 * trial balance.
 *
 * ## The lifecycle is draft → approved → converted, told the D-19/D-38 way
 *
 * A draft is discardable and reserves no number (`sequence_number IS NULL`);
 * approving allocates one from `document_sequences` and stamps `approved_at` in the
 * same transaction — `chk_*_approved` ties the two so neither can exist without the
 * other, the same shape `chk_ar_documents_approved` takes for a journal. Conversion
 * is likewise all-or-nothing: `chk_*_converted` ties `converted_*_id` to
 * `converted_at`, and `chk_*_convert_needs_approval` refuses a converted row with no
 * number, which would mean something was created from a document that was never
 * approved to be sent. Convert-once is enforced above the schema — the service takes
 * the row `FOR UPDATE` and checks `converted_*_id IS NULL` before writing — which is
 * possible only because these tables are mutable (D-14's usual trade).
 *
 * ## Two new `document_sequences` series, no new subsystem
 *
 * `'purchase_order'` and `'estimate'` are appended to
 * `document_sequences.document_type` in place (`0005_subledger`, D-15) rather than
 * given their own counter table: D-36's argument for a gapless, per-org, per-type
 * series applies unchanged, and the enum already exists for exactly this purpose.
 *
 * ## Lines are stored priced, and mirror `ar_document_lines` column for column
 *
 * `purchase_order_lines`/`estimate_lines` carry the same quantity/unit-amount/
 * account/tax-rate shape as `ar_document_lines` (see `0005_subledger` for why
 * quantities are integer micros, why the extended and tax amounts are computed once
 * and stored rather than recomputed on read, and why a line without a rate must
 * carry zero tax). Storing them priced is what makes convert lossless — the bill or
 * invoice `createBill`/`createInvoice` produces from a PO or estimate is built from
 * these same numbers, not re-priced against whatever the chart or rate list says on
 * the day of conversion.
 *
 * No dimension tags on either line table in v1 (deferred, flagged) — a converted
 * draft can have them added before it is approved, so nothing is lost, only
 * deferred to the moment a dimension actually matters.
 *
 * ## predocument_deliveries is append-only, `invoice_deliveries`' argument again
 *
 * Recording that a PO or estimate was emailed to a counterparty is evidence, not
 * working state (`invoice_deliveries`, `0007_invoice_delivery`): a record the
 * application could rewrite would attest to nothing, so it is SELECT/INSERT only
 * (`0999_app_grants`) and a re-send is a new row. `document_id` is deliberately not
 * a foreign key — it names a row in one of two different tables depending on
 * `document_kind`, and MySQL has no polymorphic constraint — so the schema cannot
 * enforce that it points at a real PO or estimate; the service that inserts the row
 * is the only writer and always supplies one it just read.
 *
 * ## Every table here is mutable, and none is a fourth ledger table
 *
 * All four of `purchase_orders`/`purchase_order_lines`/`estimates`/`estimate_lines`
 * are in `0999_app_grants`'s `MUTABLE_TABLES`, the `ar_documents`/`ap_documents`
 * argument applied verbatim: neither holds a financial fact until it converts, so
 * editing one restates nothing a trial balance depends on. `predocument_deliveries`
 * is the one append-only table this migration adds, for the reason immediately
 * above.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // purchase_orders — the AP-side pre-document (OB-170…173, D-92). See the file
  // header for the draft→approved→converted lifecycle and why it posts no journal.
  //
  // `contact_id` names a vendor; the expense service's `requireEmployee` and this
  // service's own `requireVendor` are what actually check the contact's flag — the
  // schema cannot read another table's column in a CHECK.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE purchase_orders (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      sequence_number    BIGINT UNSIGNED NULL,
      contact_id         BINARY(16)   NOT NULL,
      issue_date         DATE         NOT NULL,
      expected_date      DATE         NULL,
      tax_mode           ENUM('inclusive','exclusive') NOT NULL,
      reference          VARCHAR(120) NULL,
      memo               VARCHAR(512) NULL,
      approved_at        DATETIME(3)  NULL,
      converted_bill_id  BINARY(16)   NULL,
      converted_at       DATETIME(3)  NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_purchase_orders_org_id (org_id, id),
      UNIQUE KEY uq_purchase_orders_org_sequence (org_id, sequence_number),
      KEY idx_purchase_orders_org_created (org_id, created_at, id),
      KEY idx_purchase_orders_org_contact (org_id, contact_id),
      -- Declared rather than left to InnoDB's automatic index, exactly as
      -- org_accounting_settings' composite FKs are (0005): the covering index for
      -- the convert-target FK is visible where the constraint is.
      KEY idx_purchase_orders_org_converted_bill (org_id, converted_bill_id),
      CONSTRAINT fk_purchase_orders_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_purchase_orders_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_purchase_orders_bill
        FOREIGN KEY (org_id, converted_bill_id) REFERENCES ap_documents (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_purchase_orders_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_purchase_orders_approved CHECK (
        (sequence_number IS NULL) = (approved_at IS NULL)
      ),
      CONSTRAINT chk_purchase_orders_converted CHECK (
        (converted_bill_id IS NULL) = (converted_at IS NULL)
      ),
      CONSTRAINT chk_purchase_orders_convert_needs_approval CHECK (
        converted_bill_id IS NULL OR sequence_number IS NOT NULL
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // purchase_order_lines — the priced lines a convert carries into a bill verbatim.
  // Same shape as `ar_document_lines`/`ap_document_lines` (0005); see that table for
  // why quantities are integer micros and why the computed amounts are stored
  // rather than recomputed. No dimension tags (D-M7, deferred).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE purchase_order_lines (
      id                BIGINT       NOT NULL AUTO_INCREMENT,
      org_id            BINARY(16)   NOT NULL,
      purchase_order_id BINARY(16)   NOT NULL,
      line_number       SMALLINT UNSIGNED NOT NULL,
      description       VARCHAR(512) NULL,
      quantity_micros   BIGINT       NOT NULL,
      unit_amount_minor BIGINT       NOT NULL,
      account_id        BINARY(16)   NOT NULL,
      tax_rate_id       BINARY(16)   NULL,
      line_amount_minor BIGINT       NOT NULL,
      tax_amount_minor  BIGINT       NOT NULL DEFAULT 0,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_purchase_order_lines_org_id (org_id, id),
      KEY idx_purchase_order_lines_doc (org_id, purchase_order_id, line_number),
      -- Declared for the account/tax-rate FKs below, exactly as
      -- idx_ar_document_lines_org_account/_org_tax_rate are (0005).
      KEY idx_purchase_order_lines_org_account (org_id, account_id),
      KEY idx_purchase_order_lines_org_tax_rate (org_id, tax_rate_id),
      CONSTRAINT fk_purchase_order_lines_purchase_order
        FOREIGN KEY (org_id, purchase_order_id) REFERENCES purchase_orders (org_id, id)
        ON DELETE CASCADE,
      CONSTRAINT fk_purchase_order_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_purchase_order_lines_tax_rate
        FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_purchase_order_lines_quantity CHECK (quantity_micros > 0),
      CONSTRAINT chk_purchase_order_lines_amounts CHECK (
        unit_amount_minor >= 0 AND line_amount_minor >= 0 AND tax_amount_minor >= 0
      ),
      CONSTRAINT chk_purchase_order_lines_tax_needs_rate CHECK (
        tax_rate_id IS NOT NULL OR tax_amount_minor = 0
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // estimates — the AR-side mirror of `purchase_orders` (OB-174…176, D-92).
  // `contact_id` names a customer; `expiry_date` is the estimate's equivalent of a
  // PO's `expected_date` — how long the quote stands before it lapses, not enforced
  // here (no CHECK reads the clock). Converting produces an invoice
  // (`converted_invoice_id` → `ar_documents`); "acceptance" is not modelled
  // separately from convert (D-M6, flagged).
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE estimates (
      id                    BINARY(16)   NOT NULL,
      org_id                BINARY(16)   NOT NULL,
      sequence_number       BIGINT UNSIGNED NULL,
      contact_id            BINARY(16)   NOT NULL,
      issue_date            DATE         NOT NULL,
      expiry_date           DATE         NULL,
      tax_mode              ENUM('inclusive','exclusive') NOT NULL,
      reference             VARCHAR(120) NULL,
      memo                  VARCHAR(512) NULL,
      approved_at           DATETIME(3)  NULL,
      converted_invoice_id  BINARY(16)   NULL,
      converted_at          DATETIME(3)  NULL,
      created_by_user_id    BINARY(16)   NOT NULL,
      created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_estimates_org_id (org_id, id),
      UNIQUE KEY uq_estimates_org_sequence (org_id, sequence_number),
      KEY idx_estimates_org_created (org_id, created_at, id),
      KEY idx_estimates_org_contact (org_id, contact_id),
      KEY idx_estimates_org_converted_invoice (org_id, converted_invoice_id),
      CONSTRAINT fk_estimates_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_estimates_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_estimates_invoice
        FOREIGN KEY (org_id, converted_invoice_id) REFERENCES ar_documents (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_estimates_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_estimates_approved CHECK (
        (sequence_number IS NULL) = (approved_at IS NULL)
      ),
      CONSTRAINT chk_estimates_converted CHECK (
        (converted_invoice_id IS NULL) = (converted_at IS NULL)
      ),
      CONSTRAINT chk_estimates_convert_needs_approval CHECK (
        converted_invoice_id IS NULL OR sequence_number IS NOT NULL
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // estimate_lines — the mirror of `purchase_order_lines`. See that table, and
  // `ar_document_lines` (0005), for the quantity/amount reasoning.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE estimate_lines (
      id                BIGINT       NOT NULL AUTO_INCREMENT,
      org_id            BINARY(16)   NOT NULL,
      estimate_id       BINARY(16)   NOT NULL,
      line_number       SMALLINT UNSIGNED NOT NULL,
      description       VARCHAR(512) NULL,
      quantity_micros   BIGINT       NOT NULL,
      unit_amount_minor BIGINT       NOT NULL,
      account_id        BINARY(16)   NOT NULL,
      tax_rate_id       BINARY(16)   NULL,
      line_amount_minor BIGINT       NOT NULL,
      tax_amount_minor  BIGINT       NOT NULL DEFAULT 0,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_estimate_lines_org_id (org_id, id),
      KEY idx_estimate_lines_doc (org_id, estimate_id, line_number),
      KEY idx_estimate_lines_org_account (org_id, account_id),
      KEY idx_estimate_lines_org_tax_rate (org_id, tax_rate_id),
      CONSTRAINT fk_estimate_lines_estimate
        FOREIGN KEY (org_id, estimate_id) REFERENCES estimates (org_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_estimate_lines_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_estimate_lines_tax_rate
        FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_estimate_lines_quantity CHECK (quantity_micros > 0),
      CONSTRAINT chk_estimate_lines_amounts CHECK (
        unit_amount_minor >= 0 AND line_amount_minor >= 0 AND tax_amount_minor >= 0
      ),
      CONSTRAINT chk_estimate_lines_tax_needs_rate CHECK (
        tax_rate_id IS NOT NULL OR tax_amount_minor = 0
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // predocument_deliveries — the immutable record of one emailed PO or estimate
  // (D-M5). See the file header for why this is append-only and why `document_id`
  // carries no foreign key.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE predocument_deliveries (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      document_kind        ENUM('purchase_order','estimate') NOT NULL,
      document_id          BINARY(16)   NOT NULL,
      recipient_email      VARCHAR(320) NOT NULL,
      status               ENUM('sent','failed') NOT NULL,
      provider_message_id  VARCHAR(255) NULL,
      sent_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      created_by_user_id   BINARY(16)   NOT NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_predocument_deliveries_org_id (org_id, id),
      -- "Deliveries of this document", the natural read for a PO's or estimate's
      -- send history — idx_invoice_deliveries_org_invoice's own reason.
      KEY idx_predocument_deliveries_doc (org_id, document_kind, document_id, sent_at),
      CONSTRAINT fk_predocument_deliveries_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_predocument_deliveries_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Children before parents so no composite foreign key blocks a drop.
  await sql`DROP TABLE IF EXISTS predocument_deliveries`.execute(db);
  await sql`DROP TABLE IF EXISTS estimate_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS estimates`.execute(db);
  await sql`DROP TABLE IF EXISTS purchase_order_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS purchase_orders`.execute(db);
}
