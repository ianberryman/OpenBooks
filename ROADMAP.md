# OpenBooks — Development Roadmap

Derived from `OpenBooks — v1 Development Scope`. This file is the execution plan; the spec
remains the source of truth for intent. Where this roadmap deviates from the spec, the
deviation is recorded in [Decisions](#decisions) with a reason.

---

## Milestone map

| Milestone | Spec phase | Outcome                                                                                                | Status                       |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **M1**    | Phase 0    | Walking skeleton — tenancy, session auth, ledger kernel, trial balance, invariant tests, Docker/CI/IaC | **Built — see Status below** |
| M2        | Phase 1    | Manual bookkeeping usable — CoA, contacts, dimensions, JE UI, P&L / BS / GL                            | **Scoped — see below**       |
| M3        | Phase 2    | AR/AP — invoices, bills, credit notes, payment application, tax, aging                                 | Not scoped                   |
| M4        | Phase 3    | Banking — import, matching pipeline, reconciliation _(largest phase)_                                  | Not scoped                   |
| M5        | Phase 4    | Platform surface — OAuth AS, MCP tools, event bus, change feed, `external_refs`                        | Not scoped                   |
| M6        | Phase 5    | Automations — workflow engine, dry run, activation flow                                                | Not scoped                   |
| M7        | Phase 6    | Launch readiness — QB import, onboarding, export, docs, published spec                                 | Not scoped                   |

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

### Parallelization plan

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

## Milestone 2 — Manual bookkeeping usable

### Definition of done

A solo owner or their bookkeeper runs a full month of manual books **in the browser**,
unassisted: create the org, generate the year's periods, build a chart of accounts, add
contacts and dimensions, enter and correct journal entries, close the month, and read the
four reports. M1 proved the kernel; M2 is the first milestone where the product is used
rather than tested.

Every criterion is verified by an automated test, not by inspection.

| #   | Acceptance criterion                                                                                    | Verified by    |
| --- | ------------------------------------------------------------------------------------------------------- | -------------- |
| B1  | A full month of books runs end to end in a real browser against the Compose stack                       | OB-055         |
| B2  | P&L and balance sheet tie to the trial balance for any date range                                       | OB-053         |
| B3  | The balance sheet balances without a closing journal — assets = liabilities + equity + current earnings | OB-043, OB-053 |
| B4  | GL opening balance + movement = closing balance, for every account and every range                      | OB-044, OB-053 |
| B5  | A draft is freely editable and discardable; posting it is the only path to the ledger, exactly once     | OB-038, OB-054 |
| B6  | Dimension tagging never moves money — every report unsliced equals its slices plus unassigned           | OB-041, OB-053 |
| B7  | Hierarchy subtotals equal the sum of descendants, and a cycle is unrepresentable                        | OB-035, OB-039 |
| B8  | A retried register / create-org / switch-org yields exactly one of the thing (M1 gap 1 closed)          | OB-028, OB-054 |
| B9  | No component names a raw colour, spacing, or radius — tokens only, lint-enforced                        | OB-046, OB-056 |
| B10 | Every screen's affordances follow the caller's permission set, and the service refuses regardless       | OB-030, OB-054 |
| B11 | The new resources hold the A7 line — a cross-org read is a 404 with a byte-identical body               | OB-054         |

### Explicitly out of M2

- Invoices, bills, credit notes, payment application, tax, aging — all M3.
- **Cash-basis reporting.** It needs a payment date to switch on, and there is no subledger
  until M3. See [D-22](#d-22).
- Bank feeds, import, reconciliation (M4). Attachments ride with them.
- Recurring entries, budgets, and the year-end closing journal. The balance sheet derives
  current-year earnings instead — see [D-20](#d-20).
- Multi-currency (spec §13), custom roles, MCP tools, OAuth (M5).
- Any `terraform apply`. Unchanged from [D-05](#d-05); M2 is still demonstrated on Compose.

---

### Ticket board

30 tickets across 7 waves, numbered on from M1. Sizes as before: **S** ≈ one focused
change, **M** ≈ a coherent subsystem, **L** ≈ non-trivial design or test surface.

#### Wave 0 — Carried debt and conventions (4 parallel)

| ID         | Title                                      | Size | Depends on |
| ---------- | ------------------------------------------ | ---- | ---------- |
| **OB-028** | Org-less idempotency claims                | M    | —          |
| **OB-029** | CORS layer and cross-site cookie posture   | S    | —          |
| **OB-030** | `GET /v1/me` — the caller's permission set | S    | —          |
| **OB-031** | Keyset pagination and the list envelope    | M    | —          |

This wave is first because each of the four sets a convention every later ticket inherits.
Doing them after the screens exist means retrofitting seven of them.

**OB-028** — M1 known gap 1, and the milestone's cheapest real win. The schema already
carries `claim_scope` (`0003_idempotency`); `withIdempotency` still resolves `orgId` from
context unconditionally, so register, login, logout, create-org, and switch-org accept an
`Idempotency-Key` and ignore it. M2's auth screens are the first client that will actually
retry these — a double-submitted org-creation form currently makes two orgs.

**OB-029** — M1 known gap 2. `Idempotency-Key` is not CORS-safelisted, so every write needs
a preflight; the session cookie is `SameSite=Lax`, so the API must be a same-site subdomain
with `SESSION_COOKIE_DOMAIN` set. Not needed for M2 development, where Vite proxies
same-origin — which is exactly why it will be forgotten if it is not done now.

**OB-031** — `listAccounts` returns everything. Contacts, the journal list, and the general
ledger cannot. One convention, decided once, applied to all four. Keyset, not offset — see
[D-21](#d-21).

#### Wave 1 — Schema (4 parallel)

| ID         | Title                                                  | Size | Depends on |
| ---------- | ------------------------------------------------------ | ---- | ---------- |
| **OB-032** | DDL: contacts, and `journal_lines.contact_id`          | M    | 031        |
| **OB-033** | DDL: dimensions, values, and line tags                 | M    | 031        |
| **OB-034** | DDL: journal drafts, and the grant allowlist extension | M    | 031        |
| **OB-035** | Account hierarchy: activate `parent_account_id`        | M    | 031        |

Read `src/db/migrations/README.md` first. Three of these add tables and get their own
migration files; the two that touch `journal_lines` and `0004_app_grants` are **edited in
place**, per [D-15](#d-15) — and the grants edit is the one to be careful with, because it
is the file that makes A6 true.

**OB-032** — One `contacts` table with `is_customer` / `is_vendor` flags rather than two
tables. The same legal entity is routinely both, and modelling them separately means
either duplicating it or discovering at M3 that a vendor credit and a customer refund need
the same row. `journal_lines.contact_id` is nullable and added in place to `0002_ledger`.

**OB-033** — `dimensions`, `dimension_values`, and `journal_line_dimensions`. Unlimited
user-defined axes, tagged per **line** — see [D-18](#d-18) for the shape and the two costs
it carries. A unique key on `(org_id, journal_line_id, dimension_id)` is what stops a line
being tagged twice on one axis; without it "slices sum to the whole" (B6) is false and the
report is the place you'd find out.

**OB-034** — `journal_drafts` and `journal_draft_lines`, mutable, and therefore the first
tables since M1 to need `UPDATE`/`DELETE` in `0004_app_grants`. That allowlist is the
milestone's most load-bearing edit: it is an explicit grant per table, and the reason it is
an allowlist rather than a schema-level grant is that MySQL cannot revoke a schema-level
privilege afterwards. Adding these two tables must not widen anything else. A test asserts
the app user still cannot touch `journals` — the existing A6 test, which must keep passing
unchanged.

**OB-035** — The column ships already; this makes it real. Two rules the schema does not
give you: cycle prevention (a self-referencing FK permits `a → b → a`), and resolving the
parent through `tenantDb` + `assertFound` first, or a cross-org parent id arrives as errno
1452 and becomes a 500 instead of the 404 A7 requires. Both are called out in
`modules/accounts/index.ts`; that note was written for this ticket.

#### Wave 2 — Domain services (5 parallel)

| ID         | Title                                           | Size | Depends on |
| ---------- | ----------------------------------------------- | ---- | ---------- |
| **OB-036** | Contacts service                                | M    | 032, 031   |
| **OB-037** | Dimensions service                              | M    | 033        |
| **OB-038** | Draft journal service                           | L    | 034, 028   |
| **OB-039** | CoA hierarchy rules and chart templates         | M    | 035        |
| **OB-040** | Members, invites, and the first `EmailProvider` | M    | 028        |

**OB-037** — Create, list, archive. Archive rather than delete once a value has been used:
deleting a dimension value that journal lines carry would restate every sliced report
silently, which is [D-16](#d-16)'s argument applied one level down. An unused value deletes
freely, matching `deleteAccount`.

**OB-038** — [D-16](#d-16)'s deferred answer, and the reason a typo noticed ten seconds
after posting need not produce three journal entries. A draft is not a posting: it may be
edited and discarded because it has not reached the ledger. Posting one runs
`postJournal` and deletes the draft **in a single transaction**, keyed on the draft id, so
a double-clicked Post button cannot produce two journals. Drafts carry no sequence
number — numbers are allocated at post, from the counter row, or the gapless guarantee in
[D-14](#d-14) is not gapless. See [D-19](#d-19).

**OB-039** — Hierarchy rules (depth bound, no cycle, a parent's type must match its
children's or subtotals are meaningless), plus an opt-in starter chart applied at org
creation. Opt-in and not enforced: a chart that arrives uninvited is a chart the user
deletes account by account.

**OB-040** — `org_invites` has existed since M1 with nothing to send. A bookkeeper plus an
owner is the common shape of the target business (spec §1), so member management is table
stakes for "usable". This is where [D-07](#d-07) fires: the first consumer arrives, so the
first concrete `EmailProvider` adapters ship with it — SES for hosted, and a log adapter
for self-host and tests. Interfaces do not change.

#### Wave 3 — Reporting (4)

| ID         | Title                                           | Size | Depends on    |
| ---------- | ----------------------------------------------- | ---- | ------------- |
| **OB-041** | Report core: ranges, dimension filters, rollups | L    | 036, 037, 039 |
| **OB-042** | Profit and loss                                 | M    | 041           |
| **OB-043** | Balance sheet and current-year earnings         | L    | 041           |
| **OB-044** | General ledger and account drill-down           | M    | 041, 031      |

**OB-041** — The shared aggregation the other three are thin projections of: a date range
rather than M1's single `asOf` bound, optional dimension and contact filters, and
subtotalling over the account tree. Still no balance cache and no denormalized totals
(spec §2.6) — correctness first, and the trial balance is the oracle every property test
in OB-053 checks against.

**OB-043** — The hard one, and the reason is [D-20](#d-20): with no year-end closing
journal, revenue and expense balances have nowhere to land, so the sheet does not balance
unless current-year earnings is derived and presented as its own equity line.

**OB-044** — Per-account running balance over a range, ordered by `(entry_date,
sequence_number)` — which is the ordering the sequence number exists to make total, and
the one that makes keyset pagination stable when new entries are posted mid-read.

#### Wave 4 — Transport

| ID         | Title                                | Size | Depends on             |
| ---------- | ------------------------------------ | ---- | ---------------------- |
| **OB-045** | `/v1` surface for everything M2 adds | M    | 036–040, 042, 043, 044 |

Contacts, dimensions, drafts, members and invites, and the three reports. Unchanged rules:
handlers map arguments and hold no logic, every write requires an `Idempotency-Key`, and
`openapi.json` drift stays a build failure (A10).

#### Wave 5 — Web (7)

| ID         | Title                                                | Size | Depends on |
| ---------- | ---------------------------------------------------- | ---- | ---------- |
| **OB-046** | Design tokens, Tailwind, Radix primitives, app shell | L    | 024        |
| **OB-047** | Auth screens, org switch, permission-aware shell     | M    | 046, 030   |
| **OB-048** | Chart of accounts screen                             | M    | 046, 045   |
| **OB-049** | Contacts screen                                      | M    | 046, 045   |
| **OB-050** | Org settings: dimensions, members, periods           | M    | 046, 045   |
| **OB-051** | Journal entry screen — draft editor, post, reverse   | L    | 046, 045   |
| **OB-052** | Report viewers with drill-through                    | L    | 046, 045   |

OB-046 gates the other six, so it is the ticket to start first and the one most worth
getting right. The rest are genuinely parallel.

**OB-046** — **A global token layer, and it is a build gate rather than a convention.** One
source of truth defines colour, spacing, radius, type scale, elevation, and motion as CSS
custom properties; Tailwind's theme is configured to read from those variables and from
nothing else; components reference tokens only. A lint rule fails the build on a raw hex,
`rgb()`, or arbitrary-value colour in any component — the same shape as
`openbooks/no-float-money`, and for the same reason: a rule everyone agrees with and
nothing enforces is a rule that decays at the first deadline. Because the tokens are custom
properties rather than compiled Tailwind values, a theme is a re-binding at `:root` — light
and dark ship from the start, and a future white-label needs no component to change. Also
here: the app shell, the money input built on `toDecimalString` (never `cents / 100` —
[D-13](#d-13)), and the mapping from the typed error codes to what a screen actually shows.

**OB-051** — The screen the milestone is named for. A multi-line editor with a live
balancing indicator, account and contact combo-boxes, and per-line dimension tagging. It
edits a **draft**; Post is a separate, deliberate action, and after posting the entry is
immutable and the only affordance is Reverse. The Post button carries one idempotency key
minted per draft, not per click.

**OB-052** — Trial balance, P&L, balance sheet, general ledger, with drill-through from a
report line to the entries behind it. Dimension and date-range filters are shared controls,
not four separate implementations.

#### Wave 6 — Verification and delivery (5)

| ID         | Title                                              | Size | Depends on |
| ---------- | -------------------------------------------------- | ---- | ---------- |
| **OB-053** | Report property suite (fast-check)                 | L    | 041–044    |
| **OB-054** | Enforcement and permission matrix for M2 resources | M    | 045, 051   |
| **OB-055** | Playwright e2e — the B1 narrative                  | M    | 047–052    |
| **OB-056** | CI: web build, token lint, e2e job                 | M    | all        |
| **OB-057** | Walk ACH Pro's QBO integration → findings doc      | M    | —          |

**OB-053** — The M1 property suite's lesson applies directly: two mutations survived the
entire example suite and were caught only by property tests, because the examples were all
two-line journals. Reports are worse in this respect — an example with one dimension and
three accounts will pass against a rollup that is wrong for four. Properties: every report
ties to the trial balance; slices plus unassigned equals the whole; GL opening + movement =
closing; report values are independent of posting order; a reversal nets its journal to
zero on every report and every slice.

**OB-054** — The new resources against the A7 line (byte-identical 404s), plus a permission
matrix over the six seeded roles: every M2 operation, every role, asserted allowed or
refused. That matrix is also the thing that makes M1 known gap 6 visible when M3 widens
Bookkeeper — the diff will show in a test rather than in production.

**OB-055** — B1, in a real browser against Compose. Register, create the org, generate
periods, apply a chart, add a contact and a dimension, draft and post a month of entries,
reverse one, close the month, and read all four reports. Playwright — see
[D-26](#d-26).

**OB-057** — Not code, and it is on the board so it does not slip. Spec §14 says to walk
ACH Pro's existing QBO integration before Phase 2 and Phase 4 endpoint design is frozen,
because you own both ends. AR/AP is exactly what it informs, and doing it after M3's shapes
are set discards the advantage. Independent of every other ticket; schedule it early in the
milestone, not at the end.

### Parallelization plan

```
Wave 0   028   029   030   031
                      │     │
Wave 1         ┌──────┴──┬──┴───┬──────┐
              032       033    034    035
               │         │      │      │
Wave 2   ┌─────┴───┬─────┴┬─────┴┬─────┴──┐
        036       037    038    039      040
         └────┬────┘             │
Wave 3       041 ──┬── 042 ── 043 ── 044
                   │
Wave 4            045                     046 (needs only 024 — starts at wave 0)
                   │                       │
Wave 5             └───────┬───────────────┴── 047 048 049 050 051 052
                           │
Wave 6            053 ── 054 ── 055 ── 056        057 (independent, schedule early)
```

Critical path: **031 → 034 → 038 → 045 → 051 → 055 → 056**.

The milestone's real shape is two halves that meet at OB-045: a backend half
(031 → 044) and a frontend half rooted at OB-046, which depends on M1's OB-024 and
nothing else. **Start OB-046 in wave 0**, alongside the carried debt — it gates six
tickets, and every day it waits is a day six screens cannot start. OB-041 and OB-051 are
the two most likely to expand, for the same reason OB-013 and OB-020 were in M1: they carry
the milestone's hardest guarantees.

If a shorter cycle is wanted, the natural cut is **M2a = waves 0–4** (the API is complete
and drift-gated, screens still absent) and **M2b = waves 5–6**. The cut is clean because
OB-045 is a real boundary; nothing in wave 5 changes anything below it.

### M2 status

Waves 0, 1 and 2 plus OB-046 are built on `develop`. `yarn check` passes: 1,042 tests
across 82 files, ~46s.

| Ticket     | State | Note                                                                             |
| ---------- | ----- | -------------------------------------------------------------------------------- |
| **OB-028** | Built | Global claim namespace; five identity writes now replay-guarded. Gap 1 closed    |
| **OB-029** | Built | `@fastify/cors`, registered first in the chain — see below. Gap 2 closed         |
| **OB-030** | Built | On the existing `GET /v1/auth/me`, not a new `/v1/me`                            |
| **OB-031** | Built | Keyset applied to accounts and a new `GET /v1/journals`                          |
| **OB-032** | Built | `contacts`, one table with `is_customer`/`is_vendor`; `journal_lines.contact_id` |
| **OB-033** | Built | Dimensions, values, tags. Tags are **mutable** — see the block in `0004`         |
| **OB-034** | Built | Drafts, their lines, and their tags; three additions to the grant allowlist      |
| **OB-035** | Built | Hierarchy with cycle, depth (6) and type rules; `D-27` code immutability         |
| **OB-036** | Built | Contacts service; `code` stays mutable ([D-28](#d-28))                           |
| **OB-037** | Built | Dimensions, values, and retagging; axis bound of 8 ([D-29](#d-29))               |
| **OB-038** | Built | Draft journals; post is one transaction keyed on a draft row lock                |
| **OB-039** | Built | 65-account starter chart. **Org-creation wiring outstanding** — see below        |
| **OB-040** | Built | Members, invites, SES + log adapters; `smtp` removed ([D-31](#d-31))             |
| **OB-046** | Built | Token layer, `openbooks/no-raw-color`, Radix wrappers, shell                     |
| **OB-058** | Built | jsdom harness; 87 web tests. New ticket — see below                              |
| Waves 3–6  | —     | Not started                                                                      |

**OB-058, web component test harness**, was not in the original board. It exists because
OB-046 shipped a hand-built combobox — Radix has no combobox primitive — into a package
whose vitest project was `environment: 'node'` and whose glob was `*.test.ts`, so no
component test could even be discovered. The harness found three real bugs, one of which
would have been expensive: the combobox reopened on the first option rather than the
selected one, so pressing Enter on a picker showing the right account silently committed
whichever account sorts first, with the correct label still displayed. OB-051's account
picker is that component.

All four schema tickets were consolidated into `0002_ledger` rather than shipping as
separate migrations. Pre-release that is what D-15 asks for, and it also removes a trap:
MySQL refuses a table-level `GRANT` on a table that does not exist, so a migration added
after `0004_app_grants` can never be granted, and numbering around it (`0003a`, `0003b`, …)
accumulates forever. With every table in one file the ordering holds by construction. The
cost is written up in `migrations/README.md`: editing a migration in place leaves an
already-migrated local database inconsistent, and `down` is what discovers it.

Three findings from wave 0 that the tickets did not anticipate, recorded because each one
constrains work that has not started yet:

**`systemDb().transaction()` throws inside an ambient transaction.** MySQL has savepoints,
not nested transactions, so once `systemDb()` learned to return the ambient
`Transaction<DB>` (M1), any service that opened its own — `register` and `createOrg` both
did — could not be wrapped in an idempotency claim at all. Fixed by `withTransaction` in
`src/db/transaction-scope.ts`, the system-table twin of `TenantDatabase.transaction`. Any
future service that opens a transaction directly has the same problem and the same fix.

**A global idempotency namespace needs the caller folded into the fingerprint.** Keys are
client-chosen and the namespace is shared, so without it two callers who picked the same
key are each other's replays — the second `createOrg` would be answered with the first
caller's org id and slug, which is a cross-tenant leak, and their own org would never be
created. Now a 409. Mutation-tested: dropping the principal from the hash fails exactly the
cross-caller test and nothing else.

**Keyset ordering cannot use a mutable column.** OB-031 ordered accounts by
`(created_at, id)` rather than `code`, because `code` is editable and a rename moves a row
behind a cursor that has already passed it — silently dropping it, which is the failure
keyset was chosen to eliminate, arriving through a mutable key instead of through `OFFSET`.
Resolved by making `code` immutable ([D-27](#d-27)); the ordering is now `(code, id)`, which
is what OB-048's screen wants anyway, and `uq_accounts_org_code` covers it for free.

**CORS headers on a rejection that happens before routing.** `@fastify/cors` sets its
headers in `onRequest`, and the request-context hook rejects a malformed `Idempotency-Key`
with `done(failure)`, which skips every hook registered after it — so the 400 a cross-origin
client most needs to read came back with no `Access-Control-Allow-Origin` and an opaque
console error instead. Measured, not assumed. The library's `hook` option is not the fix:
at `onSend` it fails outright with `ERR_HTTP_HEADERS_SENT`, because it answers a preflight
by calling `reply.send()` from inside the hook. What works is registering CORS **first** in
the chain, since `done(failure)` only skips what comes after. That guarantee now rests on
registration order in `app.ts` rather than on a hook choice, which is a more fragile place
to hold it — worth knowing before anyone reorders that file.

Wave 2 left two things that are work rather than notes, and they belong to nobody's
ticket yet (a third, retagging in a closed period, is settled as [D-32](#d-32)):

1. **A draft's `contactId` and dimension tags are dropped at post.** They are held on the
   draft and absent from the journal it produces, pinned by a test that fails the day it is
   fixed. OB-038 was right not to write them — `journal_lines.contact_id` is writable only
   through `posting.repository.ts` and the tag table belongs to the dimensions service, so
   either would have been a second write path into another module's invariant — but the
   report hands the job to OB-045, and OB-045 is transport, which holds no business logic.
   The fix is `postJournal`'s line input carrying `contactId`, and `postDraft` calling the
   dimensions service inside the transaction it already opens. **This blocks B6**: a form
   that collects per-line tagging, feeding a draft that discards it, means sliced reports
   are missing exactly the entries somebody tagged by hand.

2. **The starter chart is not applied at org creation.** OB-039's service is complete and
   callable; `createOrg` lives in `modules/orgs/`, which another agent held during the wave.
   It is more than a call site: `applyChartTemplate` takes a `RequestContext` and at
   org-creation time the caller's context is not yet scoped to the org being created. It
   needs an opt-in field on the org-creation input and a context for the new org, inside
   `createOrgIn`'s transaction — which the service then joins ambiently. OB-039 correctly
   declined to add an `applyChartTemplateTo(orgId, …)` escape hatch, since spec §4 forbids
   passing an org as a parameter.

Two threads left loose:

- **A preflight and an allowlist refusal carry no `requestId`.** Registering CORS first puts
  it ahead of the request-context hook, so a short-circuited preflight's 204 has no
  `x-request-id` and the refusal `warn` — the line you would grep to diagnose a
  misconfigured allowlist — has no correlation id. That brushes against A13. Recovering it
  means splitting the context hook so the scope opens before CORS while the
  `Idempotency-Key` rejection stays after it. Also, `strictPreflight` answers a non-preflight
  `OPTIONS` with a `text/plain` 400 rather than the typed JSON error envelope, and the
  library offers no setting that restores it.
- **A local MySQL on `127.0.0.1:3306` shadows the Compose stack.** Docker's publish falls
  back to IPv6 `*:3306` when a host `mysqld` already holds the IPv4 address, so host-side
  `yarn migrate` and `yarn codegen` silently reach the wrong database and fail as
  `Access denied for user 'openbooks_migrator'@'localhost'`. Publish on another port
  (`DATABASE_PORT=13307 docker compose up -d mysql`). Costs nothing to know and a while to
  work out from the error.

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

<a id="d-18"></a>
**D-18 — Dimensions are unlimited, user-defined, and tagged per line.** Three models were
on the table: QBO's fixed Class + Location, Xero's two user-defined tracking categories,
and unlimited user-defined axes. Unlimited was chosen, and it is the most expensive of the
three, so the costs are worth stating rather than discovering.

`journal_line_dimensions` is a join table, not two columns on `journal_lines`. Report
grouping therefore costs a join per axis rather than a column reference, and a `GROUP BY`
over three axes on a large ledger is the first query in this system likely to need an index
designed for it rather than inherited from the tenancy pattern. There is also no natural
bound on how many axes an org creates, and an org with thirty of them makes the general
ledger pathological — a bound belongs in the service, chosen and written down, not left to
be found in production.

Tagging is on the **line**, not the journal header, and that is not a detail. A single
entry legitimately splits rent across three departments; header tagging would make that
entry unrepresentable and would push the user into posting three journals for one event —
which then misstates the entry count, the reference, and anything that reconciles on it.

The property that must hold, and that OB-053 asserts, is that tagging never moves money:
any report sliced by an axis sums, with an explicit "unassigned" bucket, to the same report
unsliced. The unassigned bucket is not optional. A slice view that silently omits untagged
lines shows a smaller business than exists, and it does it most on the accounts nobody
remembered to tag.

<a id="d-19"></a>
**D-19 — Drafts are their own tables, and posting one is a single transaction.** A draft
cannot be a status column on `journals`, and not for style reasons: no journal column's
value changes after insert, and the app user holds no `UPDATE` grant on the table at all
(A6). Anything editable has to live elsewhere. So `journal_drafts` and
`journal_draft_lines`, which are ordinary mutable tables and are named in the
`0004_app_grants` allowlist for exactly that reason.

A draft is not a weaker journal — it is a different kind of thing, and the distinction is
the whole point of [D-16](#d-16). It has no sequence number, because numbers come from the
counter row at post time and a draft that reserved one and was then discarded would leave a
gap, which is indistinguishable from a deleted entry (see [D-14](#d-14)). It is not in the
trial balance, is not in any report, and no invariant test applies to it. It has not
happened yet.

Posting runs `postJournal` and deletes the draft inside one transaction, keyed on the draft
id. Two transactions would let a crash between them leave a posted journal and a live draft
of it, and a user would then post the same entry twice believing the first had failed.

<a id="d-20"></a>
**D-20 — The balance sheet derives current-year earnings; no closing journal in M2.** With
no year-end close, revenue and expense balances have nowhere to go, and a balance sheet
built from account balances alone does not balance — the difference is exactly the year's
net income. Two ways to fix that: post a real closing journal at year end, or derive the
figure and present it as its own equity line. M2 derives it.

Deriving means the sheet balances on the org's first day with no close ritual to perform,
and closing is a workflow M2 does not otherwise need. The cost is a rule that has to be
written down now because it becomes wrong later: once a closing journal exists (M7, or
whenever a hard close is built), the derivation must be scoped to the current fiscal year
only and exclude any year already closed, or the closed year's income is counted both in
retained earnings and in the derived line. Retained earnings is an ordinary account;
current-year earnings never is. Deriving something that also exists as an account is how
it gets double-counted.

<a id="d-21"></a>
**D-21 — Keyset pagination, not offset.** Offset pagination assumes the rows behind you do
not move. In an append-only ledger they do — entries arrive while a user pages through the
general ledger, and with `OFFSET` that shifts the window, so a row is skipped or shown
twice with nothing in the response indicating it happened. Keyset over a total ordering has
no such failure: `(entry_date, sequence_number)` for journals and the GL, `(created_at, id)`
elsewhere. The sequence number exists in part to make that ordering total (`entry_date`
alone is not), so this is a use of [D-14](#d-14) rather than a new requirement.

<a id="d-22"></a>
**D-22 — Reports are accrual-only in M2.** Cash basis is not a report option, it is a
different definition of when a transaction counts, and it needs a payment date to key on.
There is no payment and no subledger until M3, so a "cash basis" toggle in M2 would either
do nothing or quietly report accrual figures under a cash-basis heading — the second being
worse than its absence, since it is a number someone might file. It lands with AR/AP, where
there is something to switch on.

<a id="d-23"></a>
**D-23 — Chart templates are opt-in and unenforced.** A starter chart can be applied at org
creation and is a copy, not a link — no template versioning, no upgrade path, no
relationship after the fact. The alternative, a chart that arrives uninvited, is a chart the
user deletes account by account, and M1's `deleteAccount` rule makes that possible but
tedious. Post-M1 rules are unchanged: an account with postings is never deletable, only
deactivatable.

<a id="d-24"></a>
**D-24 — Tailwind on a token layer, with Radix primitives, and the token layer is a build
gate.** Radix supplies the behaviour that is genuinely hard and genuinely not the product —
focus traps, combo-box keyboard semantics, dialog and popover accessibility — while
supplying no visual language to fight. A batteries-included kit (Mantine, MUI) was the
faster route to a usable form and the slower route to the two screens that matter, since
the balancing journal-line editor and the general ledger are hand-built grids under any
library.

The part that is not a preference: **a single global token layer, enforced.** Colour,
spacing, radius, type scale, elevation, and motion are defined once as CSS custom
properties; Tailwind's theme reads from those variables and from nothing else; no component
names a raw value. A lint rule fails the build on a hex, an `rgb()`, or an arbitrary-value
colour outside the token definitions — the same construction as `openbooks/no-float-money`
and for the same reason, which is that a convention everybody agrees with and nothing
enforces survives until the first deadline and then does not.

Custom properties rather than compiled Tailwind values, specifically, because that makes a
theme a re-binding at `:root` instead of a rebuild: light and dark ship together from the
first screen, high-contrast is reachable, and a white-label needs no component to change.
Retrofitting this after seven screens exist means touching all seven, which is the argument
for doing OB-046 before any of them rather than in parallel with them.

<a id="d-25"></a>
**D-25 — Permission-aware UI is advisory; the service is the gate.** `GET /v1/me` returns
the caller's permission set for the active org so screens can hide what the user cannot do —
an interface offering actions that always fail is not a usable one. Stated as a decision
because the failure mode is predictable: a UI that gates well enough becomes a UI someone
trusts as the gate, and then a permission check gets omitted from a service "because the
button is hidden". `requirePermission` stays service-layer only and lint-enforced (spec
§2.4, §5), and OB-054's matrix asserts every operation against every seeded role at the
service, where hiding a button proves nothing.

<a id="d-26"></a>
**D-26 — Playwright for the B1 narrative, against Compose.** B1 is the only criterion that
cannot be proven below the browser: it asserts a person can run a month of books, and every
layer below has already been proven separately. Playwright runs against the real Compose
stack — real MySQL, real migrations, the same image — for the reason spec §11 gives about
mocks, which does not stop applying at the transport boundary. One narrative, not a suite:
e2e is the slowest and most brittle test available, so it is used for the claim nothing else
can make, and the enforcement and property suites keep carrying everything else.

<a id="d-27"></a>
**D-27 — An account code is immutable once created.** Forced by OB-031 and decided on its
own merits. The mechanical argument first: the chart of accounts is ordered by code on the
one screen accountants use most, keyset pagination orders by the column it sorts on, and a
keyset over a **mutable** column silently drops rows — rename an account and it moves behind
a cursor that has already passed it, so it never appears on any page. That is precisely the
failure [D-21](#d-21) chose keyset to eliminate, arriving through a mutable sort key instead
of through `OFFSET`.

The accounting argument is the one that makes it right rather than merely convenient. A
code is not a label, it is the reference other things cite — a journal, an export, a filed
schedule, a bookkeeper's memory. `updateAccount` already refuses `type` and
`normalBalance` once an account has postings, because those decide what every report means;
a code decides what every _reader_ thinks the account is, and renaming `4000` from "Sales"
to "Consulting income" is a labelling change while renumbering `4000` to `4100` is a
different account wearing the old one's history.

So `code` leaves `updateAccountRequestSchema` entirely, and unlike `type` it is refused
from creation rather than from first posting: an account with no postings can be deleted
outright (that rule is unchanged), so a typo is fixed by delete-and-recreate, which costs
one call and leaves nothing behind. `name` and `description` stay mutable — those are
labels and nothing cites them.

<a id="d-28"></a>
**D-28 — A code is immutable exactly when a list is ordered by it.** Wave 2 asked the
same question three times and got three answers, which is coherent rather than
inconsistent once the rule is stated: `accounts.code` and both dimension codes are
immutable, `contacts.code` is not.

The mechanical half is [D-21](#d-21): a keyset cursor over a **mutable** column silently
drops the rows that move behind it. The chart of accounts and both dimension lists are
ordered by `code`, so immutability is what makes their paging correct. The contact list is
ordered by `(created_at, id)`, so nothing there is at risk.

The accounting half decides the cases the mechanical half does not reach. An account code
is what other things _cite_ — a journal, an export, a filed schedule — so renumbering
`4000` to `4100` is a different account wearing the old one's history. A contact's code is
cited by nothing: `journal_lines` references `contacts (org_id, id)`, so renumbering a
customer restates no entry and no report.

And one asymmetry makes contact-code immutability actively wrong rather than merely
unnecessary. D-27 is tolerable because it has an escape hatch: an account with a typo'd
code has no postings, so it is deleted and recreated. A contact the ledger names can
**never** be deleted — `fk_journal_lines_contact` is `RESTRICT` — so an immutable code
would be permanent from the first posting. Contact codes also usually arrive from whatever
system the org migrated off, where renumbering after an import is ordinary bookkeeping.

<a id="d-29"></a>
**D-29 — Eight reporting axes per org, counted including archived ones.** [D-18](#d-18)
left this bound to the service and said to write the number down. Both costs it names
scale with the count: a report grouped by _k_ axes is a _k_-way join, and a fully tagged
line costs one tag row per axis — at eight, a 100k-line ledger tops out at 800k tag rows;
at thirty, four times that.

Eight rather than Xero's two, because the axes real books name — department, location,
project, funding source, program, fund, campaign, vehicle — already put a small charity at
three, and an org that runs out of axes does not stop tracking, it starts encoding the
extra one into account codes, which is worse than any join.

Archived axes count. An archived axis whose values journal lines still carry is still a
join in every historical sliced report, so excluding it would let an org archive its way
past the bound while paying the whole cost. Deleting an axis nothing carries is the escape
hatch, which is part of why deletion exists at all.

Enforced under a locking count rather than an advisory one — the schema cannot express the
bound (`CHECK` cannot count rows in another table), so nothing below the service would
catch two concurrent creates. Mutation-tested: removing `.forUpdate()` fails the race test
and nothing else.

<a id="d-30"></a>
**D-30 — Drafting reuses `journals.post`; no `journals.draft` code.** The permission
catalog is fixed and seeded, so adding a code is three coordinated edits — but the reason
not to is about the role bundles, not the cost. A new code would land in Owner and
Bookkeeper by construction, miss AP-only and AR-only (explicit lists), and miss
**Approver**, whose bundle is `%.read` plus a named few including `journals.post`
precisely so it can turn a proposal into a posting. M2 would ship a role that can post an
entry but not compose one.

Nothing in M2 distinguishes "may draft" from "may post". That distinction is a review
workflow, and it arrives with the agent review path in M5, when the code has a meaning and
a role to grant it to.

<a id="d-31"></a>
**D-31 — `smtp` is no longer a selectable `EMAIL_PROVIDER`.** [D-07](#d-07) said concrete
adapters ship with their first consumer, and OB-040 is it: SES for hosted, a log adapter
for self-host and tests. No SMTP client was written, so leaving `smtp` selectable meant a
value that validates cleanly at startup, names its four required variables, and then
throws at the first invite — a configuration that passes every check the system offers and
is still wrong. The `SMTP_*` variables leave the schema entirely; self-host and Compose
select `log`.

A consequence worth noting: the email config union no longer carries a secret, so the
redaction path list shrinks. That is a real reduction in what the logger has to be trusted
about, not just a smaller list.

<a id="d-32"></a>
**D-32 — A closed period does not stop a retag.** Left open when OB-037 shipped and now
decided: `setJournalLineDimensions` deliberately does not consult the period and does not
call `assertPostable`.

Closing a period stops the _books_ moving, and a tag is not part of what the books say —
it is the analysis laid over them. Every statement a close is meant to freeze is unchanged
by a retag: the trial balance, the P&L, the balance sheet, every account total, and the
entry itself. What moves is only how a sliced report divides a total that stays the same,
which is the same reasoning that made tags mutable in the first place.

The practical case is what settles it. Dimensions are almost always introduced _after_ a
business has been keeping books for a while, and the first thing an owner wants from a new
axis is last year's numbers split by it. If a closed period refused tags that is
impossible — the data needed to answer "which of my locations lost money" would exist and
be permanently unreachable, and the only route to it would be reversing and reposting
entries that were correct. That is precisely the two-journals-to-fix-a-label outcome
[D-18](#d-18)'s mutable tags exist to avoid, arriving through the period lock instead of
through the grant.

The cost, stated rather than hidden: **a sliced report over a closed period is not
reproducible from the period alone** — it depends on when it was run. An unsliced report
still is, and that is the one the books, the filed return, and the auditor are about. If a
sliced report ever needs to be reproducible, the answer is to snapshot the report, not to
freeze the tags.

`test/dimensions/tagging.test.ts` asserts the pair: a retag in a closed period succeeds
**and** the same closed period still refuses a posting. Both halves are needed, because the
way this goes wrong is not a refused retag — a caller would notice that immediately — but
the period lock quietly ceasing to apply to the ledger. Mutation-checked: leaving the
period open fails the test.

## Status

All 27 M1 tickets are built and committed on `develop`. The gate — `yarn check`, which runs
formatting, lint, dependency boundaries, typecheck, both artifact drift gates, and the
test suite — passes. 667 tests across 51 files against real MySQL 8.4 via testcontainers,
roughly 28 seconds.

### Acceptance criteria

| #   | Criterion                                           | Proven by                                                                        |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| A1  | Post a manual balanced journal via REST             | `test/transport/v1.test.ts` — one narrative, register to trial balance           |
| A2  | Trial balance balances                              | `test/ledger/posting.test.ts`, `test/properties/balance.test.ts`                 |
| A3  | Unbalanced posting rejected                         | `test/ledger/posting.test.ts`, incl. "writes nothing when validation fails"      |
| A4  | Posting to a locked period rejected                 | `test/ledger/posting.test.ts`; raced in `test/enforcement/`                      |
| A5  | Unscoped query impossible to construct              | `test/db/tenant-scope.test.ts` — `@ts-expect-error`, so typecheck enforces it    |
| A6  | `UPDATE`/`DELETE` on journals fails at grant level  | `test/db/harness.test.ts`, `test/enforcement/grants.test.ts`, as `openbooks_app` |
| A7  | Cross-org read leaks nothing                        | `test/enforcement/cross-org.test.ts` — nine surfaces, byte-identical bodies      |
| A8  | Duplicate idempotency key yields one journal        | `test/idempotency/concurrency.test.ts` — two connections, mutation-tested        |
| A9  | Posting racing a period lock leaves nothing partial | `test/enforcement/posting-race.test.ts` — parked transactions, mutation-tested   |
| A10 | Spec drift is a build failure                       | `yarn spec:check` plus `yarn client:check`                                       |
| A11 | No float arithmetic on money paths                  | `openbooks/no-float-money`, type-aware, verified to fire                         |
| A12 | Migrations are a discrete job                       | Compose gates api on migrate exiting zero; verified with a bad password          |
| A13 | Structured logs carry actor provenance              | pino `mixin` reads the context; the mixin wins over call-site fields             |

### Known gaps, carried deliberately

Gaps 1 and 2 are **closed** by OB-028 and OB-029 (M2 wave 0); they are left described below
because the reasoning still explains why the code looks as it does. Gap 4 is expected to
move on its own as M2 gives `plugin-api` its second, third, and fourth consumer.

1. **Org-less idempotency claims are half-wired.** The schema now supports them
   (`claim_scope`, see `0003_idempotency`), but `withIdempotency` still resolves `orgId`
   from context unconditionally — so register, login, logout, create-org, and switch-org
   accept an `Idempotency-Key` and do not honour it. A header the API documents as
   required and ignores is worse than no header: a retried create-org yields two orgs.
   This is a service change plus tests. **Highest-value remaining item.**
2. **No CORS layer.** The hosted layout puts the bundle on CloudFront and the API on a
   separate hostname, but the server ships no CORS. `Idempotency-Key` is not
   CORS-safelisted, so every write needs a preflight, and the session cookie is
   `SameSite=Lax`, so the API hostname must be a same-site subdomain with
   `SESSION_COOKIE_DOMAIN` set. Needed before the first hosted deploy, not before M2.
3. **IaC has never been applied** (D-05). `infra/terraform/README.md` lists what would
   likely break on first apply; `require_secure_transport` is item one, since nothing in
   the server does TLS to MySQL yet.
4. **`plugin-api` is designed against one consumer** and will be wrong in ways M2 and M3
   reveal (spec §8). It is `0.x` and unpublished for exactly that reason.
5. **Legal review outstanding** — the plugin-api linking exception and `CLA.md` were
   drafted, not advised. Also `packages/plugin-api/package.json` says
   `"license": "Apache-2.0"` without referencing the exception.
6. **Seeded roles silently widen at M3.** The permission catalog seeds all 48 codes
   including AR/AP, so when M3 lands a Bookkeeper gains invoice powers with no migration
   and no audit event. A deliberate choice (it makes AP-only and AR-only meaningful
   today), but the widening is invisible.
7. **Worker restart policy must flip in M4/M5.** `on-failure` is right while the worker
   returns immediately; once it blocks on a queue, a clean exit becomes an outage and it
   needs `unless-stopped`.

### Before scoping M3

Spec §14 says to walk ACH Pro's existing QBO integration before finalizing Phase 2 and
Phase 4 endpoint design, because you own both ends and can fix mismatches on either.
AR/AP is exactly what that informs — vendor/bill sync, payment recording, status
writeback, entity correlation. Doing it after the endpoints are frozen wastes the
advantage. See also D-16: invoicing is where the deferred draft state first bites, since
an invoice has a lifecycle a journal does not — M2's OB-038 builds that draft state for
journals, so M3 inherits a pattern rather than inventing one.

This is now on the M2 board as **OB-057**, independent of every other ticket and scheduled
early in the milestone rather than at its end.

---

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
