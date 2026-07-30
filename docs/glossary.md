# Glossary

Accounting and system terms as OpenBooks uses them. Where a term maps to a specific subsystem, the
relevant doc is linked.

---

### Accounting concepts

**Journal** — one balanced double-entry transaction: a header plus two or more lines whose debits
equal credits. Append-only. See [Ledger kernel](architecture/ledger-kernel.md).

**Journal line** — one side of a journal: a debit *or* a credit against one account, a positive
amount. One-sided by CHECK constraint.

**Reversing entry** — the *only* way to correct a posted journal: a new journal with every line's
debit/credit swapped and `reverses_journal_id` set. There is no edit or delete.

**Double-entry** — every transaction affects at least two accounts and always balances. The invariant
the whole system protects.

**Chart of accounts (CoA)** — the org's list of accounts (assets, liabilities, equity, revenue,
expense). See [Foundation → accounts](features/foundation.md#accounts--the-chart-of-accounts).

**Normal balance** — whether an account increases on the debit or credit side. Stored, not derived —
contra accounts are real.

**Control account** — the account a subledger (AR, AP) rolls up into. Approved invoices/bills post
against the org's nominated control accounts.

**Subledger** — the detailed records (invoices, bills, payments) behind a control-account balance. Its
total must agree with the control account (spec §11).

**Trial balance** — every account's balance at a point in time; total debits equal total credits. The
**oracle** every property test checks against. See [Reporting](features/reporting-and-tax.md).

**Fiscal period** — an accounting calendar span. Posting into a *locked* period is refused. See
[Foundation → periods](features/foundation.md#periods--the-accounting-calendar-and-the-posting-gate).

**Accrual vs cash basis** — accrual recognises revenue/expense when earned/incurred; cash basis when
money moves. The org picks a default reporting basis.

**AR / AP** — Accounts Receivable (owed *to* you, invoices) / Accounts Payable (owed *by* you, bills).

**Allocation** — applying a payment, credit note, or discount against a document to reduce what's
outstanding. Posts no journal of its own (both sides already exist). See
[Banking & cash](features/banking-and-cash.md#payments--allocation).

**Aging** — outstanding AR/AP bucketed by how overdue it is. Bucket sums tie exactly to the control
account.

**Dunning** — the process of chasing overdue invoices with staged reminders. See
[Sales / AR](features/sales-ar.md#recurring-invoices--dunning).

**Settlement / early-pay discount** — a reduction for paying within a discount window (e.g. "2/10 net
30"). One shared posting primitive across AR and AP.

**Reconciliation** — asserting a bank statement's closing balance against the ledger's cleared lines.
A separate lock from period close. See [Banking & cash](features/banking-and-cash.md#reconciliation).

**Clearing account** — a holding account for money in transit: a bank line before it's coded, or a
card charge before payout. Central to both banking and payment processing.

**Dimension** — a user-defined reporting axis (Department, Project, …) tagged per journal line.
Replaces QuickBooks' fixed Class+Location. See
[Foundation → dimensions](features/foundation.md#dimensions--user-defined-reporting-axes).

---

### System concepts

**Org (organisation)** — the tenant boundary. All financial data belongs to exactly one org.

**Tenant table** — a table with a non-null `org_id`, reachable only through `tenantDb(orgId)`. See
[Data & tenancy](architecture/data-and-tenancy.md).

**`tenantDb()` / `systemDb()`** — the two sanctioned database entry points. `tenantDb` auto-scopes
every query to one org; `systemDb` serves the few non-tenant tables.

**Minor units** — money as a whole number of cents, held as `bigint`, a cents-string on the wire
(`"150000"`). Never a float, never a JSON number. See
[Money & invariants](architecture/money-and-invariants.md).

**Idempotency key** — a client-supplied header making a write safe to retry: exactly one execution
under a race, no poison on failure. Required on every write.

**Actor provenance** — who (or what) performed an action: `actorType` ∈ user/automation/agent, plus
`actorId`, carried on the journal itself and on every log line.

**Provider seam** — a swappable interface (queue, storage, secrets, email, extraction, payment) chosen
by config, with a zero-dependency self-host default and a hosted adapter. See
[Providers & config](architecture/providers-and-config.md).

**Role (process role)** — `api`, `worker`, or `migrate`; which process the one image becomes, set by
`OPENBOOKS_ROLE`.

**Role (permission role)** — a named bundle of permissions a member holds in an org (owner,
bookkeeper, ap_only, …).

**Capability token** — a bearer secret that *is* the whole authorization for a resource, with no
session — e.g. the hosted-invoice page's per-delivery token.

**Draft** — a mutable, pre-posting journal workspace: in no report, no sequence number, no period. The
AI `journal.propose` tool lands one. See [Platform & AI → drafts](features/platform-and-ai.md#drafts).

**Change feed / event log** — the transactional outbox integrators follow to track activity, per-org
ordered, resumable by cursor. See [Platform & AI](features/platform-and-ai.md#events--the-transactional-outbox).

**External ref** — a bidirectional map from an integrator's own id to an OpenBooks entity;
"idempotency for relationships."

**MCP (Model Context Protocol)** — the JSON-RPC tool surface an AI model connects to. Reads plus one
propose-only write. See [Platform & AI](features/platform-and-ai.md#mcp--the-ai-tool-surface).

**Drift** — a mismatch between a generated artifact (OpenAPI spec, typed client, Kysely types) and its
source. A build failure by design.

**The gate** — `yarn check`: the eight-step command that must pass for a change to be mergeable. See
[Development](guides/development.md#the-gate-yarn-check).

**D-NN** — a numbered design decision recorded in [`ROADMAP.md`](../ROADMAP.md). See
[decisions/index](decisions/index.md).

**OB-NNN** — a work ticket in the roadmap's board.
