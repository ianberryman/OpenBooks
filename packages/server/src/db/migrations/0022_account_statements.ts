import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Customer statement of account (OB-220, ROADMAP part 1): a per-customer, branded
 * open-item statement — the invoices still owing as at a date, aged — rendered to a
 * PDF, stored behind the `StorageProvider`, recorded here so it is re-downloadable
 * and, when emailed, reachable from a public hosted link.
 *
 * Its own file for `0011_payment_processing`'s reason — a distinct deliverable gets
 * one, and the next free prefix after `0021_bank_feeds` is `0022`.
 *
 * ## One table, and it is `invoice_deliveries` keyed by a customer, not an invoice
 *
 * A statement reuses everything the sent invoice already established: the pdfmake
 * renderer pattern, the branded letterhead read off `org_branding`, the
 * `StorageProvider` for the frozen artifact, the split-credential public token, and
 * the "a re-render is a new row" append-only rule. So this adds exactly one table,
 * modelled line-for-line on `invoice_deliveries` (`0007_invoice_delivery`) — the one
 * structural difference is the parent: a statement belongs to a **contact over a
 * period** (`contact_id` + `as_of`), where a delivery belongs to an **invoice**. The
 * invoice FK is exactly why `invoice_deliveries` could not be reused; every other
 * column carries the same meaning, including the split-credential pair and the
 * append-only discipline. It is a tenant table (`tenant-tables.ts`) and append-only
 * (`APPEND_ONLY_TABLES` in `0999_app_grants`).
 *
 * ## Why the token columns are NULLable, unlike `invoice_deliveries`
 *
 * An invoice delivery only ever exists because it was sent, so its `key_prefix` /
 * `token_hash` / `recipient_email` are NOT NULL. A statement is generated first and
 * emailed only if the user asks (D-220: download-or-send), so a `status='generated'`
 * row carries no recipient and no credential. When it is emailed the same insert
 * writes the split-credential pair and `status='sent'`; a `'failed'` send is its own
 * row, as with a delivery. `status` is a `VARCHAR` + CHECK rather than an ENUM for
 * `invoice_deliveries`' reason (a closed set the app reads as a union, no codegen
 * ripple on a new member).
 *
 * ## Why the `key_prefix` index is bare
 *
 * `(key_prefix)`, not `(org_id, key_prefix)`, exactly as `invoice_deliveries` and
 * `api_keys`: the public hosted-statement link carries the prefix but no org
 * context — the token is what *establishes* the org — so the one sanctioned
 * unauthenticated read (`db/statement-credential-lookup.ts`) looks a row up by
 * prefix alone before any org is known. See `0007_invoice_delivery`'s header for the
 * fuller argument this restates.
 */
export async function up(db: MigrationDb): Promise<void> {
  // `key_prefix` / `token_hash` are the split-credential pair, NULL until a statement
  // is emailed. `artifact_storage_key` names the frozen PDF in the object store.
  // `as_of` is a calendar DATE — the date the open-item balance is computed as at,
  // the statement's reproducibility anchor (aging's D-40 argument). `status` is the
  // closed set {generated, sent, failed}. `generated_by_user_id` is NOT NULL for
  // `statement_packages`' reason: a rendered artifact always has a human accountable.
  await sql`
    CREATE TABLE customer_statements (
      id                   BINARY(16)   NOT NULL,
      org_id               BINARY(16)   NOT NULL,
      contact_id           BINARY(16)   NOT NULL,
      as_of                DATE         NOT NULL,
      recipient_email      VARCHAR(320) NULL,
      artifact_storage_key VARCHAR(512) NOT NULL,
      key_prefix           VARCHAR(16)  NULL,
      token_hash           BINARY(32)   NULL,
      provider_message_id  VARCHAR(255) NULL,
      status               VARCHAR(16)  NOT NULL,
      generated_by_user_id BINARY(16)   NOT NULL,
      created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_customer_statements_org_id (org_id, id),
      -- "Statements for this customer", the natural read for a customer's history.
      KEY idx_customer_statements_org_contact (org_id, contact_id, created_at),
      -- Token lookup from a public link, which carries the prefix but no org context.
      KEY idx_customer_statements_key_prefix (key_prefix),
      CONSTRAINT fk_customer_statements_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_customer_statements_contact
        FOREIGN KEY (org_id, contact_id) REFERENCES contacts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_customer_statements_user
        FOREIGN KEY (generated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
      CONSTRAINT chk_customer_statements_status
        CHECK (status IN ('generated', 'sent', 'failed'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS customer_statements`.execute(db);
}
