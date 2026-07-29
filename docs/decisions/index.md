# Design Decisions Index

The authoritative record of design decisions is [`ROADMAP.md`](../../ROADMAP.md) — search it for a
decision by its `D-NN` number to get the full reasoning and any deviation from the v1 spec. This page
is a **pointer**: it maps the decisions that shape the architecture to the docs that explain their
consequences, so you can move from "why is it like this?" to the explanation quickly.

> This index is curated, not exhaustive — it covers the decisions referenced across this
> documentation. `ROADMAP.md` holds the complete list (`D-01 … D-112`) with full context.

---

## Ledger & data model

| Decision | In short | Explained in |
| --- | --- | --- |
| **D-01** | The unsafe (unscoped) DB path must not exist — enforced two ways. | [Data & tenancy](../architecture/data-and-tenancy.md#the-raw-handle-is-fenced-off-two-ways) |
| **D-02** | Corrections are reversing entries, not edits. | [Ledger kernel](../architecture/ledger-kernel.md#corrections-are-reversing-entries) |
| **D-13** | Money is `bigint` minor units; a cents-string on the wire, never a JSON number. | [Money & invariants](../architecture/money-and-invariants.md#money-is-bigint-minor-units-end-to-end) |
| **D-14** | Gapless counters live in their own mutable tables (can't lock an append-only table). | [Ledger kernel](../architecture/ledger-kernel.md#the-gapless-sequence-counter) |
| **D-15** | Pre-release, migrations are edited in place. | [Data & tenancy](../architecture/data-and-tenancy.md#migrations) |
| **D-16 / D-19** | Drafts are non-financial; in no report, no invariant. | [Platform & AI → drafts](../features/platform-and-ai.md#drafts) |
| **D-34 / D-38** | No stored balances or statuses — everything recomputed. | [Sales / AR](../features/sales-ar.md#invoices--credit-notes) |
| **D-04** | Idempotency claim shares the write's transaction. | [Money & invariants](../architecture/money-and-invariants.md#idempotency-retries-are-safe-by-design) |

## Tenancy, config & delivery

| Decision | In short | Explained in |
| --- | --- | --- |
| **D-05** | The hosted Terraform is a validated design, never applied. | [Hosted infra](../guides/hosted-infra.md) |
| **D-07** | Provider seams: an interface + env selection; each adapter ships with its first consumer. | [Providers & config](../architecture/providers-and-config.md#the-local-vs-hosted-idiom-d-07) |
| **D-08 / D-17** | Dates are `YYYY-MM-DD` strings, never `Date`. | [Foundation → periods](../features/foundation.md#periods--the-accounting-calendar-and-the-posting-gate) |
| **D-24** | The three-layer design-token system; no speculative component library. | [Frontend](../features/frontend.md#design-tokens--theming) |
| **D-25** | The permission list the UI gets is advisory; routes are never permission-gated. | [API & transport](../architecture/api-and-transport.md#the-one-advisory-list) |
| **D-26** | E2E is one narrative per milestone, not a suite. | [Testing](../guides/testing.md#end-to-end-playwright) |

## Product behaviour

| Decision | In short | Explained in |
| --- | --- | --- |
| **D-18** | User-defined dimensions replace fixed Class+Location. | [Foundation → dimensions](../features/foundation.md#dimensions--user-defined-reporting-axes) |
| **D-37** | Payments always have a journal; over-payment is a credit, not an error. | [Banking & cash](../features/banking-and-cash.md#payments--allocation) |
| **D-40** | Aging buckets tie exactly to the control account. | [Reporting & tax](../features/reporting-and-tax.md) |
| **D-41** | No mandatory bank-feed aggregator in v1 — file import. | [Providers & config](../architecture/providers-and-config.md) |
| **D-42 / D-43 / D-44** | Statement dedupe; matching/rules propose, never post. | [Banking & cash](../features/banking-and-cash.md#the-banking-pipeline) |
| **D-45 / D-51** | Reconciliation is a separate lock; membership frozen at finalize. | [Banking & cash](../features/banking-and-cash.md#reconciliation) |
| **D-46** | A bank account is a ledger account + import metadata. | [Banking & cash](../features/banking-and-cash.md#bank-accounts) |
| **D-76 / D-77** | Recurring once-per-cycle guard; dunning once-per-stage guard. | [Sales / AR](../features/sales-ar.md#recurring-invoices--dunning) |
| **D-87** | Cash basis supersedes accrual-only. | [Reporting & tax](../features/reporting-and-tax.md#accrual-vs-cash-basis) |
| **D-105 / D-106** | Multi-entry bank clearing; discount as a `discount_journal_id` allocation. | [Banking & cash](../features/banking-and-cash.md#clearing--the-one-write-path) |

## Platform, AI & payments

| Decision | In short | Explained in |
| --- | --- | --- |
| **D-53 / D-61** | Opaque tokens (not JWT); build-to-spec AS with an external review owed. | [Security](../architecture/security.md) |
| **D-54** | OAuth effective scope recomputed against the live role every request. | [API & transport](../architecture/api-and-transport.md#oauth-scope-narrowing) |
| **D-55** | An API key carries its own role, not the issuer's. | [Platform & AI → API keys](../features/platform-and-ai.md#api-keys) |
| **D-56 / D-57 / D-58** | Transactional outbox; change feed is a projection; external refs. | [Platform & AI](../features/platform-and-ai.md#events--the-transactional-outbox) |
| **D-59 / D-60** | MCP write tool lands a draft; no execute path; approver bundles both permissions. | [Platform & AI → MCP](../features/platform-and-ai.md#mcp--the-ai-tool-surface) |
| **D-82 / D-84 / D-101 / D-104** | Processor as clearing account; fee account; secrets table; connection model. | [Payments processing](../features/payments-processing.md) |
| **D-102** | A `fake` processor drives the gate; real Stripe/Square are sandbox-proven. | [Payments processing](../features/payments-processing.md#adapters) |
| **D-109 … D-112** | Pay Bills: SoD keys, rails-as-tags, cheque-only internal, reused discount. | [Purchases / AP → Pay Bills](../features/purchases-ap.md#pay-bills--disbursements) |

---

For any decision not listed here, search [`ROADMAP.md`](../../ROADMAP.md) for `D-NN` — every decision
there records what changed and why.
