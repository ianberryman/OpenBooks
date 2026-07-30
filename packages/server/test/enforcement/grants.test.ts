import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DB } from '../../src/db/generated';
import { APP_DB_USER, useTestDatabase } from '../db';

/**
 * The consolidated privilege matrix for `openbooks_app` (spec §12, gate **A6**).
 *
 * `test/db/harness.test.ts` proves the harness is honest — that the connection really
 * is `openbooks_app@%`, that `UPDATE`/`DELETE` on `journals` are refused with errno
 * 1142, and that the migrator is not similarly refused. This file is the *matrix*: one
 * row per table, four verbs per row, so the guarantee is legible as a whole and a
 * table that drifted out of its expected cell is named by the failure rather than
 * discovered later by a 500 in production.
 *
 * ## Why the statements are all no-ops
 *
 * Every probe carries a `WHERE 1 = 0` (or `SELECT … WHERE 1 = 0` for the insert).
 * MySQL resolves table privileges when it prepares the statement, before it matches
 * any row, so a refusal is a refusal and a success writes nothing. That is what makes
 * a uniform cross-product possible: the alternative — a valid fixture row for each of
 * fourteen tables and four verbs — would need fifty-six hand-built payloads whose
 * failures would mostly be about the payloads.
 *
 * ## Why the expectation is parsed out of the migration
 *
 * `0999_app_grants` does not export its lists, and restating them here would create a
 * second copy of the thing under test: the two would agree by construction and the
 * test would assert nothing. So the migration's source is read and its two arrays are
 * parsed, which makes this a comparison between the migration and the live server.
 * `parses the two grant lists out of 0999_app_grants` fails loudly if the parse ever
 * stops finding them, because an empty list would make every other test here vacuous.
 */
const db = useTestDatabase();

/** mysql2 errno for `ER_TABLEACCESS_DENIED_ERROR` — "command denied to user". */
const ACCESS_DENIED = 1142;

/** Kysely's own bookkeeping. Written by the migrator, never by the application. */
const MIGRATION_TABLES = ['kysely_migration', 'kysely_migration_lock'] as const;

/**
 * Empty, and that is the finding resolved.
 *
 * `permissions` used to sit here: its behaviour was right — the 51-row catalog is
 * fixed by spec §5 and the application must never write it — but right by *omission*
 * rather than declaration, which cost the migration its central signal. Its argument
 * is that its two lists partition the schema, so a table added without a grant
 * decision is visible; with an undeclared third category present, "not in either list"
 * no longer meant "somebody forgot".
 *
 * It is now in the migration's `APPEND_ONLY_TABLES`, so the partition is exhaustive
 * again. Kept as an empty constant rather than deleted so the next table that arrives
 * in this state has a documented place to be named, and so `accounts for every table
 * in the schema` keeps its four-way partition explicit.
 */
const APPEND_ONLY_BY_OMISSION: readonly string[] = [];

const GRANTS_MIGRATION = fileURLToPath(
  new URL('../../src/db/migrations/0999_app_grants.ts', import.meta.url),
);

/**
 * Reads a `const NAME = [...] as const` table list out of TypeScript source.
 *
 * Line comments are stripped before the quoted names are matched, because
 * `MUTABLE_TABLES` carries a paragraph of commentary inside its brackets and a stray
 * apostrophe in a future comment would otherwise be parsed as a table name. Throws
 * rather than returning an empty list: a silent miss here would turn every assertion
 * built on it into a tautology.
 */
function grantList(source: string, name: string): readonly string[] {
  const block = new RegExp(`const ${name} = \\[([^\\]]*)\\]`, 'u').exec(source);
  if (block?.[1] === undefined) {
    throw new Error(
      `Could not find "const ${name} = [...]" in ${GRANTS_MIGRATION}. This test compares the ` +
        'live grants against that list; if the migration was restructured, teach this parser ' +
        'about the new shape rather than restating the list here.',
    );
  }

  const tables = [...block[1].replaceAll(/\/\/[^\n]*/gu, '').matchAll(/'([a-z_]+)'/gu)].map(
    (match) => match[1] as string,
  );
  if (tables.length === 0) {
    throw new Error(`Parsed "${name}" out of ${GRANTS_MIGRATION} but it held no table names.`);
  }
  return tables;
}

// Read synchronously at module load because `it.each` needs its rows at collection
// time, and the lists have to come from the migration rather than from a literal.
const MIGRATION_SOURCE = readFileSync(GRANTS_MIGRATION, 'utf8');
const APPEND_ONLY_TABLES = grantList(MIGRATION_SOURCE, 'APPEND_ONLY_TABLES');
const MUTABLE_TABLES = grantList(MIGRATION_SOURCE, 'MUTABLE_TABLES');

