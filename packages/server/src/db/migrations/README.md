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

| File               | Contents                                          |
| ------------------ | ------------------------------------------------- |
| `0001_tenancy`     | Orgs, users, membership, roles, permissions, keys |
| `0002_ledger`      | Accounts, fiscal periods, journals, journal lines |
| `0003_idempotency` | Idempotency keys for every write endpoint         |
| `0004_app_grants`  | Narrows the app user so journals are append-only  |

Registration is static, in `index.ts` — not `FileMigrationProvider`. The server is
bundled into a single file (ROADMAP D-12), so there is no migrations directory in
the production image to read.

`down` migrations exist and are tested, but production rollback is a restore, not
a `down`. A `down` that drops `journals` is a data-loss event; treat these as a
development and test convenience.

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
