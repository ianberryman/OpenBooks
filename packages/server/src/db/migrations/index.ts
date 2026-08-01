// Kysely 0.29 moved the migration API out of the package root into this subpath.
import type { Migration, MigrationProvider } from 'kysely/migration';

import * as m0001 from './0001_tenancy';
import * as m0002 from './0002_ledger';
import * as m0003 from './0003_idempotency';
import * as m0005 from './0005_subledger';
import * as m0006 from './0006_banking';
import * as m0007 from './0007_invoice_delivery';
import * as m0008 from './0008_recurring_dunning';
import * as m0009 from './0009_bill_capture';
import * as m0010 from './0010_platform';
import * as m0011 from './0011_payment_processing';
import * as m0012 from './0012_cash_application';
import * as m0013 from './0013_pay_bills';
import * as m0014 from './0014_fixed_assets';
import * as m0015 from './0015_procure_to_pay';
import * as m0016 from './0016_budgets';
import * as m0017 from './0017_accountant_close';
import * as m0018 from './0018_automations';
import * as m0019 from './0019_catalog';
import * as m0020 from './0020_contact_address';
import * as m0021 from './0021_bank_feeds';
import * as m0999 from './0999_app_grants';

/**
 * The migration set, registered statically.
 *
 * Kysely ships `FileMigrationProvider`, which reads migration modules off disk at
 * runtime. That cannot work here: the server is bundled into a single file by
 * esbuild (ROADMAP D-12), so there is no migrations directory in the production
 * image to read. A static registry also means a migration that fails to compile
 * fails the build rather than the deploy.
 *
 * Keys are the migration names Kysely records in `kysely_migration`. They are
 * applied in lexicographic order, so the numeric prefix is load-bearing —
 * renaming an already-applied migration makes Kysely think it is new.
 *
 * ## Why the grants migration is numbered 0999
 *
 * `0999_app_grants` issues a table-level `GRANT` per mutable table, and MySQL
 * refuses one on a table that does not exist yet (ERROR 1146, measured on 8.4), so
 * every table it names must be created by a migration that sorts ahead of it.
 *
 * M2 satisfied that by construction — every table lived in `0002_ledger`, so there
 * was nothing to number around. M3 cannot: the subledger is its own subsystem
 * rather than a change to the ledger, and folding eleven more tables into
 * `0002_ledger` would make one file the whole schema. So the constraint is moved
 * into the *name*: `0999` is the largest four-digit prefix, and the convention here
 * is four digits, so nothing that follows the convention can sort after it. A gap
 * chosen for its size (`0099`, say) would only postpone the collision; a gap that is
 * the ceiling of the numbering scheme cannot be reached without abandoning the
 * scheme, which is a visible edit rather than a silent one.
 *
 * The rename cost is paid once and only pre-release: Kysely keys `kysely_migration`
 * by name, so a database migrated as `0999_app_grants` now holds a row naming a
 * migration this registry no longer has, and the migrator refuses to run. There is
 * nothing to repair — drop and recreate the schema, exactly as `README.md`'s reset
 * section already describes for any in-place edit (ROADMAP D-15). Nothing is
 * deployed, so no environment holds data this costs.
 */
export const MIGRATIONS: Record<string, Migration> = {
  '0001_tenancy': m0001,
  '0002_ledger': m0002,
  '0003_idempotency': m0003,
  '0005_subledger': m0005,
  '0006_banking': m0006,
  '0007_invoice_delivery': m0007,
  '0008_recurring_dunning': m0008,
  '0009_bill_capture': m0009,
  '0010_platform': m0010,
  '0011_payment_processing': m0011,
  '0012_cash_application': m0012,
  '0013_pay_bills': m0013,
  '0014_fixed_assets': m0014,
  '0015_procure_to_pay': m0015,
  '0016_budgets': m0016,
  '0017_accountant_close': m0017,
  '0018_automations': m0018,
  '0019_catalog': m0019,
  '0020_contact_address': m0020,
  '0021_bank_feeds': m0021,
  '0999_app_grants': m0999,
};

export class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(MIGRATIONS);
  }
}