type Verb = 'select' | 'insert' | 'update' | 'delete';
const VERBS: readonly Verb[] = ['select', 'insert', 'update', 'delete'];

/** `'permitted'`, or the errno the server refused with. */
type Outcome = 'permitted' | number;
type Row = Record<Verb, Outcome>;

const APPENDABLE: Row = {
  select: 'permitted',
  insert: 'permitted',
  update: ACCESS_DENIED,
  delete: ACCESS_DENIED,
};
const MUTABLE: Row = {
  select: 'permitted',
  insert: 'permitted',
  update: 'permitted',
  delete: 'permitted',
};

/**
 * Column names, one per table, discovered at run time.
 *
 * The update probe needs *some* column to assign, and reading one out of
 * `information_schema` rather than naming one per table means adding a table to the
 * migration's list is the only edit this suite needs.
 *
 * Generated columns are excluded, and that exclusion is load-bearing rather than
 * tidiness. MySQL refuses to write a generated column at all, with errno 3105
 * (ER_WRONG_VALUE_FOR_GENERATED_COLUMN) — which this suite would report as a *denial*,
 * so `idempotency_keys` read as append-only the moment `claim_scope` was added even
 * though its grants were untouched. A privilege probe that cannot tell "no grant" from
 * "not writable" is worse than no probe, because it fails in the safe-looking
 * direction.
 */
const columns = new Map<string, string>();

beforeAll(async () => {
  const { rows } = await sql<{ table_name: string; column_name: string }>`
    SELECT TABLE_NAME AS table_name, MIN(COLUMN_NAME) AS column_name
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ${db.info.database}
      AND EXTRA NOT LIKE '%GENERATED%'
    GROUP BY TABLE_NAME
  `.execute(db.migrator);

  for (const row of rows) columns.set(row.table_name, row.column_name);
});

function probe(table: string, verb: Verb): RawBuilder<unknown> {
  const column = columns.get(table);
  if (column === undefined) {
    throw new Error(`No such table as ${table} in the live schema; the parsed list is stale.`);
  }
  const name = sql.table(table);
  const field = sql.ref(column);

  switch (verb) {
    case 'select':
      return sql`SELECT ${field} FROM ${name} WHERE 1 = 0`;
    case 'insert':
      // `INSERT … SELECT` with a false predicate: the INSERT privilege is checked,
      // and no row is constructed, so no CHECK constraint or foreign key can turn a
      // privilege question into a data question.
      //
      // The column list is explicit rather than `SELECT *` for the same reason the
      // column above skips generated columns: `*` includes them, and naming one in an
      // INSERT is errno 3105 regardless of privilege.
      return sql`INSERT INTO ${name} (${field}) SELECT ${field} FROM ${name} WHERE 1 = 0`;
    case 'update':
      return sql`UPDATE ${name} SET ${field} = ${field} WHERE 1 = 0`;
    case 'delete':
      return sql`DELETE FROM ${name} WHERE 1 = 0`;
  }
}

async function outcome(db: Kysely<DB>, statement: RawBuilder<unknown>): Promise<Outcome> {
  try {
    await statement.execute(db);
    return 'permitted';
  } catch (error) {
    const errno = (error as { readonly errno?: unknown }).errno;
    // Anything that is not an errno is a bug in the probe, not a refusal, and must not
    // be reported as one — a typo'd statement would otherwise read as a denial.
    if (typeof errno !== 'number') throw error;
    return errno;
  }
}

async function rowFor(db: Kysely<DB>, table: string): Promise<Row> {
  const results = await Promise.all(VERBS.map(async (verb) => outcome(db, probe(table, verb))));
  return Object.fromEntries(VERBS.map((verb, index) => [verb, results[index]])) as Row;
}

describe('the privilege matrix, as openbooks_app', () => {
  it.each(APPEND_ONLY_TABLES)('makes %s append-only', async (table) => {
    const connection = await db.openAppConnection();
    try {
      expect(await rowFor(connection.db, table)).toEqual(APPENDABLE);
    } finally {
      await connection.close();
    }
  });

  // The declared guarantee for a table that holds it undeclared. See
  // APPEND_ONLY_BY_OMISSION: the behaviour is asserted so it cannot regress while the
  // classification is being fixed.
  it.each(APPEND_ONLY_BY_OMISSION)('makes %s append-only without saying so', async (table) => {
    const connection = await db.openAppConnection();
    try {
      expect(await rowFor(connection.db, table)).toEqual(APPENDABLE);
    } finally {
      await connection.close();
    }
  });

  it.each(MUTABLE_TABLES)('leaves %s fully mutable', async (table) => {
    const connection = await db.openAppConnection();
    try {
      expect(await rowFor(connection.db, table)).toEqual(MUTABLE);
    } finally {
      await connection.close();
    }
  });

  /**
   * The same statements as the migrator, which is what makes the rows above a
   * statement about *privileges* rather than about the probes.
   *
   * Without this, a typo that made every probe fail for some unrelated reason would
   * still produce the expected refusals on the journal tables.
   */
  it('refuses the app user what it grants the migrator', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      expect(await rowFor(db.migrator, table)).toEqual(MUTABLE);
    }
  });
});

