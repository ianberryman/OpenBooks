# Server tests

Real MySQL 8 via testcontainers. Spec §11 is explicit that SQLite and mocks are not
acceptable substitutes, and the guarantees this milestone exists to prove — ledger
immutability at the grant level, composite-key tenancy, `CHECK` constraints — do not
exist anywhere except in MySQL.

## Using it

```ts
import { useTestDatabase } from './db/harness';

describe('something', () => {
  const db = useTestDatabase();

  it('works', async () => {
    const ledger = await db.factories.ledger();
    const journal = await db.factories.journal({ orgId: ledger.org.id });
    // ...
  });
});
```

`useTestDatabase()` registers the hooks and returns a handle that is live from the
first `beforeAll`. Its surface:

| Member                   | What it is                                                          |
| ------------------------ | ------------------------------------------------------------------- |
| `db.app`                 | `Kysely<DB>` as `openbooks_app` — the identity the application uses |
| `db.migrator`            | `Kysely<DB>` as `openbooks_migrator` — setup and cleanup only       |
| `db.factories`           | Typed factories, writing as the app user                            |
| `db.openAppConnection()` | An additional, genuinely separate app-user connection               |
| `db.reset()`             | Deletes every non-seed row (also runs before each test)             |
| `db.info`                | Host, port, database, and both users' credentials                   |

Prefer `db.app`. Reaching for `db.migrator` in a behavioural test quietly removes
the restriction the test is probably there to demonstrate.

### Factories

Each factory produces a valid row from no arguments, creating whatever parents it
needs, and accepts overrides:

```ts
await db.factories.journal(); // org, user, membership, period, two accounts, balanced entry
await db.factories.journal({ actorType: 'agent' }); // invocation_mode derived, per spec §6
await db.factories.fiscalPeriod({ status: 'closed' }); // closed_at set to satisfy the CHECK
await db.factories.orgMember({ role: 'bookkeeper' }); // resolved against the seeded system roles
```

Money is `bigint` minor units and `DATE` columns are `string`, matching
`src/db/generated.ts` — a `number` amount or a `Date` entry date will not typecheck.
UUIDs are `Buffer` in plain hex byte order; `uuidToBuffer` / `bufferToUuid` in
`db/uuid.ts` are the only correct conversion, and `db/uuid.test.ts` checks them
against MySQL's own `UUID_TO_BIN(x, 0)` rather than against each other.

The journal factory refuses to emit an unbalanced, one-sided, or
provenance-inconsistent entry. A test that wants a rejected posting should assert
against the posting service (OB-020), or write the row with raw SQL if it is
specifically testing the database's own constraints.

## How the container is provisioned

Two database users, exactly as in Compose (spec §12, gate A6):

- `openbooks_migrator` — all privileges on the schema **with `GRANT OPTION`**, which
  `0999_app_grants` needs in order to narrow the app user's privileges.
- `openbooks_app` — `SELECT` and `INSERT` schema-wide; `UPDATE` and `DELETE` per
  table, never on `journals` or `journal_lines`.

The harness does not restate that split. `db/bootstrap.ts` reads the actual
`docker/mysql-init/*.sql` files and `db/container.ts` copies them into the image's
`/docker-entrypoint-initdb.d`, which is the same mechanism Compose mounts them
through. Both passwords are parsed out of the same SQL. So there is no second copy
to drift, and the harness needs no entry in
`infra/scripts/check-db-bootstrap-parity.sh` — it has nothing to compare, because it
executes the canonical file rather than a copy of it.

Two deliberate differences from the hosted bootstrap, neither touching the grant
split: the container has no `REQUIRE SSL` (there is no TLS to require), and it sets
no `MYSQL_USER`. The second is why this uses `GenericContainer` rather than
`@testcontainers/mysql`'s `MySqlContainer`: that class always sets `MYSQL_USER`, and
the image's entrypoint answers it with `GRANT ALL ON <database>.*`, which would put a
third identity holding `UPDATE`/`DELETE` on `journals` into the very harness meant to
prove no such identity exists.

