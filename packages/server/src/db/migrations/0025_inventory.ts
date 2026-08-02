import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Tracked inventory & perpetual COGS (initiative INVENTORY, OB-224; ROADMAP
 * § Milestone INVENTORY).
 *
 * ## The append-only kernel decides the whole design
 *
 * Every competitor recomputes inventory cost by mutating history — a backdated
 * purchase silently re-costs sales already recorded. OpenBooks cannot: journals
 * are append-only and `posting.repository.ts` is the one write path (spec §2.2,
 * §12). Weighted-average maps onto that constraint cleanly, and FIFO does not, so
 * weighted-average ships first (Xero parity) and FIFO is a deferred second method.
 * The on-hand quantity and value of an item are a *fold* over `inventory_movements`
 * — each movement appends a signed `(qty_delta_micros, value_delta_minor)` — never
 * a stored mutable balance. The unit cost is derived `value / qty`, a rational that
 * is never rounded into a column. This is the subledger-agreement discipline
 * (spec §11) the M3 subledger and M4 banking already use: Σ movements ties to the
 * inventory-asset GL account, verified the OB-088 way.
 *
 * ## What each object is
 *
 * `catalog_items` gains the costing fields. An inventory item is stored
 * `direction='inventory'` (the CHECK is widened) and the line pickers union it into
 * both sales and purchase lists — one stock record, bought and sold (D-INV-1). The
 * item costing fields ride `catalog.write` (they are item fields); the new
 * `inventory.read`/`inventory.write` keys gate the valuation views and the stock
 * adjustment document (D-INV-8, seeded in 0001_tenancy).
 *
 * `inventory_movements` is the append-only subledger, modelled on
 * `bank_line_clearing_entries` (0006_banking) but deliberately NOT unique per
 * journal: one bill posts many item movements against one journal. `journal_id`
 * names the journal that carried the movement's GL effect (RESTRICT — journals are
 * never deleted). A sale's COGS posts as a *separate* `source='inventory'` journal
 * so reversing an invoice reverses both revenue and COGS (D-INV-7); a receipt rides
 * the bill's own journal (the Dr is redirected to the inventory-asset account).
 *
 * `inventory_adjustments` is the count/shrinkage document (D-INV-6): a mutable
 * header that posts `Dr/Cr inventory-asset vs. the shrinkage account` nominated in
 * `org_accounting_settings` (the discount/depreciation-twin pattern). Its lines are
 * the movements that carry `source_doc_id` back to the header, so no separate line
 * table is needed.
 *
 * `ar_documents.cogs_journal_id` is load-bearing: void today reverses only
 * `journal_id`, and it MUST also reverse the COGS journal or the subledger stops
 * tying to the control account (D-INV-7).
 *
 * ## In-place, like every pre-release schema change (D-15)
 *
 * The catalog and settings ALTERs live here rather than editing 0019/0005, the
 * `bank_statement_lines` add-a-column-in-a-new-migration pattern. Sorts between
 * 0024 and 0999 so the grants migration still runs last.
 */
