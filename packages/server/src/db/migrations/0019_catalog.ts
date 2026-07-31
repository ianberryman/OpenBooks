import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Item catalog: a reusable list of priced items a document line can be selected
 * from instead of typed from scratch (initiative CAT; ROADMAP D-CAT-1…D-CAT-5).
 *
 * ## A convenience seed, not a binding (D-CAT-2)
 *
 * A catalog item supplies defaults — a description, an account, a price, a tax
 * rate — that the UI copies onto a line. The line keeps storing its own copies
 * (`ar_document_lines.description`/`unit_amount_minor`/`account_id`/`tax_rate_id`
 * are unchanged), and the new `catalog_item_id` on each line table is **provenance
 * only**: it records that a line came from an item, and never drives what the line
 * says. Editing or deactivating an item therefore restates nothing — the same
 * reason `budgets` is mutable, one level further out, because here the immutable
 * fact still lives only in `journals`. Free-form entry leaves `catalog_item_id`
 * NULL, exactly the behaviour every document had before this migration.
 *
 * The `ON DELETE RESTRICT` on each line's FK is what makes "historical lines keep
 * resolving" (D-CAT-5) a schema fact rather than a service promise: an item that a
 * document ever referenced cannot be hard-deleted, only deactivated (`is_active`).
 *
 * ## Use-case-specific, not dual-direction (D-CAT-1)
 *
 * `direction` is `'sales'` or `'purchase'`. A sales item carries its income
 * account and sell price; a purchase item its expense account and cost. A thing
 * bought and sold is two items. The line's own FK cannot enforce that an AR line
 * only references a sales item — no CHECK reads another table's column — so
 * `catalog.service.ts` rejects a direction mismatch, the `budgets` P&L-type twin.
 *
 * ## The line-table columns are ALTERs, not edits to 0005/0015
 *
 * `catalog_items` must exist before the four line tables' FKs can name it, and the
 * grants migration must still sort last, so the whole change lives in this one
 * file: the table is created, then each existing line table is altered to carry the
 * nullable `catalog_item_id` + its composite FK. This is the `bank_statement_lines`
 * add-a-column-in-a-new-migration pattern rather than an in-place edit of the
 * subledger and procurement migrations.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE catalog_items (
      id                BINARY(16)   NOT NULL,
      org_id            BINARY(16)   NOT NULL,
      direction         VARCHAR(16)  NOT NULL,
      -- What the item is; copied to the line description on select, and the string
      -- OCR line-matching scores against (Phase 2). NOT NULL — an item with no name
      -- is nothing to pick.
      name              VARCHAR(512) NOT NULL,
      -- Optional SKU. UNIQUE per org, but MySQL treats NULLs as distinct, so any
      -- number of un-coded items coexist.
      code              VARCHAR(64)  NULL,
      -- The defaults the picker fills in. All nullable: an item can be a reusable
      -- description alone. No DEFAULT on the price, budgets.amount_minor's reason —
      -- a price that silently defaulted to zero is worse than an absent one.
      account_id        BINARY(16)   NULL,
      unit_amount_minor BIGINT       NULL,
      tax_rate_id       BINARY(16)   NULL,
      is_active         TINYINT(1)   NOT NULL DEFAULT 1,
      created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      -- So the four line tables can reference this one compositely (the tenancy
      -- pattern: a cross-org reference cannot typecheck as a row).
      UNIQUE KEY uq_catalog_items_org_id (org_id, id),
      UNIQUE KEY uq_catalog_items_org_code (org_id, code),
      -- The picker's query: items of one direction, active, ordered by name.
      KEY idx_catalog_items_org_dir_active (org_id, direction, is_active, name),
      -- Declared for the FKs below, exactly as the line tables declare theirs.
      KEY idx_catalog_items_org_account (org_id, account_id),
      KEY idx_catalog_items_org_tax_rate (org_id, tax_rate_id),
      CONSTRAINT fk_catalog_items_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_catalog_items_account
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_catalog_items_tax_rate
        FOREIGN KEY (org_id, tax_rate_id) REFERENCES tax_rates (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_catalog_items_direction CHECK (direction IN ('sales', 'purchase'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // The line-table provenance column + composite FK, added to each of the four
  // line tables (D-CAT-2). BINARY(16) NULL, RESTRICT on delete so a referenced item
  // cannot vanish. The covering index is what the composite FK needs.
  for (const line of [
    { table: 'ar_document_lines', prefix: 'ar_document_lines' },
    { table: 'ap_document_lines', prefix: 'ap_document_lines' },
    { table: 'purchase_order_lines', prefix: 'purchase_order_lines' },
    { table: 'estimate_lines', prefix: 'estimate_lines' },
  ]) {
    await sql
      .raw(
        `ALTER TABLE ${line.table}
           ADD COLUMN catalog_item_id BINARY(16) NULL AFTER account_id,
           ADD KEY idx_${line.prefix}_org_catalog_item (org_id, catalog_item_id),
           ADD CONSTRAINT fk_${line.prefix}_catalog_item
             FOREIGN KEY (org_id, catalog_item_id)
             REFERENCES catalog_items (org_id, id) ON DELETE RESTRICT`,
      )
      .execute(db);
  }
}

export async function down(db: MigrationDb): Promise<void> {
  for (const line of [
    'ar_document_lines',
    'ap_document_lines',
    'purchase_order_lines',
    'estimate_lines',
  ]) {
    await sql.raw(`ALTER TABLE ${line} DROP FOREIGN KEY fk_${line}_catalog_item`).execute(db);
    await sql.raw(`ALTER TABLE ${line} DROP COLUMN catalog_item_id`).execute(db);
  }
  await sql`DROP TABLE IF EXISTS catalog_items`.execute(db);
}
