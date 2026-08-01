# OpenBooks

Open-source, AI-native, modular double-entry accounting.

A real general ledger with immutable journals, arbitrary reporting dimensions, and an MCP surface you
point your own AI model at. Ships as a single Docker image you can self-host, and is operated as a
hosted service from that same image — not a stripped-down community edition of something else.

> ## Status: pre-release, but real. The core is built.
>
> Milestones **M1–M5** are built and the QuickBooks CSV import is done, so the minimum credible
> public-launch bar (M1–M4 + import) is **met**. The gate is green — `yarn check` passes 2,501 tests
> across 222 files. There is a working API, a working React app, an MCP surface, and a Docker image
> that runs the whole stack.
>
> Concretely, what works today: tenancy and session/OAuth/API-key auth; the append-only ledger kernel
> and trial balance; chart of accounts, contacts, dimensions, and fiscal periods; invoices, bills,
> credit notes, payment application and tax; bank import, matching and reconciliation; the reporting
> suite including cash-basis and cash flow; invoice delivery (PDF + hosted page + email), recurring
> invoices and dunning; OCR bill capture; Stripe/Square payment processing; and the platform surface
> (OAuth 2.1 AS, MCP tools, event feed, change feed, external refs, agent review queue).
>
> Still ahead: **Pay Bills** disbursements (scaffolded, queue service not yet written), the
> **automations** engine (M6), and launch-readiness polish (M7 — onboarding, export, published spec).
>
> The full, honest inventory is in [**ROADMAP.md**](ROADMAP.md) (the per-subsystem status and every
> design decision, `D-01 … D-112`), and the developer/operator documentation is in
> [**docs/**](docs/README.md). If you are evaluating whether OpenBooks does something, read those.
>
> It is pre-release software: the schema is not yet frozen and there has been no production hardening
> pass. Do not put real books in this yet.

## What it is

A double-entry accounting system where the ledger is the only holder of financial state. Journals are
append-only: nothing updates or deletes a posting, and a correction is a reversing entry rather than
an edit. The application connects to the database as a user that does not hold `UPDATE` or `DELETE` on
the journal tables, so immutability is enforced by the database rather than by convention.

On top of that kernel: chart of accounts, contacts, invoicing and bills, bank import and
reconciliation, reporting, and a workflow engine — see [ROADMAP.md](ROADMAP.md) for what lands when.

## What makes it different

**Data ownership, and self-hosting that is actually the same product.** One Docker image. The hosted
service runs the exact artifact you can run yourself; there is no separate enterprise build, no
feature held back behind a hosted-only flag, and nothing in the image branches on which environment
it is in. Your ledger lives in a MySQL database you can point `mysqldump` at.

**Generic multi-dimension tagging.** Most systems give you a fixed pair of extra axes — a class and a
location, maybe a project — and then you are done. OpenBooks treats dimensions as a first-class,
user-defined concept: define the axes your business actually reports on, tag postings with them, and
slice any report by any combination. No schema change, no consultant.

**Bring-your-own-model AI.** The AI surface is an MCP server exposing the same service layer the REST
API uses. You connect the model you already pay for. There is no per-seat AI upcharge, no opaque
vendor model in the middle of your financial data, and no requirement to use the AI features at all.
Agent actions carry actor provenance on the journal itself, so "who posted this, and was it a human"
is a property of the ledger rather than a log line.

**User-directed automations.** Automations are described by you, proposed back to you, dry-run against
your real data, and only then activated. Nothing runs on your books because a vendor decided it was a
sensible default.

**No required third-party financial-data spend in v1.** No mandatory aggregator contract to open the
box. Bank data comes in by file import, and the bank-feed provider interface exists for those who
want to add a paid feed later. The floor on running OpenBooks is your own infrastructure.

## Integrations are an API product, not a docs page

The public REST API is a first-class product surface, not the private backend of the web app with
documentation bolted on afterwards. Concretely:

- The React frontend is a client of the public API and has no privileged path. If the frontend can do
  it, an integrator can do it, because it is the same endpoint.
- Third-party applications integrate as **OAuth clients** with scoped, revocable access — not with a
  shared admin credential.
- Every write endpoint takes an `Idempotency-Key`. Retries are safe by design, not by luck.
- The OpenAPI description is generated from the same Zod schemas that validate requests at runtime,
  committed to the repository, and drift is a build failure. Published spec and actual behaviour
  cannot diverge.
- There is a change feed and an event bus for integrators who need to follow activity rather than poll
  it.

This posture is also why the server is AGPL and the contract packages are not: building an
integration as an external API client involves no combination with copyleft code at all. See
[Licensing](#licensing).

## Self-host quickstart

This brings up the full stack — a working API, worker, database, and web app. It is pre-release
software (see the status note above), so it is for evaluation and development, not yet your real
books.

Requires Docker with Compose v2. Nothing else.

```sh
git clone https://github.com/OpenBooksAccounting/OpenBooks.git
cd OpenBooks
cp .env.example .env
```

Open `.env` and set the values it tells you to set — it documents every variable and marks which
defaults are development-only. Then:

```sh
docker compose up
```

The stack is MySQL 8, a `migrate` service that runs to completion and exits, and an `api` service that
starts only after migrations have exited zero. Migrations never run on container boot; they are a
discrete job, in Compose and in production alike.

One image serves all three processes, selected by `OPENBOOKS_ROLE=api|worker|migrate`. An unrecognised
role fails the process at startup rather than quietly defaulting to something else.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including the non-negotiables you should
know before writing any code.

The short version — Node 22, Docker, and **do not install Yarn globally** (4.17.1 is committed in
`.yarn/releases/` and pinned by `packageManager`):

```sh
nvm use
yarn install
yarn check      # format:check, lint, lint:tokens, lint:deps, typecheck, drift, build, test
```

`yarn test` runs against real MySQL 8 in testcontainers, so Docker has to be running. Full developer
and operator documentation lives in [docs/](docs/README.md).

## Stack

| Layer    | Choice                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| Runtime  | Node 22, TypeScript 5.9 in strict mode                                        |
| API      | Fastify 5 with Zod schemas as the single source of validation, types, spec    |
| Data     | MySQL 8 via Kysely, with Kysely's migrator and generated schema types         |
| Frontend | React with Vite, React Router, TanStack Query, typed client from OpenAPI      |
| AI       | MCP server over the same service layer as the REST API                        |
| Tests    | Vitest, fast-check for ledger invariants, testcontainers for real MySQL       |
| Tooling  | Yarn 4 workspaces, ESLint flat config, dependency-cruiser, Prettier           |
| Delivery | One Docker image with three roles, Terraform for the hosted stack, GH Actions |

## Repository layout

```
packages/
  server/         Fastify API, MCP server, worker, ledger kernel, migrations
  web/            React SPA — a client of the public API, with no privileged access
  shared-types/   Zod schemas: validators, types, and the OpenAPI source, all at once
  plugin-api/     The internal module contract. Apache-2.0 — see Licensing
  eslint-plugin/  Project-specific lint rules that enforce the ledger's invariants
infra/            Terraform for the hosted stack, plus database bootstrap
scripts/          Build scripts
```

Every module is written against `@openbooks/plugin-api` and nothing else in the tree. The ledger
kernel is the one module that _implements_ the posting contract; everything else consumes it.

## Roadmap

[ROADMAP.md](ROADMAP.md) has the milestone map, the M1 ticket board with its dependency graph, the
decisions taken while scoping and why, and the known risks. Minimum credible public launch is M1
through M4 plus QuickBooks import.

## Licensing

OpenBooks is dual-licensed. [NOTICE](NOTICE) is the authoritative map; the summary is:

| Scope                                                       | License                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The server, the web app — everything by default             | **AGPL-3.0-only** — [LICENSE](LICENSE)                                                               |
| `packages/plugin-api` and the published OpenAPI description | **Apache-2.0** with a linking exception — [packages/plugin-api/LICENSE](packages/plugin-api/LICENSE) |

The server is AGPL because OpenBooks is run as a hosted service from the same image it ships for
self-hosting, and the AGPL's network-use provision is what keeps a hosted fork from taking the work
private.

The contract packages are permissive because their entire purpose is to be built against, and a
copyleft license on an interface definition defeats that. The linking exception makes it explicit that
depending on those interfaces does not by itself pull your module under the AGPL.

The exception is deliberately narrow: it does not grant permission to ship a combined work of the
AGPL server plus a bundled proprietary module. If you are building a commercial product on top of
OpenBooks, integrate as an external OAuth client of the public API — that involves no combination with
AGPL code and carries no copyleft exposure. The same functionality shipped as an in-process module
does. That asymmetry is intentional, and it is why the API is treated as a real product surface.

Contributions require a signed CLA. See [CLA.md](CLA.md) for the agreement and the reasoning, and
[CONTRIBUTING.md](CONTRIBUTING.md) for everything else.

_The license files in this repository are the licenses themselves; this section is a summary and is
not legal advice._
