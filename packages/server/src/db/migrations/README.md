# Migrations

Ordered, forward-only-in-practice schema changes. Run as a discrete job
(`OPENBOOKS_ROLE=migrate`), never on container boot — spec §12.

## Conventions

**Raw SQL, not the schema builder.** The DDL here uses `sql` templates rather
than Kysely's `schema` builder. The schema depends on MySQL specifics the builder
expresses poorly or not at all — `BINARY(16)`, `DATETIME(3)`, `ENUM`, `CHECK`
constraints, composite foreign keys, and `REVOKE`. Raw DDL is also what a DBA or
an accountant's auditor will want to read.

**Two database users.** Migrations connect as `openbooks_migrator`, which needs
DDL rights plus `GRANT OPTION` so `0004` can narrow the application user's
privileges. The application connects as `openbooks_app` and never holds DDL
rights. See `docker/mysql-init/` for the Compose provisioning and
`infra/db-bootstrap/` for the hosted equivalent; the two must not diverge, or the
immutability guarantee holds only locally.

**UUIDs are `BINARY(16)`, plain byte order.** Client-facing identifiers are UUIDs
stored as `BINARY(16)` (spec §4). Conversion uses plain hex byte order —
`UUID_TO_BIN(x, 0)` in SQL, and a straight hex decode in application code. The
byte-swapping form (`UUID_TO_BIN(x, 1)`) exists to improve index locality for
time-ordered UUIDv1; these are random v4, so the swap would buy nothing and
would silently disagree with the application's encoding.

**`journal_lines.id` and `events.id` are `BIGINT AUTO_INCREMENT`.** Internal,
high-volume, never client-facing alone (spec §4). Everything else is a UUID.

**Money is `BIGINT` minor units.** No `DECIMAL`, no floats, anywhere (spec §12).

## Tenancy is enforced by composite foreign keys

Every tenant table carries `org_id`, and `org_id` leads every composite index
(spec §4). Beyond that, cross-org references are made _structurally impossible_
rather than merely checked in application code: tenant tables expose a
`UNIQUE (org_id, id)` key, and child rows reference the parent through it.

So `journal_lines` references `journals (org_id, journal_id)`, not
`journals (id)`. A line whose `org_id` disagrees with its journal's cannot be
inserted — the foreign key has nothing to point at. The same pattern ties
journal lines to accounts and journals to fiscal periods.

This matters because `journal_lines.org_id` is denormalized. Denormalized tenant
columns are usually a correctness risk; here the composite key removes the risk
instead of documenting it. Spec §11 requires a property test that
`journal_lines.org_id` matches its parent; that test should pass because the
schema cannot express a violation, not because the service layer remembers to
check.

## Ordering

| File               | Contents                                                     |
| ------------------ | ------------------------------------------------------------ |
| `0001_tenancy`     | Orgs, users, membership, roles, permissions, keys            |
| `0002_ledger`      | Accounts, contacts, dimensions, periods, journals, drafts    |
| `0003_idempotency` | Idempotency keys for every write endpoint                    |
| `0005_subledger`   | Tax rates, AR/AP documents, payments, allocations, sequences |
| `0006_banking`     | Bank accounts, statement import, matching, reconciliation    |
| `0999_app_grants`  | Narrows the app user so journals are append-only             |

The grants migration must run last. `0999_app_grants` issues a table-level `GRANT`
per mutable table and MySQL resolves the table name as it runs — it refuses a grant
on a table that does not exist (`ERROR 1146`, measured on 8.4) — so a table created
after it can never be granted.

**That is why the number is `0999`.** Kysely applies migrations in lexicographic
order, so "last" is a fact about the name and nothing else. `0999` is the largest
prefix the four-digit convention can express, so a migration that follows the
convention cannot sort after it; a merely large gap (`0099`) postpones the same
collision rather than removing it. Sorting last is now a property of the numbering
scheme instead of something each wave has to remember, which is what makes
`0005_subledger` possible at all — M2 had to dissolve three numbered migrations back
into `0002_ledger` to get around it.