export async function up(db: MigrationDb): Promise<void> {
  // ── catalog_items: the costing fields + the 'inventory' direction ──────────
  //
  // All nullable except item_type (which defaults existing rows to non-inventory).
  // The app-level invariant `item_type='inventory' ⇒ asset+COGS+costing_method NOT
  // NULL` lives in catalog.service.ts, not a CHECK: a CHECK cannot express "these
  // three are required only for one item_type" without also forbidding a
  // non-inventory item from ever nominating them, which the picker union allows.
  await sql`
    ALTER TABLE catalog_items
      ADD COLUMN item_type VARCHAR(16) NOT NULL DEFAULT 'non_inventory' AFTER direction,
      ADD COLUMN inventory_asset_account_id BINARY(16) NULL AFTER item_type,
      ADD COLUMN cogs_account_id BINARY(16) NULL AFTER inventory_asset_account_id,
      ADD COLUMN costing_method VARCHAR(16) NULL AFTER cogs_account_id,
      ADD COLUMN default_cost_minor BIGINT NULL AFTER costing_method,
      ADD COLUMN reorder_point_micros BIGINT NULL AFTER default_cost_minor,
      ADD KEY idx_catalog_items_org_inv_asset (org_id, inventory_asset_account_id),
      ADD KEY idx_catalog_items_org_cogs (org_id, cogs_account_id),
      ADD CONSTRAINT fk_catalog_items_inv_asset
        FOREIGN KEY (org_id, inventory_asset_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      ADD CONSTRAINT fk_catalog_items_cogs
        FOREIGN KEY (org_id, cogs_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT,
      ADD CONSTRAINT chk_catalog_items_item_type
        CHECK (item_type IN ('inventory', 'non_inventory', 'service')),
      ADD CONSTRAINT chk_catalog_items_costing_method
        CHECK (costing_method IS NULL OR costing_method IN ('weighted_average'))
  `.execute(db);

  // Widen the direction CHECK to admit 'inventory'. MySQL cannot alter a CHECK in
  // place, so drop and re-add.
  await sql`ALTER TABLE catalog_items DROP CHECK chk_catalog_items_direction`.execute(db);
  await sql`
    ALTER TABLE catalog_items
      ADD CONSTRAINT chk_catalog_items_direction
        CHECK (direction IN ('sales', 'purchase', 'inventory'))
  `.execute(db);

  // ── inventory_movements: the append-only subledger ─────────────────────────
  await sql`
    CREATE TABLE inventory_movements (
      id               BINARY(16)  NOT NULL,
      org_id           BINARY(16)  NOT NULL,
      catalog_item_id  BINARY(16)  NOT NULL,
      movement_type    VARCHAR(16) NOT NULL,
      -- Signed. qty in micros (the ar_document_lines.quantity_micros scale);
      -- value in minor units (cents). Carried separately so the unit cost stays a
      -- derived rational and never rounds into a stored column (the no-float-money
      -- analogue). A receipt is (+qty, +value); a sale (-qty, -value).
      qty_delta_micros    BIGINT   NOT NULL,
      value_delta_minor   BIGINT   NOT NULL,
      -- The journal that carried this movement's GL effect. RESTRICT: journals are
      -- never deleted (spec §2.2). NOT unique per journal — one bill posts many
      -- item movements against its single journal.
      journal_id       BINARY(16)  NOT NULL,
      -- Provenance: which document produced the movement (bill / invoice /
      -- adjustment). Nullable type/id together so a movement can name its origin
      -- without a foreign key into every possible source table.
      source_doc_type  VARCHAR(24) NULL,
      source_doc_id    BINARY(16)  NULL,
      movement_date    DATE        NOT NULL,
      created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_inventory_movements_org_id (org_id, id),
      -- The fold: on-hand qty/value for an item as at a date is a SUM over this
      -- index. No snapshot cache in v1 — the log is the source of truth, and a
      -- cache would be a rebuildable perf follow-up (the journal-sequence precedent).
      KEY idx_inventory_movements_org_item_date (org_id, catalog_item_id, movement_date),
      KEY idx_inventory_movements_org_journal (org_id, journal_id),
      KEY idx_inventory_movements_org_source (org_id, source_doc_type, source_doc_id),
      CONSTRAINT fk_inventory_movements_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_movements_item
        FOREIGN KEY (org_id, catalog_item_id) REFERENCES catalog_items (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_movements_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT chk_inventory_movements_type
        CHECK (movement_type IN ('receipt', 'sale', 'adjustment', 'true_up', 'reversal'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ── inventory_adjustments: the count / shrinkage document header ────────────
  //
  // Mutable (pencil until posted): built and edited, then post stamps journal_id
  // and appends the movements. A correction is a reversing journal (D-02), recorded
  // by reversed_by_journal_id, never an edit to a posted row.
  await sql`
    CREATE TABLE inventory_adjustments (
      id                     BINARY(16)   NOT NULL,
      org_id                 BINARY(16)   NOT NULL,
      adjustment_date        DATE         NOT NULL,
      memo                   VARCHAR(512) NULL,
      journal_id             BINARY(16)   NULL,
      reversed_by_journal_id BINARY(16)   NULL,
      created_by_user_id     BINARY(16)   NOT NULL,
      created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                          ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_inventory_adjustments_org_id (org_id, id),
      UNIQUE KEY uq_inventory_adjustments_journal (org_id, journal_id),
      UNIQUE KEY uq_inventory_adjustments_reversal (org_id, reversed_by_journal_id),
      KEY idx_inventory_adjustments_org_date (org_id, adjustment_date),
      CONSTRAINT fk_inventory_adjustments_org
        FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_adjustments_journal
        FOREIGN KEY (org_id, journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_adjustments_reversal
        FOREIGN KEY (org_id, reversed_by_journal_id) REFERENCES journals (org_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_adjustments_author
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);

  // ── ar_documents.cogs_journal_id: the void-ripple hook (D-INV-7) ───────────
  //
  // A sale posts revenue (journal_id) and a separate COGS journal; a void must
  // reverse both. RESTRICT + its own covering index, exactly as void_journal_id.
  await sql`
    ALTER TABLE ar_documents
      ADD COLUMN cogs_journal_id BINARY(16) NULL AFTER void_journal_id,
      ADD UNIQUE KEY uq_ar_documents_cogs_journal (org_id, cogs_journal_id),
      ADD CONSTRAINT fk_ar_documents_cogs_journal
        FOREIGN KEY (org_id, cogs_journal_id) REFERENCES journals (org_id, id) ON DELETE RESTRICT
  `.execute(db);

  // ── org_accounting_settings.inventory_shrinkage_account_id ─────────────────
  //
  // Where a stock adjustment's Dr/Cr lands (D-INV-6), resolved like the discount
  // and depreciation twins beside it. Nullable — an org that tracks no inventory
  // need nominate none.
  await sql`
    ALTER TABLE org_accounting_settings
      ADD COLUMN inventory_shrinkage_account_id BINARY(16) NULL
        AFTER accumulated_depreciation_account_id,
      ADD KEY idx_oas_inventory_shrinkage (org_id, inventory_shrinkage_account_id),
      ADD CONSTRAINT fk_oas_inventory_shrinkage
        FOREIGN KEY (org_id, inventory_shrinkage_account_id) REFERENCES accounts (org_id, id)
        ON DELETE RESTRICT
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`
    ALTER TABLE org_accounting_settings
      DROP FOREIGN KEY fk_oas_inventory_shrinkage,
      DROP COLUMN inventory_shrinkage_account_id
  `.execute(db);
  await sql`
    ALTER TABLE ar_documents
      DROP FOREIGN KEY fk_ar_documents_cogs_journal,
      DROP COLUMN cogs_journal_id
  `.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_adjustments`.execute(db);
  await sql`DROP TABLE IF EXISTS inventory_movements`.execute(db);
  await sql`ALTER TABLE catalog_items DROP CHECK chk_catalog_items_direction`.execute(db);
  await sql`
    ALTER TABLE catalog_items
      ADD CONSTRAINT chk_catalog_items_direction CHECK (direction IN ('sales', 'purchase'))
  `.execute(db);
  await sql`
    ALTER TABLE catalog_items
      DROP FOREIGN KEY fk_catalog_items_inv_asset,
      DROP FOREIGN KEY fk_catalog_items_cogs,
      DROP CHECK chk_catalog_items_item_type,
      DROP CHECK chk_catalog_items_costing_method,
      DROP COLUMN reorder_point_micros,
      DROP COLUMN default_cost_minor,
      DROP COLUMN costing_method,
      DROP COLUMN cogs_account_id,
      DROP COLUMN inventory_asset_account_id,
      DROP COLUMN item_type
  `.execute(db);
}
