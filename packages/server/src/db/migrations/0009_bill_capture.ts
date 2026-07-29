import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * OCR bill capture (initiative O, OB-185…191): the staging area between an
 * uploaded or emailed document and a bill a human has reviewed.
 *
 * Its own file for `0007_invoice_delivery`'s reason: a new subsystem gets one, and
 * `0999_app_grants` sorting last (the ceiling of the four-digit convention) is what
 * makes a file numbered after the ledger possible at all. `0004` stays skipped and
 * the next free prefix after `0008_recurring_dunning` is `0009`.
 *
 * ## The proposal is staging, not a bill
 *
 * A capture never becomes a posting on its own. Extraction writes only this row —
 * the uncommitted read of what the document says — and the human review step is
 * what calls the existing `createBill` to produce a real **draft** bill
 * (`journal_id IS NULL`, D-34/D-38's own vocabulary). So `document_captures` holds
 * no `journal_id` and posts nothing; `drafted_bill_id` is set once review has acted,
 * and approval from there on is the ordinary `approveBill` path, unchanged.
 *
 * ## Both tables are mutable, and that is not a relaxation
 *
 * A capture is working state exactly as a bank-match proposal is (D-43): nothing
 * downstream depends on the extraction being *right*, only on it being a fair
 * starting point for a human to correct, and re-extracting or dismissing it
 * restates no financial statement. `bill_attachments` is the retained-original
 * counterpart of `invoice_deliveries`' artifact key, but on the AP side there is no
 * append-only argument to make: the file it names was never itself evidence of
 * anything happening — the bill it is attached to, once approved, is the record,
 * and that record lives in `journals` as it always has.
 *
 * ## Storage keys, not bytes
 *
 * `document_captures.storage_key` and `bill_attachments.storage_key` name an object
 * in the configured `StorageProvider`, mirroring `org_branding.logo_storage_key` and
 * `invoice_deliveries.artifact_storage_key`. The row is metadata; the bytes live
 * wherever the deployment's storage adapter puts them.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ---------------------------------------------------------------------------
  // document_captures — one uploaded or emailed document and what extraction made
  // of it.
  //
  // `status` is the lifecycle: a row is inserted `extracting`, the extraction job
  // (event-driven, not the daily tick) writes it to `extracted` or `failed`, review
  // moves an `extracted` row to `drafted` or `dismissed`. There is no `approved` or
  // `posted` state here — once a draft bill exists, the bill's own D-38 columns are
  // the truth and this row's job is done.
  //
  // The extracted fields (`extracted_vendor_name`, `extracted_issue_date`,
  // `extracted_reference`, `extracted_total_minor`) are a flat, queryable summary of
  // what `extraction_json` holds in full — line items and tax, which the review
  // screen hydrates whole rather than joins for. `extracted_reference` doubles as
  // the pre-check against a vendor invoice already entered (D-36's duplicate
  // argument), which is why it is a column and not buried in the JSON alone.
  //
  // `matched_contact_id` is nullable because there is no name-lookup today (see the
  // capture service header): it is set only when exactly one active vendor contact
  // matches the extracted name, and left null for a human to resolve otherwise.
  // Composite FK into `contacts (org_id, id)`, RESTRICT — the same shape
  // `fk_ap_documents_contact` takes, so a contact a capture has matched against
  // cannot be deleted out from under it.
  //
  // `drafted_bill_id` is set once review creates the draft bill this capture became.
  // Composite FK into `ap_documents (org_id, id)`, RESTRICT for the same reason: a
  // draft a capture points to is not deletable out from under the capture that
  // produced it.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE document_captures (
      id                     BINARY(16)   NOT NULL,
      org_id                 BINARY(16)   NOT NULL,
      source                 ENUM('upload','email') NOT NULL,
      status                 ENUM('extracting','extracted','failed','drafted','dismissed')
                                          NOT NULL,
      storage_key            VARCHAR(512) NOT NULL,
      filename               VARCHAR(255) NOT NULL,
      content_type           VARCHAR(127) NOT NULL,
      byte_size              BIGINT       NOT NULL,
      extracted_vendor_name  VARCHAR(255) NULL,
      matched_contact_id     BINARY(16)   NULL,
      extracted_issue_date   DATE         NULL,
      extracted_reference    VARCHAR(120) NULL,
      extracted_total_minor  BIGINT       NULL,
      extraction_json        JSON         NULL,
      extraction_error       VARCHAR(512) NULL,
      drafted_bill_id        BINARY(16)   NULL,
      created_by_user_id     BINARY(16)   NOT NULL,
      created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_document_captures_org_id (org_id, id),
      -- The list/queue read: an org's captures by lifecycle state.
      KEY idx_document_captures_org_status (org_id, status),
      KEY idx_document_captures_org_contact (org_id, matched_contact_id),
      KEY idx_document_captures_org_bill (org_id, drafted_bill_id),
      CONSTRAINT fk_document_captures_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_document_captures_contact
        FOREIGN KEY (org_id, matched_contact_id) REFERENCES contacts (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_document_captures_bill
        FOREIGN KEY (org_id, drafted_bill_id) REFERENCES ap_documents (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_document_captures_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ---------------------------------------------------------------------------
  // bill_attachments — the retained original(s) attached to a bill, written when
  // review turns a capture into a draft (and available to any bill, not only a
  // captured one — the route contract lets a bill carry more than the one document
  // its capture produced).
  //
  // Composite FK into `ap_documents (org_id, id)`, RESTRICT: the same shape
  // `fk_invoice_deliveries_invoice` takes toward the document it records against —
  // an attachment on record stops the bill it belongs to from being deleted out
  // from under it.
  // ---------------------------------------------------------------------------
  await sql`
    CREATE TABLE bill_attachments (
      id                 BINARY(16)   NOT NULL,
      org_id             BINARY(16)   NOT NULL,
      ap_document_id     BINARY(16)   NOT NULL,
      storage_key        VARCHAR(512) NOT NULL,
      filename           VARCHAR(255) NOT NULL,
      content_type       VARCHAR(127) NOT NULL,
      byte_size          BIGINT       NOT NULL,
      created_by_user_id BINARY(16)   NOT NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_bill_attachments_org_id (org_id, id),
      -- "Attachments of this bill", the natural read for the attachment route.
      KEY idx_bill_attachments_org_document (org_id, ap_document_id),
      CONSTRAINT fk_bill_attachments_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_bill_attachments_document
        FOREIGN KEY (org_id, ap_document_id) REFERENCES ap_documents (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_bill_attachments_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  // Reverse creation order, children before parents so the composite foreign keys
  // drop cleanly.
  await sql`DROP TABLE IF EXISTS bill_attachments`.execute(db);
  await sql`DROP TABLE IF EXISTS document_captures`.execute(db);
}
