# Contributing to OpenBooks

OpenBooks is a double-entry accounting system. That shapes how it is built more than the technology
choices do: a bug here does not render a page wrong, it makes someone's books wrong, and books are
wrong retroactively and quietly. Several of the rules below will feel heavy-handed for a young
codebase. They exist because the alternative is discovering in year two that the ledger has drifted
and there is no way to tell when.

Read [Non-negotiables](#non-negotiables) before writing code. Everything else here is mechanics.

**Current state:** Milestone 1, the walking skeleton, is in progress. The API does not work end to
end yet — the `api` role deliberately throws `not implemented`. See [ROADMAP.md](ROADMAP.md) for what
exists and what does not, and check the ticket board there before starting anything: most work is
already scoped into a numbered ticket with stated dependencies.

## Before your first pull request

You need a signed Contributor License Agreement on file. See [CLA.md](CLA.md) — it explains why a
CLA rather than a DCO (the project is dual-licensed, so it needs rights broad enough to license
contributed code under both licenses), and how to sign. If your employer owns your work product, the
corporate agreement in that file is also required. Both must be on file before a contribution is
merged, so sign early rather than after review.

## Prerequisites

| Requirement | Version                      | Notes                                            |
| ----------- | ---------------------------- | ------------------------------------------------ |
| Node.js     | 22 — see [`.nvmrc`](.nvmrc)  | `nvm use` picks it up. `>=22.11.0` is enforced.  |
| Docker      | with Compose v2              | Required for tests, not just for running the app |
| Yarn        | 4.17.1 — **already in-repo** | Do not install it globally. See below.           |

Docker is not optional for development. Tests run against real MySQL 8 through testcontainers, so
`yarn test` needs a working Docker daemon.

### Do not install Yarn globally

Yarn 4.17.1 is committed at [`.yarn/releases/yarn-4.17.1.cjs`](.yarn/releases/) and pinned by the
`packageManager` field in `package.json`. Every contributor and CI run therefore uses the exact same
Yarn build, and nobody has to bootstrap anything.

In practice:

- **If `yarn` is already on your PATH via Corepack** (which ships with Node), it reads
  `packageManager` and uses 4.17.1 automatically. Check with `yarn --version` — you should see
  `4.17.1`.
- **If you have no `yarn` at all**, either run `corepack enable` (this writes shims to your Node
  install directory and may need elevated permissions), or skip it entirely and invoke the committed
  binary directly:

  ```sh
  node .yarn/releases/yarn-4.17.1.cjs --version
  ```

  That works with nothing but Node installed, and is what the Docker build does.

- **Do not run `npm install -g yarn`.** That installs Yarn 1, which does not read `yarnPath` from
  `.yarnrc.yml`. You would get a Yarn 1 install against a Yarn 4 lockfile, which is a slow and
  confusing way to fail.

## Getting started

```sh
git clone https://github.com/OpenBooksAccounting/OpenBooks.git
cd OpenBooks
nvm use          # or otherwise get onto Node 22
yarn install
yarn check       # everything should pass on a clean checkout
```

Then bring up the stack:

```sh
cp .env.example .env
# .env.example documents every variable; the defaults are development-only
docker compose up
```

The Compose stack is MySQL 8, a `migrate` service that runs to completion and exits, and an `api`
service that only starts once migrations have exited zero. Migrations are a discrete job and never
run on container boot — one image, three roles, selected by `OPENBOOKS_ROLE=api|worker|migrate`.
`api` currently fails on purpose; that is milestone work, not a broken setup.

Useful scripts:

| Command             | What it does                                                           |
| ------------------- | ---------------------------------------------------------------------- |
| `yarn dev`          | `tsx watch` on the api entrypoint (throws until OB-022/OB-023 land)    |
| `yarn build`        | esbuild bundle of the server plus the Vite build of the web shell      |
| `yarn migrate`      | Runs migrations up against your local database                         |
| `yarn migrate:down` | Rolls the last migration back                                          |
| `yarn codegen`      | Regenerates `packages/server/src/db/generated.ts` from the live schema |
| `yarn spec`         | Regenerates the OpenAPI description                                    |
| `yarn lint:fix`     | ESLint with `--fix`                                                    |
| `yarn format`       | Prettier write over the repo                                           |

`yarn codegen` and `yarn spec` write committed files. If you change the schema or a route, run them
and commit the result — CI regenerates both and fails on any diff, so schema, types, and published
spec cannot drift from the code.

## The gate

One command has to pass before you open a pull request, and it is the same command CI runs:

```sh
yarn check
```

That is these five, in order — run them individually when you want a faster loop:

```sh
yarn format:check   # prettier --check .
yarn lint           # eslint . — includes the project-specific rules below
yarn lint:deps      # dependency-cruiser import boundaries
yarn typecheck      # tsc --noEmit across every workspace
yarn test           # vitest, against real MySQL via testcontainers
```

`yarn test` starts a MySQL container, so the first run is slow and the suite reuses one container
across files. If it hangs, check that Docker is actually running before assuming the tests are
broken.

## Project-specific lint rules

Three rules live in [`packages/eslint-plugin`](packages/eslint-plugin/src/rules/). They are build
gates, not style preferences. Each one guards a property that the spec states in prose and that
nothing else in the toolchain checks — which is exactly why they are rules and not review
conventions. **A rule tripping means the design is wrong, not that the rule is wrong.** If you find
yourself reaching for `eslint-disable`, that is the signal to ask in the pull request instead.

### `no-process-env`

Bans `process.env` outside `packages/server/src/config/`.

Configuration is validated once at startup with Zod, and startup fails with a precise message naming
the missing variables when a selected provider's requirements are unmet. That guarantee only holds if
every environment read goes through the validated config object. One stray `process.env.FOO`
elsewhere is an unvalidated input that has bypassed the check — and it will typically be discovered
in production, on the code path that reads it.

**When you trip it:** add the variable to the env schema in the config module and import the typed
config.

### `no-float-money`

Bans float arithmetic, `Math.*`, and `number` coercion on money-typed values.

Money is a branded `bigint` of minor units from end to end. `0.1 + 0.2` is not `0.3` in IEEE 754, and
in an accounting system that error compounds across postings until a trial balance is off by cents
that nobody can source. Parsing and formatting happen at the system boundary only, and rounding has
a single documented application point.

**When you trip it:** use the money helpers rather than the arithmetic operators, and keep the value
a `bigint` until it leaves the system.

_Note: this rule is a marked placeholder that currently reports nothing. It is type-aware and keys
off the `Money` brand, so it cannot be implemented before the brand exists — OB-005 owns both. The
lint rule not firing yet does not make float money acceptable._

### `no-journal-writes`

Bans `insertInto` / `updateTable` / `deleteFrom` / `replaceInto` on `journals` and `journal_lines`
anywhere except the posting repository.

The posting repository owns balance validation, the minimum-two-lines check, account existence and
same-org checks, the period-open check taken under a lock, and actor provenance. A second write path
to those tables does not skip one of those checks — it skips all of them. The database also denies
`UPDATE` and `DELETE` on both tables to the application user, so those cases fail at runtime
regardless; this rule catches them at build time and catches the case the grants cannot, an `INSERT`
from the wrong place.

**When you trip it:** call the posting service.

Alongside these, [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) enforces what a file may
_reach_ rather than what it may _do_: no raw database client outside `src/db/`, transport may not
reach repositories, services may not import transport, `plugin-api` depends on nothing, and the web
app talks to the public API only. The comments in that file explain each rule.

## Non-negotiables

These are architectural commitments, not preferences. A pull request that violates one gets rejected
on principle rather than reworked in review, because each of them is cheap to hold and expensive to
retrofit.

**Journals are append-only. Corrections are reversing entries.** Nothing ever updates or deletes a
journal row — there is no column anywhere whose value changes after insert. "This journal was
reversed" is not a flag on the original; it is `reverses_journal_id` on the reversing journal,
written at insert time. The application user does not hold `UPDATE` or `DELETE` on the journal
tables, so this is enforced by the database rather than by discipline.

**Money is `bigint` minor units, end to end. Never a float.** See `no-float-money` above. This
includes JSON payloads, database columns (`BIGINT`), and anything in between. Format for display at
the boundary; do not carry a formatted value inward.

**All tenant database access goes through the org-scoped wrapper.** `packages/server/src/db/` exports
`tenantDb(ctx)` and `systemDb` and nothing else; the raw Kysely instance is module-private. The
tenant wrapper's generic parameter accepts only keys of `TenantTables`, so a tenant-table query
without org scope does not typecheck, and an import-boundary rule fails the build if any file outside
`db/` reaches past the wrapper. A cross-org read must return nothing _and_ must not leak that the row
exists — that means `404`, never a distinguishable `403`.

**Transport adapters hold zero business logic.** Route handlers map arguments and nothing else: no
validation logic, no authorization logic, no queries. Validation lives in the Zod schemas in
`packages/shared-types`, which are simultaneously the validators, the types, and the source of the
OpenAPI description. Authorization lives in the service layer behind `requirePermission`. The reason
is not tidiness: HTTP is one of several transports — MCP tools and the workflow engine call the same
services — and logic that lives in a route handler is unreachable from the others.

**Tests run against real MySQL via testcontainers. Never SQLite, never mocks.** The invariants worth
testing here are things like grant-level immutability, `BIGINT` behaviour, transaction and locking
semantics under concurrency, and index-scoped isolation. Every one of those is a property of MySQL
specifically. A suite that passes against SQLite or a mocked query builder has tested the test
harness. The container provisions both database users so grant-level assertions are meaningful.

Ledger invariants are additionally checked with property tests (fast-check) rather than examples:
journals balance, org-wide debits equal credits, the accounting equation holds, no one-sided lines,
a journal plus its reversal nets to zero per account, and posting order does not affect the result.
If you add a ledger behaviour, add the invariant, not just a case.

## Commit and pull request conventions

Commits are subject-line-plus-body, with the ticket ID from
[ROADMAP.md](ROADMAP.md#ticket-board) as the prefix:

```
OB-006: Licensing, CLA, contributor guide, and README

One-paragraph statement of what this changes and why it is needed.

Then the specifics, as prose or bullets. Explain the reasoning behind any
choice a reader would otherwise have to reverse-engineer, and reference the
spec section or ROADMAP decision that motivated it.

Verified: which gates were run and what passed.
```

Rules of thumb:

- Subject: `OB-NNN: <what changed>`, imperative or noun phrase, under about 72 characters, no
  trailing period. Work with no ticket uses a bare descriptive subject.
- The body explains **why**. The diff already shows what. If a reviewer would have to ask "why is it
  done this way", the answer belongs in the message.
- Reference spec sections and ROADMAP decision IDs (`D-07`) where they apply.
- Close with a `Verified:` line stating what you actually ran.
- If a tool or agent co-authored the change, add a `Co-Authored-By:` trailer.

For pull requests:

- Target `develop`. It is the main branch here; `main` is not used.
- Branch name: `OB-NNN/short-description`.
- `yarn check` passes locally before you open it. CI runs the same thing and will not be gentler.
- State `CLA signed: <name> <email>` in the description for your first pull request.
- Regenerate and commit any generated artifact your change affects (`yarn codegen`, `yarn spec`).
- Keep one concern per pull request. The ticket board is deliberately decomposed so that reviews stay
  small; a pull request that touches four tickets' worth of surface is hard to review and harder to
  revert.
- If you disagree with a rule in this document, say so in the pull request. Arguing the rule is
  welcome. Silently disabling it is not.

## Reporting bugs and proposing features

Use the issue templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). For anything that
touches the ledger, include the postings involved — a description of the symptom without the journal
lines is rarely enough to reproduce an accounting bug.

For substantial features, open an issue before writing code. Much of the intended scope through v1 is
already planned in [ROADMAP.md](ROADMAP.md), including things deliberately deferred, and it is worth
five minutes to check whether your idea is scheduled, out of scope on purpose, or genuinely new.

## Security

Do not open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md) for how to
report one privately, and expect an acknowledgement before you disclose publicly.
