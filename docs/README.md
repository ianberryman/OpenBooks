# OpenBooks Documentation

Open-source, AI-native, modular double-entry accounting. A real general ledger with immutable
journals, arbitrary reporting dimensions, and an MCP surface you point your own AI model at.
Ships as a single Docker image you can self-host, and is operated as a hosted service from that
same image.

This is the developer and operator documentation. It explains **how the system is built**, **what
each subsystem does**, and **how to run, develop, and deploy it**. For the execution history and
the full record of design decisions (`D-01 … D-112`), see [`ROADMAP.md`](../ROADMAP.md); for
working notes and the non-negotiables, see [`CLAUDE.md`](../CLAUDE.md).

> **Project status.** M1–M5 plus the post-M4 initiatives (invoicing & delivery, cash application,
> Stripe/Square payments, QuickBooks import) are **built and gate-green** (2,501 tests). The
> minimum credible public-launch bar (M1–M4 + QuickBooks import) is met. Automations (M6) and
> launch-readiness polish (M7) remain. See [features/overview.md](features/overview.md) for the
> per-subsystem build status.

---

## Start here

Pick the path that matches why you're reading:

| You are…                   | Read, in order                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evaluating the project** | This page → [Architecture overview](architecture/overview.md) → [Features overview](features/overview.md)                                                                                |
| **A new developer**        | [Getting started](guides/getting-started.md) → [Architecture overview](architecture/overview.md) → [Development](guides/development.md) → [Adding a feature](guides/adding-a-feature.md) |
| **Working in the ledger**  | [Ledger kernel](architecture/ledger-kernel.md) → [Data & tenancy](architecture/data-and-tenancy.md) → [Money & invariants](architecture/money-and-invariants.md)                         |
| **Operating / deploying**  | [Deployment](guides/deployment.md) → [Hosted infra](guides/hosted-infra.md) → [CI](ci.md)                                                                                                |

---

## Map of the documentation

### Architecture — how it holds together

| Doc                                                             | Covers                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [overview.md](architecture/overview.md)                         | System shape, the monorepo packages, request lifecycle, one-image/three-role model, licensing split.                  |
| [ledger-kernel.md](architecture/ledger-kernel.md)               | Append-only journals enforced by the database, reversing entries, the single writer, locking order, actor provenance. |
| [data-and-tenancy.md](architecture/data-and-tenancy.md)         | `tenantDb()`/`systemDb()`, composite-key tenancy, the hidden raw handle, ambient transactions, migrations.            |
| [money-and-invariants.md](architecture/money-and-invariants.md) | Cents-string money end to end, the invariant/property-testing philosophy, idempotency, 404-not-403.                   |
| [api-and-transport.md](architecture/api-and-transport.md)       | Fastify layering, "transport holds no logic," Zod→OpenAPI drift gate, permissions, error taxonomy.                    |
| [providers-and-config.md](architecture/providers-and-config.md) | Swappable provider seams, self-host-vs-hosted idiom, config validation & fail-fast.                                   |
| [security.md](architecture/security.md)                         | Threat model: immutability, cross-org indistinguishability, auth surfaces, OAuth scope narrowing, owed reviews.       |

### Features — what it does

| Doc                                                       | Covers                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [overview.md](features/overview.md)                       | Feature map by area, build status, and the migration each subsystem owns.                                    |
| [foundation.md](features/foundation.md)                   | Orgs, members, auth, permissions/roles, periods, dimensions, chart of accounts, contacts, settings.          |
| [sales-ar.md](features/sales-ar.md)                       | Invoices & credit notes, payment terms, delivery (PDF + hosted page + email), branding, recurring & dunning. |
| [purchases-ap.md](features/purchases-ap.md)               | Bills & vendor credits, OCR bill capture, Pay Bills disbursements.                                           |
| [banking-and-cash.md](features/banking-and-cash.md)       | Statement import → matching → clearing → reconciliation, cash receipts & allocation, settlement discounts.   |
| [payments-processing.md](features/payments-processing.md) | Stripe/Square as a clearing account, webhooks & polling, secrets.                                            |
| [reporting-and-tax.md](features/reporting-and-tax.md)     | Trial balance, P&L, balance sheet, GL, aging, cash-basis, cash flow; tax rates.                              |
| [platform-and-ai.md](features/platform-and-ai.md)         | OAuth 2.1 AS, API keys, MCP tools, event outbox & change feed, external refs, agent review queue, drafts.    |
| [frontend.md](features/frontend.md)                       | The React SPA: structure, screens, the org-switch cache-clear pattern, design tokens.                        |

### Guides — run, develop, update, deploy

| Doc                                                             | Covers                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [getting-started.md](guides/getting-started.md)                 | Prerequisites, `docker compose up`, and the host-process dev loop.                           |
| [development.md](guides/development.md)                         | Repo tour, the `yarn check` gate, custom lint rules & architectural boundaries, conventions. |
| [testing.md](guides/testing.md)                                 | Real-MySQL testcontainers, property tests, "prove contention," Playwright E2E.               |
| [database-and-migrations.md](guides/database-and-migrations.md) | Migration conventions, `migrate`/`codegen`/`drift`, and the reset runbook.                   |
| [adding-a-feature.md](guides/adding-a-feature.md)               | End-to-end walkthrough: schema → service → route → spec → client → screen → tests.           |
| [deployment.md](guides/deployment.md)                           | The Docker image, the Compose prod stack, nginx same-origin proxy, migrations-as-a-job.      |
| [hosted-infra.md](guides/hosted-infra.md)                       | Terraform topology, the never-applied caveat, two-DB-user bootstrap.                         |
| [ci.md](ci.md)                                                  | The CI pipeline (operator guide; existing).                                                  |

### Reference

| Doc                                      | Covers                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [glossary.md](glossary.md)               | Accounting and system terms used throughout.                      |
| [decisions/index.md](decisions/index.md) | Index from `D-NN` decision numbers to the docs that explain them. |

---

## A one-paragraph orientation

The **ledger is the only holder of financial state**. Journals are append-only — nothing updates
or deletes a posting; a correction is a _reversing_ entry. This is enforced by the **database**,
not by convention: the application connects as a MySQL user that holds no `UPDATE`/`DELETE` on the
journal tables. On top of that kernel sit the business subsystems (chart of accounts, contacts,
invoicing, bills, banking, reporting) and a platform layer (OAuth, MCP, event feed). Everything is
one **Fastify** API whose **Zod** schemas are the single source of validation, types, _and_ the
published **OpenAPI** spec; the **React** SPA is just another client of that API. The whole thing
ships as **one Docker image** that runs as `api`, `worker`, or `migrate` depending on a single
environment variable.
