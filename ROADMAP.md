# OpenBooks — Development Roadmap

Derived from `OpenBooks — v1 Development Scope`. This file is the execution plan; the spec
remains the source of truth for intent. Where this roadmap deviates from the spec, the
deviation is recorded in [Decisions](#decisions) with a reason.

---

## Milestone map

| Milestone | Spec phase | Outcome                                                                                                | Status                        |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **M1**    | Phase 0    | Walking skeleton — tenancy, session auth, ledger kernel, trial balance, invariant tests, Docker/CI/IaC | **Scoped, awaiting approval** |
| M2        | Phase 1    | Manual bookkeeping usable — CoA, contacts, dimensions, JE UI, P&L / BS / GL                            | Not scoped                    |
| M3        | Phase 2    | AR/AP — invoices, bills, credit notes, payment application, tax, aging                                 | Not scoped                    |
| M4        | Phase 3    | Banking — import, matching pipeline, reconciliation _(largest phase)_                                  | Not scoped                    |
| M5        | Phase 4    | Platform surface — OAuth AS, MCP tools, event bus, change feed, `external_refs`                        | Not scoped                    |
| M6        | Phase 5    | Automations — workflow engine, dry run, activation flow                                                | Not scoped                    |
| M7        | Phase 6    | Launch readiness — QB import, onboarding, export, docs, published spec                                 | Not scoped                    |

Minimum credible public launch is M1–M4 plus QuickBooks import.

---

## Milestone 1 — Walking skeleton

### Definition of done

Every item below is verified by an automated test in CI, not by inspection.

| #   | Acceptance criterion (spec Phase 0)                  | Verified by    |
| --- | ---------------------------------------------------- | -------------- |
| A1  | Post a manual balanced journal via REST              | OB-023, OB-026 |
| A2  | Trial balance balances                               | OB-021, OB-025 |
| A3  | Unbalanced posting rejected                          | OB-020, OB-026 |
| A4  | Posting to a locked period rejected                  | OB-019, OB-026 |
| A5  | A query without org scope is impossible to construct | OB-013, OB-026 |

Additional gates carried from spec §11–§12 that apply from Phase 0:

| #   | Gate                                                                                    | Verified by    |
| --- | --------------------------------------------------------------------------------------- | -------------- |
| A6  | `UPDATE`/`DELETE` on `journals` fails at the DB grant level, tested as the **app** user | OB-011, OB-026 |
| A7  | Cross-org read returns nothing and does not leak existence                              | OB-013, OB-026 |
| A8  | Duplicate idempotency key yields exactly one journal                                    | OB-017, OB-026 |
| A9  | Posting racing a period lock leaves no half-written journal                             | OB-020, OB-026 |
| A10 | OpenAPI spec drift is a build failure                                                   | OB-022, OB-027 |
| A11 | No float arithmetic on money paths (lint-enforced)                                      | OB-005, OB-027 |
| A12 | Migrations run as a discrete job, never on container boot                               | OB-004, OB-008 |
| A13 | Structured logs carry actor provenance                                                  | OB-009         |

### Explicitly out of M1

Deferred to the milestone that first needs them, to keep the kernel boring:

- Chart-of-accounts templates, contacts, dimensions (M2)
- Any React screens — `packages/web` is a building shell only (M2)
- API-key and OAuth authentication; `oauth_*` tables (M5). `api_keys` **table** ships in M1 per spec §7, unused.
- Hosted implementations of `QueueProvider` / `StorageProvider` / `EmailProvider`. Interfaces and
  env-driven selection ship in M1; concrete adapters ship with their first consumer. See [D-07](#d-07).
- Subledger-agreement property tests — no subledger exists until M3.
- Any AWS `terraform apply`. IaC is written and `plan`-clean only. See [D-05](#d-05).
- Custom roles, agent/automation actor paths (schema supports both from M1; no code paths).

---

## Architecture commitments established in M1

These are the structural decisions M1 exists to lock in. Everything after M1 inherits them.

**One image, three roles.** A single Docker image; `OPENBOOKS_ROLE=api|worker|migrate` selects the
entrypoint. This satisfies spec §2.5 (same image everywhere) and §12 (migrations as a discrete
pre-deploy job) with one mechanism instead of two. The `worker` role exists and starts cleanly in M1
with no registered jobs.

**`plugin-api` from the first commit.** Per spec §8, every module is written against
`@openbooks/plugin-api` only. The ledger kernel is the one module that _implements_ rather than
consumes the posting contract; everything else consumes. Package stays `0.x` and unpublished.

**Two database users.** `openbooks_migrator` holds DDL rights. `openbooks_app` holds
`SELECT`/`INSERT` on everything and is explicitly denied `UPDATE`/`DELETE` on `journals` and
`journal_lines`. The application only ever connects as `openbooks_app`, so immutability is enforced
by the database rather than by discipline. Provisioned identically in Compose, testcontainers, and
(in M5+) RDS bootstrap.

**Immutability without mutation.** Reversal is recorded as `reverses_journal_id` on the _reversing_
journal, written at insert. Nothing ever writes to an existing journal row — there is no column
anywhere whose value changes after insert. See [D-02](#d-02).

**Org scope is unreachable-by-default, not remembered.** `packages/server/src/db/` exports
`tenantDb(ctx)` and `systemDb` and nothing else. The raw Kysely instance is module-private. The
tenant wrapper's generic parameter accepts only keys of `TenantTables`, so a tenant-table query
without scope does not typecheck. An import-boundary rule fails the build if any file outside
`db/` imports past the wrapper. See [D-01](#d-01) for the precise guarantee and its limits.

---

## Ticket board

27 tickets across 8 waves. Sizes are relative: **S** ≈ one focused change, **M** ≈ a coherent
subsystem, **L** ≈ a subsystem with non-trivial design or test surface.

Tickets in the same wave have no dependency on each other and are intended to run in parallel.

### Wave 0 — Baseline

| ID         | Title                           | Size |
| ---------- | ------------------------------- | ---- |
| **OB-001** | Clean slate + monorepo skeleton | L    |

**OB-001** — Commit removal of the legacy GraphQL/Sequelize tree in a single clean-slate commit,
preserving `.gitignore`, `.dockerignore`, `.github/`. Stand up Yarn 4 workspaces with
`packages/{server,web,shared-types,plugin-api,eslint-plugin}`. Strict TypeScript base config
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Replace the legacy
`.eslintrc.json` with a flat config matching the current stack. Prettier, Vitest projects config,
dependency-cruiser boundaries, `.editorconfig`, `.nvmrc`. Root scripts: `lint`, `lint:deps`,
`typecheck`, `test`, `build`, `migrate`, `codegen`, `spec`, `check`.
_Blocks everything._

### Wave 1 — Foundations (6 parallel)

| ID         | Title                                                       | Size | Depends on |
| ---------- | ----------------------------------------------------------- | ---- | ---------- |
| **OB-002** | `@openbooks/plugin-api` 0.x contract package                | M    | 001        |
| **OB-003** | Config module + provider abstraction + fail-fast validation | M    | 001        |
| **OB-004** | Docker image, Compose stack, dual DB users                  | M    | 001        |
| **OB-005** | Money primitives + no-float lint rule                       | S    | 001        |
| **OB-006** | Licensing and README                                        | S    | 001        |
| **OB-007** | Terraform IaC for the hosted stack                          | L    | 001        |

**OB-002** — Define the internal module contract per spec §8: posting API, event bus, service
registry, migration hooks, permission registration, MCP tool registration, route registration,
provider interfaces. Types and interfaces only — no implementations. Event payload types carry
their version in the name (`invoice.created.v1`). Published as Apache-2.0 with a linking exception.
Marked `0.x`, explicitly unstable, `private: true`.

**OB-003** — Zod-validated environment schema resolved once at startup. Selects each provider by
env var and fails fast with a precise message naming the missing variables when a selected
provider's requirements are unmet. Exposes a typed, frozen config object; no module reads
`process.env` directly (lint-enforced).

**OB-004** — Multi-stage Dockerfile producing one image with the role-selecting entrypoint. Compose
stack: MySQL 8, a `migrate` service that runs to completion, and an `api` service that depends on
the migrate service having exited zero. Init SQL creates both DB users with the grant split
described above. Verified locally end to end — this is the environment M1's acceptance criteria are
demonstrated in.

**OB-005** — `Money` as a branded `bigint` of minor units, with parse/format at the boundary only.
ESLint rule banning arithmetic operators and `Math.*` on money-typed paths, plus banning `number`
in any money position. Rounding helper with a single documented application point.

**OB-006** — AGPL-3.0 `LICENSE` for the server. Apache-2.0 with linking exception for
`packages/plugin-api` and the published OpenAPI spec. CLA text and `CONTRIBUTING.md` — spec §9
requires this decided before the first outside PR, so it lands now rather than at M7. README
covering the self-host Compose quickstart.

**OB-007** — Terraform for Route53 → CloudFront (static) / ALB → Fargate (api + worker) → RDS MySQL,
plus ECR, SQS, S3, Secrets Manager, SES. Remote state config. Reviewed via `terraform validate`
and a `plan` against no real account; **not applied**. Includes the RDS bootstrap that creates the
two DB users, so the grant split is not a local-only artifact.

### Wave 2 — Persistence plumbing

| ID         | Title                                                    | Size | Depends on |
| ---------- | -------------------------------------------------------- | ---- | ---------- |
| **OB-008** | Migration runner + kysely-codegen pipeline + drift check | M    | 003, 004   |
| **OB-009** | Request context, structured logging, error model         | M    | 002, 003   |

**OB-008** — Kysely migrator driven by a CLI entrypoint (the `migrate` role), connecting as
`openbooks_migrator`. `kysely-codegen` generates `packages/server/src/db/generated.ts`, which is
committed. CI regenerates against a fresh migrated database and fails on any diff, so schema and
types cannot drift.

**OB-009** — `AsyncLocalStorage`-backed request context carrying `{ requestId, userId, orgId,
roleId, actorType, invocationMode }`. Structured JSON logging (pino) with actor provenance on every
line from the first commit, per spec §12. Typed error hierarchy mapping cleanly to HTTP status and
a stable machine-readable error code, with a redaction rule so cross-org lookups produce
`404` and never a distinguishable `403` (supports A7).

### Wave 3 — Schema (3 parallel)

| ID         | Title                                      | Size | Depends on |
| ---------- | ------------------------------------------ | ---- | ---------- |
| **OB-010** | DDL: tenancy, permissions, sessions, seeds | M    | 008        |
| **OB-011** | DDL: ledger kernel + immutability grants   | M    | 008        |
| **OB-012** | DDL: idempotency keys                      | S    | 008        |

**OB-010** — `orgs`, `users`, `org_members`, `org_invites`, `permissions`, `roles`,
`role_permissions`, `api_keys`, and `sessions` ([D-03](#d-03)). UUID `BINARY(16)` for all
client-facing IDs. `org_id` as the leading column of every composite index on a tenant table.
Seeds the fixed permission catalog and the six system roles: Owner, Bookkeeper, AP-only, AR-only,
Read-only/Accountant, Approver.

**OB-011** — `accounts`, `fiscal_periods`, `journals`, `journal_lines`. `journals.actor_type` /
`actor_id` / `invocation_mode` present from M1 per spec §6, plus `reverses_journal_id`.
`journal_lines.id` is `BIGINT AUTO_INCREMENT`; `journal_lines.org_id` is denormalized and
constrained to match its parent. Money columns are `BIGINT`. Migration revokes `UPDATE` and
`DELETE` on both journal tables from `openbooks_app`.

**OB-012** — `idempotency_keys` scoped by `(org_id, key)` with the stored response and a request
fingerprint, so a replay with the same key but a different body is a conflict rather than a silent
success. See [D-04](#d-04).

### Wave 4 — Data access and test harness

| ID         | Title                                                     | Size | Depends on    |
| ---------- | --------------------------------------------------------- | ---- | ------------- |
| **OB-013** | Org-scoped Kysely wrapper + unscoped-query impossibility  | L    | 010, 011      |
| **OB-014** | Test infrastructure: testcontainers, dual-user, factories | M    | 008, 010, 011 |

**OB-013** — The centerpiece of A5 and A7. Module-private Kysely instance; `tenantDb(ctx)` returns
a wrapper whose query builders are typed to `keyof TenantTables` and inject
`where org_id = ctx.orgId` on every select, insert, update, and delete. `systemDb` covers the
non-tenant tables. Includes a compile-failure test asserting the raw handle is not reachable, and
a `dependency-cruiser` rule failing the build on any import that bypasses the wrapper.

**OB-014** — Real MySQL 8 via testcontainers, never SQLite or mocks (spec §11). The container
provisions both DB users so grant-level tests are meaningful. Per-test transactional isolation,
typed factories for orgs/users/accounts/periods/journals, and a helper that opens a second
connection as `openbooks_app` for the immutability assertions.

### Wave 5 — Domain services (5 parallel)

| ID         | Title                                                | Size | Depends on |
| ---------- | ---------------------------------------------------- | ---- | ---------- |
| **OB-015** | Session auth, org membership, org switch             | L    | 013, 009   |
| **OB-016** | Permission catalog + `requirePermission` enforcement | M    | 013, 010   |
| **OB-017** | Idempotency service                                  | M    | 013, 012   |
| **OB-018** | Accounts service                                     | M    | 013, 016   |
| **OB-019** | Fiscal periods service                               | S    | 013, 016   |

**OB-015** — Register, login, logout, `me`. Argon2id password hashing ([D-06](#d-06)). Opaque
session tokens stored hashed, `HttpOnly` / `Secure` / `SameSite=Lax` cookie. Resolves the
`org_members` many-to-many so one login holds distinct roles across orgs, and an explicit org-switch
operation that re-derives context. Org creation, with the creating user seeded as Owner.

**OB-016** — Fixed permission catalog as a typed union. `requirePermission(ctx, 'invoices.write')`
callable from the service layer only, lint-enforced — transport adapters hold zero authorization
logic (spec §2.4, §5). Per-request memoized role→permission resolution.

**OB-017** — Wraps any write in idempotent execution: claim the key, run inside the same
transaction as the write, persist the response. A replay returns the original response without
re-executing. Fingerprint mismatch on the same key is a `409`. Applies to **every** write endpoint,
not just posting (spec §12).

**OB-018** — Account CRUD with type (asset/liability/equity/revenue/expense), normal balance, and
active flag. Deliberately minimal — templates and hierarchy are M2. Accounts referenced by a
posting cannot be deleted, only deactivated.

**OB-019** — Period create/list/close/reopen with `open`/`closed` status ([D-08](#d-08)). Exposes
the `assertPostable(date)` check the posting repository calls, which is the mechanism behind A4.

### Wave 6 — Ledger kernel

| ID         | Title                                                | Size | Depends on              |
| ---------- | ---------------------------------------------------- | ---- | ----------------------- |
| **OB-020** | Posting repository: `postJournal` / `reverseJournal` | L    | 016, 017, 018, 019, 005 |
| **OB-021** | Trial balance report service                         | S    | 020                     |

**OB-020** — The single write path to `journals` and `journal_lines`; nothing else in the codebase
may insert into them (lint-enforced). Validates: balanced debits and credits, at least two lines,
no one-sided line, every account exists and is active and same-org, period open, actor provenance
present. Runs inside one transaction with the period-lock check taken under a lock, so a posting
racing a lock either commits fully or not at all (A9). `reverseJournal` emits a new journal with
inverted lines and `reverses_journal_id` set. Interface is declared in `plugin-api`; this is its
sole implementation.

**OB-021** — Trial balance as a direct aggregation over `journal_lines` grouped by account. No
balance cache and no denormalized totals in M1 — correctness first, per spec §2.6. Returns debit
and credit totals per account plus the org-wide totals that must be equal.

### Wave 7 — Transport

| ID         | Title                                                             | Size | Depends on    |
| ---------- | ----------------------------------------------------------------- | ---- | ------------- |
| **OB-022** | Fastify app + Zod type provider + OpenAPI artifact and drift gate | M    | 009, 003      |
| **OB-023** | `/v1` route surface                                               | M    | 020, 021, 022 |
| **OB-024** | Web package scaffold + generated typed client                     | S    | 022           |

OB-022 has no dependency on Wave 5 or 6 and can start alongside Wave 5.

**OB-022** — Fastify with `fastify-type-provider-zod` and `@fastify/swagger`. Zod schemas live in
`packages/shared-types` as the single source of validation, types, and spec (spec §3). Spec emitted
to a committed `openapi.json`; CI regenerates and fails on diff (A10). Request-context,
logging, error-mapping, and idempotency plugins registered here.

**OB-023** — `/v1` routes for auth, orgs and org switch, accounts, fiscal periods, journals
(post and reverse), and `reports/trial-balance`. Every write endpoint requires an
`Idempotency-Key` header. Handlers do argument mapping and nothing else — no validation logic, no
authorization logic, no queries.

**OB-024** — Vite + React + React Router shell that builds in CI, with the typed client generated
from `openapi.json` and TanStack Query configured. No screens (see [Out of M1](#explicitly-out-of-m1));
this exists so the generated-client pipeline is proven and M2 starts on rails.

### Wave 8 — Verification and delivery

| ID         | Title                                  | Size | Depends on    |
| ---------- | -------------------------------------- | ---- | ------------- |
| **OB-025** | Property test suite (fast-check)       | L    | 020, 021, 014 |
| **OB-026** | Enforcement and concurrency test suite | M    | 023, 014, 015 |
| **OB-027** | GitHub Actions CI                      | M    | all           |

**OB-025** — The spec §11 invariants that have meaning at Phase 0, written with fast-check against
real MySQL: journal balance; org-wide debits equal credits; the accounting equation; no one-sided
lines; `journal_lines.org_id` matches parent; journal plus reversal nets to zero per account;
posting-order independence. Subledger agreement is deferred to M3 with no subledger to agree with.

**OB-026** — Enforcement: unbalanced journal rejected; locked-period posting rejected;
`UPDATE`/`DELETE` on journals fails as `openbooks_app`; unscoped tenant query fails to compile;
cross-org read returns nothing without leaking existence. Concurrency: duplicate idempotency key
yields one journal; posting racing a period lock leaves nothing half-written. Plus the end-to-end
REST narrative behind A1 and A2.

**OB-027** — GitHub Actions ([D-09](#d-09)): lint → typecheck → test (testcontainers on a
Docker-enabled runner) → build → schema-and-spec drift checks → publish `openapi.json` as an
artifact → build and push the image to ECR on merge to `develop`. Terraform `validate` and `plan`
run as a non-blocking job until credentials exist.

---

## Parallelization plan

```
Wave 0   OB-001
              │
Wave 1   ┌────┼────┬────┬────┬────┐
         002  003  004  005  006  007
              │    │
Wave 2        └──┬─┘         009 (needs 002, 003)
                 008
                 │
Wave 3   ┌───────┼───────┐
         010    011     012
         └───┬───┘       │
Wave 4     013 ────── 014
             │
Wave 5   ┌───┼───┬───┬───┐          022 (needs 009, 003 — starts here)
         015 016 017 018 019
                 └───┬───┘
Wave 6            020 ── 021
                        │
Wave 7            023 ──┴── 024
                   │
Wave 8      025 ── 026
                   │
                  027
```

Critical path: **001 → 003/004 → 008 → 010/011 → 013 → 016 → 020 → 023 → 026 → 027**.
OB-013 and OB-020 are the two tickets most likely to expand; both are design-heavy and carry the
milestone's hardest guarantees.

Wave 1 is the widest parallel band (six independent tickets). OB-006 and OB-007 are fully
independent of the application code and can run at any point.

---

## Decisions

Choices made while scoping. Each is reversible; flag any you want changed before implementation.

<a id="d-01"></a>
**D-01 — The org-scope guarantee, stated precisely.** Spec Phase 0 says a query without org scope
must be "impossible to construct." That is achievable for tenant tables and I'll deliver it at the
type level. It is not achievable universally: `users`, `permissions`, `roles`, and the migration
table are not org-scoped, so an unscoped handle must exist somewhere. The guarantee M1 ships is:
the raw Kysely instance is never exported from `db/`; a tenant-table query without scope does not
typecheck; and an import-boundary rule fails the build if any file outside `db/` reaches past the
wrapper. This is the strongest honest form of the requirement.

<a id="d-02"></a>
**D-02 — Reversal links live on the reversing journal.** Spec §2.2 forbids updates to journals and
§12 removes the `UPDATE` grant, so "journal X has been reversed" cannot be a column on X. The
reversing journal carries `reverses_journal_id`, written at insert. Querying whether X was reversed
is a lookup by that column. No journal row's value ever changes after insert.

<a id="d-03"></a>
**D-03 — `sessions` table added.** Spec §7's tenancy list omits it while §5 requires session auth.
Adding `sessions` (hashed opaque token, user, expiry, revocation) rather than using signed stateless
cookies, so that revocation is instant — consistent with the same reasoning §5 applies to OAuth
tokens.

<a id="d-04"></a>
**D-04 — `idempotency_keys` table added.** Spec §12 requires idempotency keys on every write
endpoint; §7 has no table for them. Scoped `(org_id, key)` with a stored response and request
fingerprint.

<a id="d-05"></a>
**D-05 — IaC written, not applied.** Terraform is committed and `plan`-clean; no AWS resources are
created in M1. The hosted path is therefore reviewed but unexercised, and the first real deploy is
its own follow-up. Acceptance criteria are demonstrated against local Compose.

<a id="d-06"></a>
**D-06 — Argon2id for password hashing.** Not specified. Argon2id over bcrypt for a greenfield
system; bcrypt's 72-byte input truncation and weaker memory-hardness aren't worth inheriting.

<a id="d-07"></a>
**D-07 — Provider interfaces in M1, adapters with their consumers.** Spec §3 requires both hosted
and self-host implementations "in v1," which M1 is not. M1 delivers the interfaces, env-driven
selection, and fail-fast validation, so the pattern is locked. Concrete queue, storage, and email
adapters land with the first feature that sends an email or enqueues a job. `BankFeedProvider` is
M4. Writing adapters with no consumer would mean writing them untested.

<a id="d-08"></a>
**D-08 — Period status is `open`/`closed` in M1.** The audited, permission-gated reopen flow in
spec Phase 3 concerns reconciliation sessions, not fiscal periods. M1 ships plain open/closed with
a `requirePermission` check on close and reopen; richer period-close workflow arrives with M2/M3.

<a id="d-09"></a>
**D-09 — GitHub Actions instead of GitLab CI.** Spec §3 names GitLab CI. The repository is on
GitHub, so a GitLab pipeline would be unverifiable. Same stages, different runner. If the repo
moves to GitLab, this is a mechanical port of one file.

<a id="d-10"></a>
**D-10 — Tooling.** Yarn 4 workspaces, pinned in-repo at `.yarn/releases/yarn-4.17.1.cjs` with
`packageManager` set, so CI and contributors get the exact version without a corepack bootstrap
(`corepack enable` needs write access to `/usr/local/bin`). `nodeLinker: node-modules` rather than
PnP — argon2, esbuild, and testcontainers are all lower-friction under a real `node_modules` tree.
Yarn 4's `enableScripts: false` default is kept: argon2 and esbuild both resolve platform prebuilds
at require time, verified for darwin-arm64 and the image's linux targets. Vitest (aligns with the
Vite frontend), Kysely's built-in migrator (no reason to add a second migration tool), Terraform
(portable and reviewable; AWS CDK would keep one language but adds a bootstrap requirement and a
heavy dependency tree).

<a id="d-11"></a>
**D-11 — TypeScript pinned to 5.9.3, not 7.x.** TypeScript 7.0.2 is current, but
`typescript-eslint@8.65` declares `typescript >=4.8.4 <6.1.0`. Adopting TS 7 means no working
type-aware lint, and spec §12 makes lint rules build gates. Revisit when typescript-eslint ships
TS 7 support.

<a id="d-12"></a>
**D-12 — The server is bundled, not compiled per-package.** esbuild bundles
`packages/server/src/entrypoints/main.ts` into `dist/server/main.js`, inlining the internal
packages. Internal packages therefore export `src` directly and are resolved by tsconfig `paths`,
Vitest aliases, and the bundler alias — one resolution story for dev, test, and production instead
of a dev-vs-dist split. `tsc` is used only for typechecking. Native and worker-spawning
dependencies (argon2, mysql2, pino) stay external.

<a id="d-13"></a>
**D-13 — Money is cents everywhere, carried on the wire as a cents-only string.** Stored as
`BIGINT` minor units (spec §12), transported as a decimal string containing **nothing but an
integer count of cents** (`"150000"`, `"-150000"`, `"0"`), converted to a decimal for display and
nowhere else.

A string rather than a JSON number, and the reason is narrower than "floats are inexact": integers
_are_ exact in a double, up to 2^53. The problem is that the ceiling exists at all and is invisible
— above it a JSON parser rounds silently, and the layer doing the rounding is the one we do not
control. A string has no such ceiling, and `9007199254740993` round-trips exactly, which is asserted
by test.

The discipline is that the string is **cents, never an amount**. `"1500.00"`, `"1.5"`, `"1e5"`,
`"+150000"`, and `"01500"` are all rejected by `fromMinorString`, verified case by case. A decimal
amount on the wire would require every reader to know the currency exponent, which is exactly the
coupling to avoid before multi-currency arrives (spec §13); it would also make the format's meaning
depend on a field it does not carry. Decimal strings are a presentation form, produced by
`toDecimalString` for the UI and consumed by the money input component.

The gap a string leaves — and a JSON number would not — is that it has no upper bound, so
`"99999999999999999999"` parses to a valid `bigint` that no `BIGINT` column can store. Before this
was bounded, such a value reached the driver and returned an opaque `internal_error`: the server
taking blame for a request it should have refused. `fromMinorUnits` now bounds to the signed
`BIGINT` range, and because every constructor funnels through it, that single check covers every
route money takes into the system.

One consequence for the display path: "display as a decimal" must not mean `cents / 100` in
floating point, which yields `1234.5599999999999` for some values. Formatting goes through
`toDecimalString`, which does it by string manipulation. The float exists only in the rendered
glyphs, never in a computation.

<a id="d-14"></a>
**D-14 — Journals carry a gapless per-org sequence number.** `journals.sequence_number`, unique per
org, in addition to the UUID primary key. Accountants and auditors expect a human-readable
monotonic reference, and adding one after the tables hold data means backfilling every journal and
inventing numbers for history.

Allocated from a `journal_sequences` counter row taken `FOR UPDATE` inside the posting transaction,
not from `MAX(sequence_number) + 1` and not from `AUTO_INCREMENT`. Each alternative fails for its
own reason, and the first is the interesting one: the app user cannot run `SELECT … FOR UPDATE` on
`journals` at all, because MySQL requires `UPDATE`/`DELETE`/`LOCK TABLES` alongside `SELECT` for a
locking read and withholding those is exactly how immutability is enforced (see OB-014's finding).
`AUTO_INCREMENT` would leave gaps on rollback, and a gap in a journal sequence is indistinguishable
from a deleted entry — precisely the ambiguity the append-only design exists to remove.

<a id="d-15"></a>
**D-15 — Until first release, migrations are edited in place, not appended to.** Nothing is
deployed and no database holds data worth preserving, so a schema change belongs in the migration
that created the table rather than in a new one. Four readable migrations describing the current
schema are worth more than a dozen recording the order in which it was designed.

This inverts at the first release, and the inversion is not gradual: once any environment holds
data, migrations become append-only forever. Worth stating explicitly because the habit formed
pre-release is the one that gets carried across that line by accident.

<a id="d-16"></a>
**D-16 — Deletion stays impossible, and reversal is not the UX answer to it.** QuickBooks Online
permits deleting transactions; the question is whether that is cleaner. It is _simpler_, and it is
not cleaner in the property that matters. A deleted transaction means the books can no longer
reproduce what they said on a past date, a filed return stops reconciling to the ledger that
produced it, and concealing an error becomes indistinguishable from never making one. Spec §2.2 and
§2.3 already chose the other side, and the whole immutability apparatus — the grant split, the
composite keys, gate A6 — implements that choice.

But there is a genuine UX complaint underneath the question, and reversal does not answer it: a
typo noticed ten seconds after posting should not produce three journal entries. The answer is a
**draft state** — an entry that has not yet reached the ledger can be edited and discarded freely,
because it is not yet a posting. That gives the delete-like experience where users actually want it
without a mutable ledger. Deferred to M2 with the manual JE UI, where the friction is first felt.

<a id="d-17"></a>
**D-17 — Fiscal periods are calendar months, generated a year at a time.** A fiscal period is the
smallest span the books are closed over. In practice that is almost always a calendar month: twelve
per fiscal year, closed monthly as a soft close and annually as a hard close. Quarters exist as a
reporting rollup rather than as the closing unit, and retail's 4-4-5 week calendar is real but is a
mid-market concern, not a solo/micro-business one (spec §1). The fiscal _year_ frequently does not
start in January — April, July, and October are all common — so the year's start month is a
per-org setting even though the periods within it are ordinary months.

So M1 ships: a fiscal-year-start month on the org, and period generation that creates twelve monthly
periods for a given year in one call. Periods are contiguous by construction, which sidesteps the
gap problem — a date falling in no period is un-postable, and `journals.period_id` being `NOT NULL`
means that is enforced rather than merely discouraged.

Generation is explicit, never implicit on first post. Auto-creating the enclosing period at posting
time would let a posting silently manufacture a period inside a year that had already been closed,
which is the reverse of what closing a year is for. The cost is that onboarding must generate
periods before the first entry — a prerequisite rather than a nicety, and a real M1 acceptance
dependency for "a user runs a full month of manual books".

## Risks

**OB-013 is load-bearing and hard to retrofit.** Every query in the system for the next six
milestones goes through this wrapper. If its ergonomics are wrong, the cost is either a rewrite or
a stream of escape hatches that erode the guarantee. Worth extra care and a real review pass.

**The dual-DB-user requirement touches four environments.** Compose, testcontainers, RDS bootstrap,
and the migration that revokes the grants must agree. A mismatch makes A6 pass locally and mean
nothing in production. OB-007 includes the RDS side specifically so this doesn't become local-only.

**`plugin-api` designed against one consumer.** Spec §8 is right that the package must not
stabilize until four to six modules have stressed it. M1 has essentially one module, so the initial
surface will be wrong in ways only M2 and M3 reveal. Keeping it `0.x` and unpublished is what makes
that acceptable — expect churn, and don't defend the first design.

**Spec drift as a build failure needs the generator to be deterministic.** If Zod-to-OpenAPI
emission has any nondeterminism (key ordering, for instance), the drift gate becomes a flaky build
rather than a guarantee. OB-022 should verify determinism explicitly before the gate is made
blocking.

**Testcontainers on CI runners.** Requires a Docker-enabled runner and adds meaningful minutes to
every build. Spec §11 is explicit that mocks and SQLite are not acceptable substitutes, so the cost
is accepted; OB-027 should reuse a single container across the suite rather than per-file.

---

## Open decisions carried from the spec

Per spec §14, none block M1. Recorded here so they aren't lost:

| Decision                                                         | Needed by                    |
| ---------------------------------------------------------------- | ---------------------------- |
| Redis vs. in-process queue for self-host Compose                 | M1–M5 (interface only in M1) |
| SSE vs. polling for live queue and reconciliation updates        | M4–M5                        |
| Event log retention policy — also bounds integrator resync depth | M5                           |
| Security-event logging for revoked credentials                   | M5                           |
| Workflow action catalog                                          | M6                           |
| Recurring transaction and QuickBooks import staging schemas      | M3, M7                       |
| Hosted pricing/tiers and data portability principle              | M7                           |

Additionally, spec §14 recommends walking ACH Pro's existing QBO integration before finalizing
M3 and M5 endpoint design. That review should be scheduled during M2 so its findings land before
AR/AP shapes are frozen.