/**
 * DDL, and the two statements that would let the app user grant itself out of the
 * matrix above.
 *
 * `TRUNCATE` is here rather than with the verbs because it is DDL in MySQL — it needs
 * `DROP`, drops and recreates the tablespace, and would empty a journal table without
 * ever issuing a `DELETE`. It is the obvious way around an append-only grant and so
 * the one most worth pinning.
 *
 * The `ALTER`/`DROP` probes name a table that does not exist. That is deliberate: the
 * privilege check happens before existence is resolved, so a refusal is 1142 and a
 * *success* is 1146 ("unknown table") — two distinguishable answers, and neither of
 * them destroys the schema the rest of the suite shares if this test ever starts
 * failing.
 */
describe('DDL and privilege escalation, as openbooks_app', () => {
  const statements: readonly { readonly name: string; readonly sql: RawBuilder<unknown> }[] = [
    { name: 'CREATE TABLE', sql: sql`CREATE TABLE enforcement_probe (id INT)` },
    { name: 'ALTER TABLE', sql: sql`ALTER TABLE enforcement_probe_absent ADD COLUMN c INT` },
    { name: 'DROP TABLE', sql: sql`DROP TABLE enforcement_probe_absent` },
    { name: 'CREATE INDEX', sql: sql`CREATE INDEX enforcement_probe_idx ON accounts (code)` },
    { name: 'TRUNCATE journals', sql: sql`TRUNCATE TABLE journals` },
    { name: 'TRUNCATE accounts', sql: sql`TRUNCATE TABLE accounts` },
    {
      name: 'GRANT',
      sql: sql.raw(`GRANT UPDATE ON \`openbooks\`.\`journals\` TO '${APP_DB_USER}'@'%'`),
    },
    { name: 'CREATE USER', sql: sql.raw("CREATE USER 'enforcement_probe'@'%'") },
  ];

  it('refuses every one of them', async () => {
    const connection = await db.openAppConnection();
    try {
      const results: Record<string, Outcome> = {};
      for (const statement of statements) {
        results[statement.name] = await outcome(connection.db, statement.sql);
      }

      // Asserted as one object rather than eight separate expectations so the failure
      // names which statement the app user was allowed to run, and shows the rest.
      expect(results).toEqual({
        'CREATE TABLE': ACCESS_DENIED,
        'ALTER TABLE': ACCESS_DENIED,
        'DROP TABLE': ACCESS_DENIED,
        'CREATE INDEX': ACCESS_DENIED,
        'TRUNCATE journals': ACCESS_DENIED,
        'TRUNCATE accounts': ACCESS_DENIED,
        // Refusing to grant itself `UPDATE` on `journals` is the same 1142 — the app
        // user holds no GRANT OPTION, so the privilege it would be passing on is the
        // one it does not have. `CREATE USER` is refused a level up, as
        // ER_SPECIFIC_ACCESS_DENIED_ERROR (1227), because it is a global privilege and
        // not a privilege on anything in this schema. Both pinned as the distinct
        // numbers they are: collapsing them into "some denial" would stop this
        // noticing if a bootstrap ever handed the app user GRANT OPTION and the
        // refusal moved to a different check — or stopped happening.
        GRANT: ACCESS_DENIED,
        'CREATE USER': 1227,
      });
    } finally {
      await connection.close();
    }
  });
});

/**
 * The converse, which is the half a matrix of known tables cannot cover: that a table
 * *missing* from the allowlist is caught.
 *
 * `0999_app_grants` says the maintenance consequence is a feature — "every future
 * migration that adds a mutable table must add it to a grants migration. Forgetting
 * means the new table is append-only, which surfaces as a loud failure the first time
 * something tries to update it." These two tests are where that failure becomes loud
 * *now* rather than at the first update in production.
 */
