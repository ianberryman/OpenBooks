# CLAUDE.md

Working notes for OpenBooks. `ROADMAP.md` is the execution plan and the record of
decisions (`D-01` … `D-47`); the v1 Development Scope is the source of truth for intent.

**Read `ROADMAP.md`'s "Where things stand" section first.** It is the top of that file and
answers, in one place: which milestones are built, what the gate currently reports, that
the branch is unpushed, which three tickets are outstanding, and the environment quirks
that cost time to rediscover. The per-milestone Status sections below it carry the detail
and the acceptance criteria.

M1, M2 and M3 are built; M4 (banking) is scoped and not started.

## Commands

```bash
yarn check          # the gate: format, lint, lint:tokens, lint:deps, typecheck, drift, build, test
yarn test           # 1,300+ tests against real MySQL 8.4 via testcontainers (~2m)
yarn migrate        # OPENBOOKS_ROLE=migrate; needs DATABASE_MIGRATOR_* credentials
yarn codegen        # regenerate src/db/generated.ts from a live migrated database
yarn drift          # spec:check + client:check — both artifacts must match their source
yarn build          # esbuild server bundle + Vite web bundle
```

Two things about running the gate that waste a cycle if you don't know them. **`yarn check` is
`&&`-chained and its first step is `format:check` (`prettier --check .` over the whole repo)** — so a
single unformatted file **anywhere**, including one committed by an unrelated earlier change, halts the
gate before lint/typecheck/build/test ever run. If a `check` fails at format, `yarn format` and re-run.
And **never read a gate or test result through `… | tail`/`| grep`**: the pipe's exit code is `0` even
when the command failed, so a `vitest`/`yarn check` failure hides behind a `tail` that reports success —
redirect to a file and check `$?` (or read the file) when the exit code matters.

A third gate gotcha, learned the hard way: **`yarn lint` (`eslint .`, type-aware over the whole
monorepo) can exhaust Node's default heap and die with `Reached heap limit … out of memory`** — an
OOM, not a lint error. It halts `yarn check` at the lint step (~70s in, before typecheck/test) and
the background-task "exit 0" notification is _unreliable_ here (it reports the wrapper's code, not
eslint's — read the log). This is **environmental, not a code defect**: the baseline tree (changes
stashed) OOMs identically, so a few added files did not cause it. To get past it, either raise the
heap — `node --max-old-space-size=8192 node_modules/eslint/bin/eslint.js .` (invoke node directly;
`NODE_OPTIONS` does not reliably reach eslint through `yarn`) — or, to prove your _changes_ are
lint-clean without the whole-repo run, `./node_modules/.bin/eslint <your changed files>` (per-file
type-aware linting loads a far smaller program and does not OOM). Do the per-file lint as part of
integration regardless; it catches real rule violations (`switch-exhaustiveness-check`,
`no-circular`, unused `eslint-disable`) the OOM'd whole-repo run never reaches.

Yarn 4 is pinned in-repo at `.yarn/releases/`. Do not `corepack enable` — the committed
release exists so nothing needs the network. `enableScripts: false` is deliberate;
argon2 and esbuild resolve platform prebuilds at require time.

### Iterating on one layer without the full gate

- **One workspace's typecheck:** `cd packages/<w> && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`. (`yarn workspace <w> run typecheck` fails with `command not found: tsc` outside the full gate.)
- **One project's tests:** from the repo root, `./node_modules/.bin/vitest run --project server` (also `web`, `shared-types`, `eslint-plugin`). `server` uses testcontainers (~2m); the rest are fast/jsdom.
- A worktree-isolated subagent can't build, but a **non-worktree** subagent runs in the main tree and _can_ `tsc`/`vitest` — dispatch disjoint-path subagents there and have them self-verify.

### Regenerating artifacts after a schema or route change

