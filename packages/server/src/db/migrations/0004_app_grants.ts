import { sql } from 'kysely';
import type { MigrationDb } from './types';

/**
 * Narrows the application database user's privileges so that journals are
 * append-only at the database level (spec §12).
 *
 * ## Why this is a grant allowlist and not a REVOKE
 *
 * The obvious reading of spec §12 — "app DB user holds no UPDATE/DELETE grant on
 * journals or journal_lines" — suggests granting broadly and then revoking on two
 * tables. MySQL cannot do that. Privileges are additive across a hierarchy
 * (global → database → table → column) and a REVOKE can only remove a privilege
 * at the level it was granted. `GRANT UPDATE ON openbooks.*` followed by
 * `REVOKE UPDATE ON openbooks.journals` fails outright; there is no subtraction.
 *
 * So the app user gets `SELECT, INSERT` at the database level — safe for every
 * table, including journals, which must be insertable — and `UPDATE, DELETE`
 * table by table from an explicit allowlist. `journals` and `journal_lines`
 * simply never appear in it.
 *
 * ## The maintenance consequence, which is a feature
 *
 * Every future migration that adds a mutable table must add it to a grants
 * migration. Forgetting means the new table is append-only, which surfaces as a
 * loud failure the first time something tries to update it. The opposite default
 * — new tables mutable unless someone remembers to lock them down — is how the
 * guarantee erodes silently.
 *
 * ## Failing loudly on a missing user
 *
 * If the app user does not exist this migration fails and takes the deploy with
 * it. That is deliberate. A migration that skipped the grants on a misconfigured
 * database would produce exactly the outcome ROADMAP warns about: the
 * immutability test passing locally and meaning nothing in production.
 */

/**
 * Cross-environment contract. This same pair of users is provisioned by
 * `docker/mysql-init/` for Compose, by the testcontainers harness for the test
 * suite, and by the RDS bootstrap in `infra/terraform/`. The three must agree —
 * spec §11 requires the immutability test to run as the *app* user, so a
 * mismatch makes that test meaningless.
 */
const APP_DB_USER = 'openbooks_app';

/** Tables the application may never UPDATE or DELETE (spec §2.2, §12). */
const APPEND_ONLY_TABLES = ['journals', 'journal_lines'] as const;

/**
 * Tables the application may UPDATE and DELETE. Ordinary mutable state:
 * settings, membership, the chart of accounts, period status, session lifecycle.
 */
const MUTABLE_TABLES = [
  'users',
  'orgs',
  'roles',
  'role_permissions',
  'org_members',
  'org_invites',
  'api_keys',
  'sessions',
  'accounts',
  'fiscal_periods',
  'idempotency_keys',
  // The journal sequence counter must be updatable even though the journals it
  // numbers are not. This is the table the posting transaction locks, precisely
  // because it cannot lock `journals` — see the comment in 0002_ledger.
  'journal_sequences',
] as const;

export async function up(db: MigrationDb): Promise<void> {
  // Guards against a future edit adding a journal table to the mutable list.
  // Cheap, and the failure mode it prevents is silent loss of the core guarantee.
  const overlap = MUTABLE_TABLES.filter((table) =>
    (APPEND_ONLY_TABLES as readonly string[]).includes(table),
  );
  if (overlap.length > 0) {
    throw new Error(
      `Append-only tables must never be granted UPDATE/DELETE: ${overlap.join(', ')}. ` +
        'Journals are append-only and corrections are reversing entries (spec §2.2).',
    );
  }

  // Database-level read/append. Covers journals, which must be insertable.
  // GRANT is not parameterizable, so these are built without placeholders.
  await sql.raw(`GRANT SELECT, INSERT ON \`openbooks\`.* TO '${APP_DB_USER}'@'%'`).execute(db);

  for (const table of MUTABLE_TABLES) {
    await sql
      .raw(`GRANT UPDATE, DELETE ON \`openbooks\`.\`${table}\` TO '${APP_DB_USER}'@'%'`)
      .execute(db);
  }

  // No FLUSH PRIVILEGES. It is unnecessary — GRANT and REVOKE take effect at
  // once, and the flush is only needed after modifying the mysql.* grant tables
  // by hand — and it requires the global RELOAD privilege, which the migrator
  // deliberately does not have and which managed MySQL often will not grant at
  // all. Issuing it here would fail the migration on RDS.
  //
  // This migration deliberately does NOT verify its own outcome. The obvious
  // check — reading back information_schema.TABLE_PRIVILEGES — is worse than no
  // check at all: those views are filtered by the *querying* user's privileges,
  // and the migrator holds schema-level rights only, so it cannot see grants
  // belonging to another user. Measured against MySQL 8.4, the read-back returns
  // zero rows whether or not the grant is present, and `SHOW GRANTS FOR` and
  // `mysql.tables_priv` are both denied outright. A self-check that passes
  // unconditionally would report the guarantee as verified while proving nothing.
  //
  // The authority is the enforcement test in OB-026, which connects *as*
  // openbooks_app and asserts that UPDATE and DELETE on the journal tables are
  // refused. Spec §11 requires exactly that — tested as the app user, not as a
  // superuser — for this reason.
}

export async function down(db: MigrationDb): Promise<void> {
  for (const table of MUTABLE_TABLES) {
    await sql
      .raw(`REVOKE UPDATE, DELETE ON \`openbooks\`.\`${table}\` FROM '${APP_DB_USER}'@'%'`)
      .execute(db);
  }
  await sql.raw(`REVOKE SELECT, INSERT ON \`openbooks\`.* FROM '${APP_DB_USER}'@'%'`).execute(db);
}