`0004` is skipped and stays skipped. It is the number the grants migration used to
hold, and giving it to something else would make a single prefix mean two different
migrations in the project's history for no gain.

Adding a mutable table is still two edits: the table in whichever migration owns its
subsystem, and its name in `MUTABLE_TABLES` (or `APPEND_ONLY_TABLES`). A table in
neither list is caught by `test/enforcement/grants.test.ts`, which asserts the two
lists partition the live schema.

Registration is static, in `index.ts` — not `FileMigrationProvider`. The server is
bundled into a single file (ROADMAP D-12), so there is no migrations directory in
the production image to read.

`down` migrations exist and are tested, but production rollback is a restore, not
a `down`. A `down` that drops `journals` is a data-loss event; treat these as a
development and test convenience.

## Reset your local database after a migration is edited in place

**If you have a database migrated before OB-060, reset it now.** Kysely keys
`kysely_migration` by name, so renaming `0999_app_grants` to `0999_app_grants` leaves
that database holding a row for a migration this registry no longer contains, and the
migrator refuses to run rather than guessing. `yarn migrate:down` will not help — it
walks the same registry. Drop and recreate, per the SQL below, then `yarn migrate`.
Nothing is deployed (D-15), so this is the whole of the cost, and it is paid once.

Pre-release, migrations are edited rather than appended to (ROADMAP D-15), and the
same cost lands here in the ordinary case: a database migrated _before_ an edit is inconsistent with the code
_after_ it, and `down` is what discovers this. Adding a table to `MUTABLE_TABLES`
and running `yarn migrate:down` against a database migrated before the edit fails
with

```
There is no such grant defined for user 'openbooks_app' on host '%' on table '…'
```

because `down` revokes the list the code now holds, which includes a grant that
database never received. Worse, `GRANT`/`REVOKE` are not transactional in MySQL, so
the revokes issued before the failure stay revoked and a second `down` fails
somewhere earlier in the list.

There is nothing to repair and no reason to write a migration for it. Drop and
recreate the schema, then migrate up:

```sql
DROP DATABASE openbooks; CREATE DATABASE openbooks
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

The test suite never hits this — testcontainers builds a fresh database per run,
which is exactly why the failure only appears on a developer's long-lived local
stack. It disappears at first release, when migrations become append-only.

## MySQL cannot roll back DDL

There is no transactional DDL in MySQL. Every `CREATE TABLE` commits as it runs,
so a migration that fails halfway leaves the statements before the failure
applied while Kysely still records the migration as unexecuted. Re-running then
fails on "table already exists" rather than resuming.

Nothing in the runner can fix this — it is a property of the database. In
development, drop the schema and re-migrate. In production, a failed migration is
a restore-and-investigate event, which is the other reason migrations run as a
discrete pre-deploy job: the failure happens before any new application code is
serving traffic.

## Column type mappings the generator gets wrong

`generated.ts` is produced by `kysely-codegen` with the overrides in
`scripts/codegen.mjs`. Two defaults there are actively wrong for this schema and
are overridden:

- **`BIGINT` → `number`.** That is precision loss above 2^53 on the money columns
  and contradicts spec §12. The driver is configured with a `typeCast` that
  returns every `BIGINT` as a `bigint`, and the overrides make the types say so.
  Verified against MySQL 8.4: `2^53 + 1` round-trips exactly.
- **`DATE` → `Date`.** A calendar date has no timezone, and constructing a `Date`
  from one invents a moment — which is how an `entry_date` lands in the wrong
  fiscal period. `DATE` columns are read as strings; `DATETIME(3)` columns are
  genuine instants and keep their `Date` mapping.

Both exist so the generated types describe what the driver actually returns. If a
future migration adds a `BIGINT` or `DATE` column, add it to the override table —
otherwise the types will quietly disagree with runtime.
