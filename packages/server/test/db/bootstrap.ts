import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The container's database provisioning, taken from Compose rather than restated.
 *
 * ROADMAP names "the dual-DB-user requirement touches four environments" as a live
 * risk: if the test harness provisions its own idea of the two users, spec §12's
 * immutability guarantee is asserted against a fiction and A6 means nothing in
 * production. `docker/mysql-init/01-users.sql` says the same thing at more length.
 *
 * The mechanical answer taken here is to make divergence unrepresentable rather
 * than merely detectable: this module reads the actual `docker/mysql-init/*.sql`
 * files and the container runs them through the same
 * `/docker-entrypoint-initdb.d` mechanism Compose mounts them into. There is no
 * second copy of the grant split to drift, and no `CREATE USER` in TypeScript.
 *
 * The credentials are likewise parsed out of that SQL instead of hardcoded, so a
 * password change in Compose cannot leave the harness authenticating against a
 * password that no longer exists — which would present as a connection failure
 * during global setup, at best.
 */

const COMPOSE_INIT_DIR = fileURLToPath(new URL('../../../../docker/mysql-init/', import.meta.url));

/** Spec §12: DDL only. Needs GRANT OPTION so `0004_app_grants` can run. */
export const MIGRATOR_DB_USER = 'openbooks_migrator';

/** Spec §12: the application identity. No UPDATE/DELETE on the journal tables. */
export const APP_DB_USER = 'openbooks_app';

/** Fixed product constant, not a variable — see `infra/db-bootstrap/02-grants.sql`. */
export const DATABASE_NAME = 'openbooks';

export interface InitScript {
  readonly name: string;
  readonly contents: string;
}

export interface BootstrapSql {
  /** In the lexicographic order MySQL's entrypoint runs them. */
  readonly scripts: readonly InitScript[];
  readonly migratorPassword: string;
  readonly appPassword: string;
}

export function readComposeBootstrapSql(): BootstrapSql {
  const scripts = readInitScripts();
  const combined = scripts.map((script) => script.contents).join('\n');

  return {
    scripts,
    migratorPassword: extractPassword(combined, MIGRATOR_DB_USER),
    appPassword: extractPassword(combined, APP_DB_USER),
  };
}

function readInitScripts(): readonly InitScript[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(COMPOSE_INIT_DIR);
  } catch (cause) {
    throw new Error(
      `Cannot read the Compose database init scripts at ${COMPOSE_INIT_DIR}. The test ` +
        'harness provisions its container from those files so the two cannot diverge ' +
        '(spec §12, ROADMAP "the dual-DB-user requirement touches four environments").',
      { cause },
    );
  }

  const scripts = entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, contents: readFileSync(join(COMPOSE_INIT_DIR, name), 'utf8') }));

  if (scripts.length === 0) {
    throw new Error(
      `No *.sql files in ${COMPOSE_INIT_DIR}. Without them the container has neither ` +
        `'${MIGRATOR_DB_USER}' nor '${APP_DB_USER}', and every grant-level assertion in ` +
        'the suite would be vacuous.',
    );
  }

  return scripts;
}

/**
 * Pulls the literal password out of the `CREATE USER` that provisions `user`.
 *
 * Compose has to use literals — MySQL's entrypoint does not expand environment
 * variables inside `*.sql` — which is what makes this parseable at all. The
 * hosted equivalent in `infra/db-bootstrap/01-users-rds.sql` uses shell
 * placeholders and is deliberately not shared with Compose; only the grant split
 * is.
 */
function extractPassword(sql: string, user: string): string {
  // `[^;]` spans newlines, so this tolerates the statement being wrapped.
  const pattern = new RegExp(`CREATE USER[^;]*'${user}'@'%'[^;]*IDENTIFIED BY '([^']*)'`, 'i');
  const password = pattern.exec(sql)?.[1];

  if (password === undefined || password === '') {
    throw new Error(
      `No 'CREATE USER ... '${user}'@'%' IDENTIFIED BY '<password>'' found in ` +
        `${COMPOSE_INIT_DIR}. The harness derives both users' credentials from the ` +
        'Compose init scripts on purpose; if that provisioning moved, point this module ' +
        'at its new home rather than hardcoding a password here.',
    );
  }

  return password;
}
