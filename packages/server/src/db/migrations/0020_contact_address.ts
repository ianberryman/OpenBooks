import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Contact postal address (bill/invoice view, "Seattle, WA, US"): six nullable
 * columns added to `contacts`.
 *
 * Six loose fields rather than one formatted string, for the reason
 * `contacts.city`/`region`/`country` are the ones a view actually needs
 * separately: "Seattle, WA, US" is `city`, `region`, `country` joined with no
 * access to `address_line1`/`address_line2`/`postal_code` at all, which a single
 * `address` blob would not let the view select out of. `address_line1` and
 * `address_line2` stay two columns rather than one multi-line one because that is
 * the shape every postal form already presents (a street line and a suite/unit
 * line), and collapsing them would ask the reader to re-split on a newline the
 * column offers no guarantee about.
 *
 * All six are nullable with no default, following the `notes`/`legal_name`
 * pattern already on this table (`0002_ledger`): a contact is created with none
 * of them, exactly as it is created today, and existing rows read back NULL —
 * this migration restates nothing about a row it does not touch.
 *
 * `0012_cash_application`'s header explains why an addition to `contacts` lives
 * in a numbered migration of its own rather than an in-place edit of
 * `0002_ledger`: D-15 permits in-place edits pre-release, but a plain
 * `ADD COLUMN` — no FK, no table that has to exist first — has no reason to
 * reach back into the table's own migration when appending here costs nothing.
 *
 * This is additive alone: no new grant (`contacts` is already in
 * `0999_app_grants`'s `MUTABLE_TABLES`), no tenancy change (`contacts` is
 * already in `TENANT_TABLES`), no new index — nothing here is filtered or
 * sorted on.
 */
export async function up(db: MigrationDb): Promise<void> {
  await sql`
    ALTER TABLE contacts
      ADD COLUMN address_line1 VARCHAR(256) NULL AFTER notes,
      ADD COLUMN address_line2 VARCHAR(256) NULL AFTER address_line1,
      ADD COLUMN city          VARCHAR(128) NULL AFTER address_line2,
      ADD COLUMN region        VARCHAR(128) NULL AFTER city,
      ADD COLUMN postal_code   VARCHAR(32)  NULL AFTER region,
      ADD COLUMN country       VARCHAR(64)  NULL AFTER postal_code
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`
    ALTER TABLE contacts
      DROP COLUMN address_line1,
      DROP COLUMN address_line2,
      DROP COLUMN city,
      DROP COLUMN region,
      DROP COLUMN postal_code,
      DROP COLUMN country
  `.execute(db);
}