Three artifacts are committed and gated by `yarn drift` / the schema tests. A schema change
needs `generated.ts` regenerated against a **live migrated DB**, which means a throwaway MySQL
(don't use the `:13307` prod stack; pick a fresh port):

```bash
docker run -d --name ob-codegen -e MYSQL_ROOT_PASSWORD=root -p 13399:3306 \
  -v "$PWD/docker/mysql-init":/docker-entrypoint-initdb.d:ro mysql:8.4   # creates both DB users
# passwords are literals in docker/mysql-init/01-users.sql (migrator=change-me-migrator, db=openbooks)
export OPENBOOKS_ROLE=migrate DATABASE_HOST=127.0.0.1 DATABASE_PORT=13399 DATABASE_NAME=openbooks \
  DATABASE_MIGRATOR_USER=openbooks_migrator DATABASE_MIGRATOR_PASSWORD=change-me-migrator \
  DATABASE_USER=openbooks_app DATABASE_PASSWORD=change-me-app \
  SESSION_SECRET=$(printf 'x%.0s' {1..48}) STORAGE_LOCAL_PATH=/tmp/ob-store \
  SECRETS_ENCRYPTION_KEY=$(printf 'x%.0s' {1..48}) EMAIL_FROM_ADDRESS=dev@example.com  # migrate refuses to boot without all four
yarn migrate && yarn codegen   # codegen reads only DATABASE_HOST/PORT/NAME/MIGRATOR_*
docker rm -f ob-codegen
```

**Iterating the throwaway DB:** a migration that fails is not recorded in `kysely_migration`, so
after fixing it just re-run `yarn migrate` against the **same** container — no teardown/recreate
needed. Two schema-authoring traps that each cost a re-run: a column named with a **MySQL reserved
word** (`cursor`, `rank`, …) fails `CREATE TABLE` with an opaque syntax error — prefix it
(`sync_cursor`), the way `bank_match_proposals.rank` is backquoted; and a **backtick inside a
`` sql`…` `` template literal — even in a `-- …` SQL comment** — closes the template and esbuild
fails to _parse_ the migration file, so keep SQL comments backtick-free.

A new `BIGINT`/`DATE` column also needs an entry in `scripts/codegen.mjs` (`OVERRIDES.columns`)
or the type silently disagrees with runtime. **Widening an existing `ENUM` in place still needs
`yarn codegen`** — `generated.ts` types an `ENUM` as a literal union, so a new member changes the
type — and it ripples into any hand-written repository row type that pinned the old union (e.g. a
`feed_source: 'file'` field). A **route** change instead needs the wire artifacts:
`yarn spec` (writes `openapi.json`; needs the same four app-config env vars as migrate, no DB)
then `yarn workspace @openbooks/web codegen` (→ `packages/web/src/api/schema.d.ts`).

The pinned tripwires a new table/route/permission must move are enumerated in the
`schema-and-route-tripwires` memory. A subagent that can't run the MySQL suite will typecheck-pass
with wrong count/list literals (permission-matrix "holds N codes", `routes.test.ts`, `resolution`),
so the orchestrator must run `--project server` and fix them regardless of the subagent's report.

## Non-negotiables

These are enforced by the build, not by convention. If you find yourself wanting to work
around one, that is the signal to stop and ask.

**Journals are append-only, at the database level.** The app connects as
`openbooks_app`, which holds no `UPDATE`/`DELETE` on `journals` or `journal_lines`.
Corrections are reversing entries carrying `reverses_journal_id` (D-02). There is no
column anywhere whose value changes after insert. A consequence that surprises people:
the app cannot `SELECT … FOR UPDATE` on journals either, because MySQL requires
`UPDATE`/`DELETE`/`LOCK TABLES` for a locking read — which is why the journal sequence
counter is its own table (D-14).

**Two database users.** `openbooks_migrator` has DDL and `GRANT OPTION`;
`openbooks_app` has read/append plus `UPDATE`/`DELETE` on an explicit allowlist. MySQL
cannot revoke a table privilege granted at schema level, so the privilege that must not
exist is never granted — see `0999_app_grants`, which explains it at length. The same
split is provisioned in Compose, testcontainers, and the RDS bootstrap, and
`infra/scripts/check-db-bootstrap-parity.sh` fails if they diverge.

**Money is `bigint` minor units end to end.** On the wire it is a **cents-only string**
(`"150000"`) — never a decimal, never a JSON number (D-13). `fromMinorString` rejects
`"1500.00"`. Display formatting is string manipulation; `cents / 100` in floating point
yields `1234.5599999999999`. `openbooks/no-float-money` is type-aware and will catch you.

**Tenant tables are only reachable through `tenantDb(orgId)`.** The raw Kysely handle
has no public name and a dependency-cruiser rule fails the build on any import around it.
An unscoped tenant query does not typecheck. `roles` is deliberately excluded from the
tenant set — its `org_id` is nullable and NULL means a shared system role, so a bare
equality would hide all six seeded roles. See `src/db/tenant-tables.ts`.

**Transactions propagate ambiently.** `tenantDb()` and `systemDb()` both join an open
transaction in the same async scope (`src/db/transaction-scope.ts`). This exists because
`withIdempotency(spec, () => postJournal(...))` otherwise produced two transactions on
two connections, and a rollback of one left the other committed.

**A cross-org read is indistinguishable from a nonexistent one.** 404, never 403.
`NotFoundError` takes a validated resource _token_ — no message, no details bag, no id
echo — so constructing one with a distinguishing string throws. `PermissionDeniedError`
takes only a permission key. `assertFound` is the single sanctioned zero-row conversion.

**Only `posting.repository.ts` may write journal tables**, enforced by
`openbooks/no-journal-writes`. Balance validation, the period lock, and actor provenance
all live above it, so a second write path skips all three.

**Transport holds no business logic.** Handlers map arguments. `requirePermission` is
service-layer only. Enforced by dependency-cruiser.

## Layout

```
packages/plugin-api     the internal module contract (spec §8), 0.x, unpublished
packages/shared-types   Zod schemas + the money primitive
packages/server         Fastify API, MCP server (M5), worker — one image, three roles
packages/web            React app — auth, chart, contacts, journals, sales, purchases,
                        money, reports, settings
packages/e2e            Playwright; one narrative per milestone, not a suite (D-26)
packages/eslint-plugin  the project-specific lint rules — no-float-money,
                        no-journal-writes, no-process-env, no-raw-color
infra/terraform         hosted topology, plan-clean, never applied
```

`src/db/migrations/README.md` is worth reading before touching the schema — it covers
the composite-key tenancy pattern, the UUID byte order, the codegen overrides that exist
because the generator maps `BIGINT` to `number` and `DATE` to `Date`, and the reset
procedure an in-place migration edit (D-15) forces on an already-migrated database.

**`0999_app_grants` runs last and must keep doing so.** MySQL refuses a table-level
`GRANT` on a table that does not exist, so every table it names is created before it.
`0999` is the ceiling of the four-digit prefix convention rather than a large gap, so
nothing following the convention can sort after it; a registry test asserts it.

## Conventions

- Extensionless imports (`moduleResolution: Bundler`). Never `./foo.js`.
- Strict TS with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`
  in `src`. `import type` for type-only imports.
- No `console.*` — use the logger, which attaches actor provenance automatically. No
  `process.env` outside `src/config/`.
- Zod is **v4**; check installed behaviour rather than assuming v3 idioms.
- Provider adapters (`packages/server/src/providers/*`) call their vendor over global `fetch`, **never
  a vendor SDK** — there is no `stripe`/`square` npm dependency (`enableScripts: false`, and the
  narrowest-surface rule); copy `providers/payment/stripe.ts`. A new provider interface type added to
  `packages/plugin-api/src/providers.ts` must also be re-exported from that package's `index.ts` barrel,
  or no consumer can import it.
- Prettier: 100 col, single quotes, semicolons, trailing commas.
- Pre-release, **migrations are edited in place** rather than appended to (D-15). This
  inverts permanently at first release.
- Migration prefixes are four digits, and `0999_app_grants` is the ceiling on purpose:
  MySQL refuses a `GRANT` on a table that does not exist, so the grants migration has
  to sort last, and nothing following the convention can sort after `0999`. A new
  subsystem gets its own file (`0005_subledger`); a new mutable table also gets a line
  in `MUTABLE_TABLES`.

## Comments

Comments explain _why_, citing the spec section or roadmap decision — not _what_. The
register to match: `src/db/migrations/0999_app_grants.ts`, `src/db/transaction-scope.ts`,
`src/modules/ledger/posting.service.ts`. Ordinary code gets no commentary. A decision
that took measuring to reach gets the measurement written down, so the next person does
not have to repeat it.

## Testing

Real MySQL 8 via testcontainers. **Never SQLite, never mocks** (spec §11). One container
for the suite; `useTestDatabase()` gives app and migrator handles plus factories, and
`openAppConnection()` gives a genuinely separate connection for concurrency work.

Two habits this project has earned the hard way:

**Prove contention, don't assume it.** Concurrency tests park one transaction mid-flight
and assert the other has not settled. A sequential simulation of a race passes against
code that has no locking at all.

**Mutation-test anything load-bearing.** Two mutations passed the entire example suite
and were caught only by property tests — including permuting accounts in a reversal
instead of swapping sides, which is _identical to correct_ on a two-line journal, and
two-line journals were all the example suite posted. A suite that has never failed is of
unknown value.

## CI

`.github/workflows/` — **`workflow_dispatch` only.** Automatic triggers are deliberately
commented out, not absent; uncommenting them is the whole change. Nothing runs until
someone starts it.

## Agents

Planning, design, and orchestration are an **Opus** agent's job. **Exploration and
coding-from-scope run as Sonnet subagents** the orchestrator dispatches. Opus owns the
scope, the seams, and integration; Sonnet executes against a spec. Match the model to the
task: read-only exploration can be the cheapest capable model, coding-from-scope is Sonnet,
and the loop that has to hold the whole picture stays Opus.

Best practices this split has earned:

- **Fix the seams before you fan out.** When parallelising a wave, the orchestrator pins
  the interface contracts first — exact field/column names, function signatures, token
  formats — so independently-authored streams compose. They will still diverge on details
  (a column width, a spelling); reconciling those is the orchestrator's integration step,
  not a subagent's.
- **Specs are self-contained.** A subagent gets the deliverable, the exact contract to
  match, and the convention exemplars to read first (point it at the analogous existing
  file). Ambiguity in the spec is wasted subagent work.
- **Subagents author; the orchestrator verifies.** A worktree-isolated subagent has no
  `node_modules`, so it cannot build or run the gate — it authors by matching existing code
  and self-reviews. The orchestrator integrates (cherry-pick the disjoint branches), runs
  `yarn check`, and fixes what the gate surfaces. Un-gated subagent output is unproven;
  the gate is where parallel work is proven.
- **A worktree branches from HEAD, not your working tree — so your uncommitted foundation is
  invisible to the streams.** When you fan out on top of an uncommitted trunk (a new migration,
  regenerated `generated.ts`, new shared-types contracts), the worktree subagents will not see any
  of it. Two things make this a non-issue, and you must do both: **paste the exact contract shapes
  into each spec** (the new Kysely row type, the wire schema field list, the service signatures) so
  the subagent authors against them without reading them from disk; and **keep every stream
  ADD-ONLY** (new files only, no edits to files the trunk touched) so cherry-picking their output
  into your tree is conflict-free. Reserve every shared/registry file (route index, `App.tsx`,
  `nav.ts`, the tripwire tests, `openapi.json`) for the orchestrator's own integration step.
- **The pinned MySQL tripwires a subagent can't run are more than a count.** Beyond the
  `schema-and-route-tripwires` memory's list, a new table/route this session had to move: `harness.test.ts`
  holds a **hardcoded ordered list of migration names** (not just a count) and `grants.test.ts` a
  **hardcoded `APPEND_ONLY_TABLES` `toEqual([...])`** — both need the new name inserted. A new **public
  (unauthenticated, token-gated) route** with an `operationId` must be added to _two_ coverage
  exemptions or both fail: `permission-matrix.test.ts`'s ungated-operations set and
  `cross-org.test.ts`'s `tokenGatedPublicOperations` set (mirror `getPublicInvoicePdf`). Finalise a
  route's path/shape **before** running `yarn spec`/`codegen` — changing it after means regenerating
  `openapi.json` + the web `schema.d.ts` again, and re-checking `yarn drift`.
- **Schema changes need the orchestrator's hand.** A subagent writes the migration and the
  `MUTABLE_TABLES`/`APPEND_ONLY_TABLES`/`TENANT_TABLES` entries but leaves `generated.ts` —
  codegen needs a live migrated database. Pre-release you cannot incrementally migrate an
  already-migrated DB (a new migration sorting before an applied one is refused), so codegen
  against a **throwaway** MySQL migrated fresh with the full set, never the running stack.
  The pinned schema-set tripwires (`harness`, `tenant-scope`, `grants` tests) then need the
  new table names — updating them is part of the change, not a failure.
- **A digit in a new table/permission name (`ten99`, `form_1099s`) breaks `[a-z_]`-only regexes,
  and there are at least three.** OB-228 hit all three: `grants.test.ts`'s source-parser (~L85) and
  its `SHOW GRANTS` read-back parser (~L413), and `permission-matrix.test.ts`'s literal-key scanner
  `LITERAL_KEY` (~L4722). Each silently dropped the digit-bearing identifier and failed a coverage
  check in a confusing way (a table present in the DB but "missing" from the grant set; a literal
  `'ten99.write'` misread as a "computed" key). Widen each to `[a-z0-9_]`. Prefer digit-free names
  where you can; when you can't, grep the test tree for `[a-z_]` identifier regexes first.
- **Records-producing `/v1/{id}` GET routes need a REAL owner-accessible fixture in the cross-org
  A7 scene** — `SEALED.ownerGetsNotFound` is `false`, so a placeholder id fails the control pass (a
  1099 run/form meant building payment→profile→generate in `scene()`). Placeholder ids only work for
  `permission-matrix` (its `judge()` distinguishes `permission_denied` alone). Separately, `cross-org-
references.test.ts` (B11) flags **every `*Id`/`*Ids`-suffixed body/query field as id-shaped —
  including a TIN field named `taxId`** — so each needs a SURFACES row or an `EXEMPT` reason.
- **New tables use `BINARY(16)` UUID ids + composite `(org_id, id)` FKs**, never a BIGINT surrogate;
  BIGINT is money-minor only. Closed sets are `VARCHAR + CHECK`, not `ENUM` (the `customer_statements.status`
  precedent — no `generated.ts` literal-union ripple). `VARBINARY`→`Buffer` needs no codegen override.
- **Web streams: type mutation bodies as `components['schemas']['…RequestInput']`, not the shared-types
  request type** — the latter's `.optional()` gives `| undefined`, which `exactOptionalPropertyTypes`
  refuses to pass to the client's `?: T | null` body param. (`@openbooks/shared-types` IS importable
  from web — it resolves via workspace hoisting with no `package.json` entry, contra a stale in-repo note.)
- **A new runtime helper that reads `getConfig()` breaks in the test harness**, which builds config
  explicitly rather than from `process.env` (so `getConfig()` is not a reliable source). Give it a
  settable seam (`setX`/clear in `beforeAll`/`afterAll`), the storage/email/secrets-provider idiom;
  `providers/index.ts` is the pattern.
- **The shell is zsh: unquoted `$VAR` does NOT word-split.** `eslint $FILES` sends the whole string as
  one path ("No files matching the pattern …"). Pass file lists inline as separate args, or use an
  array / `${=VAR}`.