describe('the grant lists and the live server agree', () => {
  it('parses the two grant lists out of 0999_app_grants', () => {
    // The lists are the input to every other assertion in this file, so their shape is
    // checked rather than trusted: a parser that silently matched nothing would make
    // the matrix above pass with zero rows.
    // `permissions` joined this list when the omission above was resolved: the ledger
    // tables are append-only for immutability (spec §2.2), the catalog because only a
    // migration may change it (spec §5). Different reasons, same grant.
    // `journal_line_dimensions` is deliberately NOT here, and it is the one table
    // whose absence is a decision rather than an oversight: a tag names which slice of
    // the business an amount belongs to, not a term of the entry, so editing one moves
    // no total on any report — see the block in `0999_app_grants`. A table moving
    // *into* this list is a widening of immutability and fine; `journals` or
    // `journal_lines` moving *out* is the regression this literal exists to catch.
    // The three M4 additions widened it for a reason the ledger tables do not have:
    // each is a record of something that happened rather than a financial fact.
    // `bank_statement_lines` is criterion E2 and the one this literal now pins
    // hardest — D-42 says a statement line is what the bank said, and a statement
    // line that could be edited stops being evidence. `bank_line_clearings` and
    // `reconciliation_sessions` are deliberately in the mutable list beside them:
    // a clearing posts no journal (the `ar_allocations` argument) and a session's
    // `state` is the row the application takes `FOR UPDATE`.
    //
    // `bank_statement_imports` was here in wave 0 and moved to the mutable list in
    // OB-078: the async import (D-47/D-49) writes it `queued` before any line exists
    // and updates it to `complete`/`failed` when the worker finishes, which is an
    // UPDATE. The evidence argument survives the move because a re-import creates a new
    // row rather than editing an old one — so the line, not the import record, is where
    // E2's immutability lives.
    // `event_log` and `security_events` (OB-096) are the M5 additions: the
    // transactional outbox (D-56) and the credential issuance/revocation audit
    // (D-61), each append-only for the reason `reconciliation_session_events` is —
    // a row a subscriber or an auditor already read must never be rewritten.
    expect(APPEND_ONLY_TABLES).toEqual([
      'journals',
      'journal_lines',
      'permissions',
      'bank_statement_lines',
      'reconciliation_session_events',
      'invoice_deliveries',
      'dunning_sends',
      'event_log',
      'security_events',
      'predocument_deliveries',
      'period_close_events',
      'statement_packages',
      'automation_annotations',
    ]);
    expect(MUTABLE_TABLES).toContain('bank_statement_imports');
    expect(MUTABLE_TABLES).not.toContain('bank_statement_lines');
    expect(MUTABLE_TABLES.length).toBeGreaterThan(10);
    expect(MUTABLE_TABLES).not.toContain('journals');
    expect(MUTABLE_TABLES).not.toContain('journal_lines');
  });

  it('accounts for every table in the schema', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT TABLE_NAME AS table_name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ${db.info.database} AND TABLE_TYPE = 'BASE TABLE'
    `.execute(db.migrator);

    // A migration that adds a table and no grant fails here, naming the table. The
    // partition is exhaustive on purpose: "mutable, append-only, or the migrator's own
    // bookkeeping" are the only three things a table in this schema can be, and a
    // fourth category is a decision somebody has to make rather than a default.
    // `APPEND_ONLY_BY_OMISSION` is the one table currently in that fourth category and
    // is a finding, not a category — see its comment.
    expect(rows.map((row) => row.table_name).sort()).toEqual(
      [
        ...APPEND_ONLY_TABLES,
        ...APPEND_ONLY_BY_OMISSION,
        ...MUTABLE_TABLES,
        ...MIGRATION_TABLES,
      ].sort(),
    );
  });

  it('grants UPDATE and DELETE on exactly the mutable list', async () => {
    const connection = await db.openAppConnection();
    try {
      // Read from the app connection because a user may always read its own grants;
      // `0999_app_grants` explains at length why the migrator cannot, and why the
      // migration therefore does not verify its own outcome. This is that
      // verification, and the reason the migration is allowed not to do it.
      const { rows } = await sql<Record<string, string>>`SHOW GRANTS FOR CURRENT_USER()`.execute(
        connection.db,
      );
      // One unnamed column, titled after the user ("Grants for openbooks_app@%"), so
      // it is read positionally.
      const grants = rows.map((row) => Object.values(row)[0] ?? '');

      const granted = (privilege: string): readonly string[] =>
        grants
          .flatMap((grant) => {
            const match = /^GRANT ([A-Z, ]+) ON `openbooks`\.`([a-z_]+)`/u.exec(grant);
            if (match === null) return [];
            const [, privileges, table] = match;
            return privileges?.split(', ').includes(privilege) ? [table as string] : [];
          })
          .sort();

      expect(granted('UPDATE')).toEqual([...MUTABLE_TABLES].sort());
      expect(granted('DELETE')).toEqual([...MUTABLE_TABLES].sort());

      // And the schema-wide grant is read and append only — the reason journals are
      // insertable at all without appearing in any table-level grant.
      expect(grants).toContain('GRANT SELECT, INSERT ON `openbooks`.* TO `openbooks_app`@`%`');
    } finally {
      await connection.close();
    }
  });
});
