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

Yarn 4 is pinned in-repo at `.yarn/releases/`. Do not `corepack enable` — the committed
release exists so nothing needs the network. `enableScripts: false` is deliberate;
argon2 and esbuild resolve platform prebuilds at require time.

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
- **Schema changes need the orchestrator's hand.** A subagent writes the migration and the
  `MUTABLE_TABLES`/`APPEND_ONLY_TABLES`/`TENANT_TABLES` entries but leaves `generated.ts` —
  codegen needs a live migrated database. Pre-release you cannot incrementally migrate an
  already-migrated DB (a new migration sorting before an applied one is refused), so codegen
  against a **throwaway** MySQL migrated fresh with the full set, never the running stack.
  The pinned schema-set tripwires (`harness`, `tenant-scope`, `grants` tests) then need the
  new table names — updating them is part of the change, not a failure.