Migrations run through `migrate()` from `src/db/migrator.ts` — the real path, not a
hand-rolled schema. MySQL has no transactional DDL, so a migration that fails partway
leaves a half-applied schema that cannot be resumed; `test/setup/global-setup.ts`
says so explicitly and names the failing migration instead of retrying. For a
throwaway container the fix is to run the suite again.

### One container, and what that costs

`globalSetup` starts the container once for the whole project and passes connection
parameters to test files via `provide`/`inject`. Nothing else can own it: Vitest runs
each test file in its own process, so a container started from a test would be
started again for the next file.

Measured on a warm image (Docker Desktop, arm64):

| Step                                          | Time    |
| --------------------------------------------- | ------- |
| Container start (to both users usable)        | ~4.5s   |
| Migrations (all four)                         | ~70ms   |
| Everything else in the server suite           | ~0.6s   |
| **`vitest run --project server`, wall clock** | **~6s** |

The consequence to know about: `globalSetup` runs for every invocation of this
project, so the config, context, errors, and logging suites — none of which open a
connection — each pay the ~4.5s too. `vitest run --project server test/config` takes
~5.2s, of which ~4.5s is the container. That is acceptable while the suite is this
small and the container is this cheap, and it keeps `--project server` meaning "all
the server tests". If the DB-free suites grow or the container gets slower, split
them into their own Vitest project rather than trying to make `globalSetup`
conditional — it has no reliable view of which files were selected.

### If startup hangs

Testcontainers pulls `testcontainers/ryuk` (its cleanup sidecar) on first use, and
that pull goes through the Docker credential helper. On a machine where the helper
cannot reach Docker Hub this hangs rather than failing. Either pre-pull the image
once, or set `TESTCONTAINERS_RYUK_DISABLED=true` and rely on `globalTeardown` alone
to stop the container.

## Isolation: truncation, not transaction rollback

Every test starts from a database holding only the migration seeds. `reset()` deletes
all non-seed rows before each test — the 48-permission catalog and the six system
roles survive, custom roles do not.

Transaction-per-test with rollback would be cheaper and is the wrong tool here:

- The posting repository (OB-020) opens its own transaction. Nested inside a test
  transaction, its `COMMIT` becomes a savepoint release, so OB-017's idempotency
  guarantees — which are statements about real commit and rollback — would be
  asserted against semantics the production path never has.
- OB-026's concurrency cases need two connections that contend for the same locks
  and can see each other's committed rows. Rows written inside an uncommitted shared
  transaction are invisible to a second connection, so those races either cannot be
  set up or appear to pass having proved nothing.

The accepted costs are a per-test round trip per table (a few ms on empty tables) and
the requirement that test files not share the schema concurrently — already enforced
by `fileParallelism: false`.

Two implementation details worth knowing:

- The reset runs as **`openbooks_migrator`**, necessarily: the app user holds no
  `DELETE` on `journals`, which is the whole point of the split. It also holds no
  `DROP`, so `TRUNCATE` is unavailable to it either.
- Foreign key checks are disabled for the duration, because `journals` and `accounts`
  reference themselves (`reverses_journal_id`, `parent_account_id`) and InnoDB
  evaluates `RESTRICT` row by row — a single statement deleting both a row and its
  referent can fail on physical row order alone.

The table list is read from `information_schema` rather than hardcoded, so a
migration that adds a table does not silently start leaking rows between tests.

## What the smoke test pins

`db/harness.test.ts` exists because every claim in OB-025 and OB-026 rests on the
harness being what it appears to be. It asserts that the four migrations applied
through the real migrator, that the seeds are present, that the factories produce
rows satisfying the schema's constraints, that the reset isolates without destroying
seeds, and — the load-bearing one — that the connection is `openbooks_app@%` and that
`UPDATE` and `DELETE` on the journal tables are refused with `errno 1142` while
`INSERT` still succeeds and the same statements succeed as the migrator.

It also pins one non-obvious consequence of the grant split: MySQL requires
`SELECT` plus one of `UPDATE`/`DELETE`/`LOCK TABLES` for a locking read, so
`SELECT ... FOR UPDATE` on `journals` is **refused** to the app user. `FOR SHARE`
works, and `FOR UPDATE` on `fiscal_periods` works because that table is in the
mutable allowlist — which is what OB-020's period-lock path depends on.
