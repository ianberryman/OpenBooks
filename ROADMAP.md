# OpenBooks — Development Roadmap

Derived from `OpenBooks — v1 Development Scope`. This file is the execution plan; the spec
remains the source of truth for intent. Where this roadmap deviates from the spec, the
deviation is recorded in [Decisions](#decisions) with a reason.

---

## Milestone map

| Milestone | Spec phase | Outcome                                                                                                                                                                                   | Status                         |
| --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **M1**    | Phase 0    | Walking skeleton — tenancy, session auth, ledger kernel, trial balance, invariant tests, Docker/CI/IaC                                                                                    | **Built — see Status below**   |
| M2        | Phase 1    | Manual bookkeeping usable — CoA, contacts, dimensions, JE UI, P&L / BS / GL                                                                                                               | **Built — see Status below**   |
| M3        | Phase 2    | AR/AP — invoices, bills, credit notes, payment application, tax, aging                                                                                                                    | **Built — see Status below**   |
| M4        | Phase 3    | Banking — import, matching pipeline, reconciliation _(largest phase)_                                                                                                                     | **Built — see Status below**   |
| **M5**    | Phase 4    | Platform surface — OAuth AS, MCP tools, event bus, change feed, `external_refs`                                                                                                           | **Built — see Status below**   |
| M6        | Phase 5    | Automations — workflow engine, dry run, activation flow                                                                                                                                   | Not scoped                     |
| M7        | Phase 6    | Launch readiness — QB import, onboarding, export, docs, published spec                                                                                                                    | Not scoped                     |
| **PB**    | _(none)_   | Pay Bills & disbursements — batch pay-bills, pending-payment queue, rails, settlement discounts                                                                                           | **Built — gate-green**         |
| **INV**   | _(none)_   | Invoicing — themed PDF + hosted-page delivery, recurring invoices, full dunning                                                                                                           | **Scoped — see below**         |
| **CA**    | _(none)_   | Cash application — payment terms, multi-entry bank clearing (lockbox), discount suggestion                                                                                                | **Built — gate-green**         |
| **PAY**   | _(none)_   | Payment integration — Stripe/Square, processor-as-clearing-account, hosted checkout                                                                                                       | **Built — gate-green**         |
| **K–P**   | _(none)_   | Reporting (cash basis, cash flow) · fixed assets & recurring journals **(L — built)** · procure-to-pay **(M — built)** · budgets **(N — built)** · OCR · accountant/close **(P — built)** | **Scoped — L, M, N, P built**  |
| **M6**    | Phase 5    | Automations — realised as a polled agent work queue, MCP-only (Q) — OpenBooks holds no model credentials                                                                                  | **Built — gate-green (2,726)** |
| **R**     | _(none)_   | Responsive web & mobile-ready shell — a phone-width pass over all ~36 screens, nav drawer, dialog sheets; leaves the SPA Capacitor-ready (OB-211…219)                                     | **Scoped — next milestone**    |

Minimum credible public launch is M1–M4 plus QuickBooks import. Eleven enhancements sit outside the
spec's phase order — scoped from session conversation, sequenced by decision, not by phase. **AP/AR
payments:** Pay Bills (PB, OB-109…119, G, [D-63](#d-63)…[D-69](#d-69)), Invoicing (INV, OB-120…133, H,
[D-70](#d-70)…[D-78](#d-78)), Cash application (CA, OB-134…142, I, [D-79](#d-79)…[D-81](#d-81)),
Payment integration (PAY, OB-143…153, J, [D-82](#d-82)…[D-86](#d-86)). **Accounting depth & platform:**
Reporting/cash-basis (K, OB-154…161), Fixed assets & recurring journals (L, OB-162…169), Procure-to-pay
(M, OB-170…179), Budgets (N, OB-180…184), OCR capture (O, OB-185…191), Accountant & close (P,
OB-192…199), and **M6 Automations** — the polled agent work queue, MCP-only (Q, OB-200…210) — decisions
[D-87](#d-87)…[D-100](#d-100). **Payment terms** ([D-79](#d-79)) generalise the discount primitive
([D-66](#d-66)) across AP and AR; cash basis ([D-87](#d-87)) supersedes accrual-only ([D-22](#d-22)).

### Candidate milestones — competitive-gap placeholders (not scoped)

One placeholder per item on the [competitive gap analysis](#competitive-gap-analysis--candidate-initiatives-vs-quickbooks--xero-future) below. These are **not scoped or owner-sequenced** — the codes are provisional handles, not a commitment to build order (two, `TAX` and `PAYROLL`, are explicit _partner-not-build_ calls). Each links to its detail section; the tier is from the gap sweep.

| Code          | Tier | Candidate                                        | Ticket(s)   | Status                              | Detail                                                                                                                                                                                        |
| ------------- | ---- | ------------------------------------------------ | ----------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FEEDS**     | T1   | Live bank feeds + credit-card/liability recon    | OB-227/227b | **Built — gate-green**              | [feeds](#follow-up--live-bank-feeds-via-a-bankfeedprovider-seam-stripe-financial-connections-first-ob-227-built--gate-green) · [recon](#ob-227b--credit-card--liability-reconciliation-built) |
| **STMT**      | T1   | Customer statement of account + CSV/xlsx export  | OB-220      | **Built — gate-green**              | [statement & export](#follow-up--statement-of-account--report-export-table-stakes-ob-220-built)                                                                                               |
| **DIM-UI**    | T1   | Per-line dimensions on the AR/AP editors         | —           | **Backend done — UI pending**       | [document-line dimensions](#follow-up--the-document-line-ui-redesign-must-restore-per-line-dimensions)                                                                                        |
| **1099**      | T1   | 1099 contractor tax reporting (NEC/MISC, e-file) | OB-228      | **Placeholder — not scoped**        | [Milestone 1099](#milestone-1099--contractor-tax-reporting-1099-necmisc-ob-228-future)                                                                                                        |
| **TAX**       | T1   | Sales-tax automation (nexus/jurisdiction)        | OB-221      | **Placeholder — partner**           | [sales-tax automation](#follow-up--sales-tax-automation-via-a-pluggable-tax-provider-ob-221-future)                                                                                           |
| **PAYROLL**   | T2   | Payroll                                          | OB-223      | **Placeholder — partner (Gusto)**   | [payroll](#follow-up--payroll-via-a-pluggable-provider-integration-ob-223-future)                                                                                                             |
| **INVENTORY** | T2   | Tracked inventory & COGS                         | OB-224      | **Placeholder — not scoped**        | [Milestone INVENTORY](#milestone-inventory--tracked-inventory--cogs-ob-224-future)                                                                                                            |
| **PROJ**      | T2   | Projects / job costing / time tracking           | OB-225      | **Placeholder — not scoped**        | [projects & job costing](#follow-up--projects-job-costing--time-tracking-ob-225-future)                                                                                                       |
| **ROLES**     | T2   | Custom role builder                              | OB-226      | **Placeholder — not scoped**        | [custom role builder](#follow-up--custom-role-builder-ob-226-future)                                                                                                                          |
| **MOBILE**    | T3   | Native mobile app (Capacitor shell)              | OB-232      | **Placeholder — not scoped**        | [Milestone MOBILE](#milestone-mobile--native-app-shell-via-capacitor-ob-232-future)                                                                                                           |
| **MULTI**     | T3   | Multi-entity consolidation                       | OB-233      | **Placeholder — not scoped**        | [multi-entity consolidation](#follow-up--multi-entity-consolidation-ob-233-future)                                                                                                            |
| **MILEAGE**   | T3   | Mileage tracking                                 | OB-234      | **Placeholder — folds into MOBILE** | [mileage tracking](#follow-up--mileage-tracking-ob-234-future)                                                                                                                                |
| **FX**        | T3   | Multi-currency                                   | OB-222      | **Placeholder — market-gated**      | [multi-currency](#multi-currency--a-community-contribution-candidate-not-a-core-milestone-ob-222-market-gated)                                                                                |

Two operational placeholders sit outside the competitive sweep: the [OSS & self-host readiness](#open-source--self-host-readiness-ob-229ob-231) items (OB-229…231) and [evaluate AWS deployment architecture](#operations--evaluate-aws-deployment-architecture-ob-235-future) (OB-235).

---

## Release plan — post-M4 sequencing

The scoped work (M5 + the eleven session initiatives) sequenced for a credible public launch, with
depth staged after. The launch bar is deliberately **higher than the map's "M1–M4 + QB import"**:
today an invoice cannot be **delivered** and there is no **cash-basis** P&L, and most customers file
cash-basis — so both are launch-blocking, not enhancements.

| Phase                                   | Work                                                                                   | Why here                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **0 — Unblock** (days)                  | OB-093 (AR/AP roles can post — the Pay Bills prerequisite), OB-091, OB-092             | High-leverage, tiny; clears known gaps                                                                 |
| **1 — Invoice delivery + foundations**  | **INV** core — delivery (PDF, theme, hosted page, email) + StorageProvider + scheduler | Closes "can't send an invoice"; builds the foundations later phases reuse                              |
| **2 — Cash-basis reporting**            | **K**                                                                                  | The majority's P&L; ledger-kernel rigor; edges flagged for manual review                               |
| **3 — Migration gate → 🚀 LAUNCH**      | QB import (M7's import)                                                                | Minimum credible public launch                                                                         |
| **4 — Automate the busywork**           | INV **recurring + dunning** (the rest of INV) + **OCR (O)**                            | Reuses the Phase-1 scheduler + storage; cuts manual work — prioritised **ahead of Stripe** by decision |
| **5 — Get paid online**                 | M5-core (`external_refs` + event bus) + D-79 fee primitive → **PAY** (Stripe/Square)   | Sequenced **after OCR and recurring/dunning** by decision                                              |
| **6 — Payment loop + accounting depth** | **CA**, **PB**, then **L**, **M**, **N**, **P**                                        | Operational completeness + the accountant/mid-market wedge                                             |
| **7 — Platform & AI**                   | M5-platform (OAuth/MCP + agent-review queue), then **Q (M6)**                          | The AI-forward layer, on the proven core                                                               |

**Dependency notes:** INV's StorageProvider and scheduler (Phase 1) are prerequisites for OCR,
recurring/dunning, L, P and Q. PAY (Phase 5) needs M5-core (`external_refs`) and the D-79 discount/fee
primitive, so a slice of M5 and of CA is pulled into Phase 5. OCR (Phase 4) stands alone on storage +
the worker, but feeds Q later; Q (Phase 7) needs M5-platform's agent-review queue (OB-105).

---

## Where things stand

**M1–M4 are built, and the QuickBooks import is done — the minimum credible public launch bar
(M1–M4 + QuickBooks import) is now MET. 🚀** Read this section first; the per-milestone Status
sections below carry the detail.

|        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch | `develop`, working tree clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Gate   | `yarn check` passes — **2,859 tests across 280 files**, ~3 min (the +22/+3 over 2,837/277 are OB-227 live bank feeds and OB-227b credit-card reconciliation) (the +103/+16 over the pre-R 2,734/261 are the document-UI redesigns' component suites plus the two new summary endpoints). **Local-only: the CI workflow is deliberately disabled** — `.github/workflows/ci.yml` was renamed to **`ci.yml.disabled`** (`c3d2afb`) so GitHub Actions runs nothing (no auto, no manual dispatch); re-enable with `git mv` back. Thirteen milestone E2Es (`cash-basis`, `quickbooks-import`, `recurring-and-dunning`, `bill-capture`, `platform-oauth-mcp` (M5), `payment-integration` (PAY), `cash-application` (CA), `pay-bills` (PB), `procure-to-pay` (M), `fixed-assets-and-recurring-journals` (L), **`budgets`** (N), **`accountant-and-close`** (P), plus the M1–M4 narratives) — all authored, `yarn check`-clean and stack-runnable but not executed by the gate (which is `yarn e2e`). **Initiative R adds a 14th, `mobile-smoke` (its own `mobile` Playwright project, iPhone-13 viewport on Chromium), and it _was_ executed and passes at 390px — the one narrative run rather than merely authored**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Push   | **Pushed — `develop` is at `origin/develop` (through `169a7c2`, OB-227b credit-card reconciliation; OB-227 live bank feeds is `46700f9`).** The earlier "unpushed / no credentials" note was wrong: `git push origin develop` over HTTPS succeeds from this machine. **Dependabot pass DONE** — a root `resolutions` block clears the actionable set (4 high + 1 moderate): `@fastify/static`→`10.1.2` (both static alerts — route-guard bypass + non-canonical-URL authz; no patched 9.x exists, and swagger-ui 6 tolerates static 10 on fastify 5, gate-confirmed), `js-yaml`→`4.3.0` (merge-key quadratic-CPU DoS; stays in 4.x for `@redocly/openapi-core`), and `brace-expansion`'s `^2.x` line→`5.0.9` (unbounded-expansion OOM — **there is no patched 2.x**, so `minimatch@5.1.9`'s dep was forced up a major; API is stable, gate-confirmed). Gate green afterward (2,741 tests). **Two deliberate skips, both documented:** `react-router` (high, GHSA-qwww-vcr4-c8h2) is the RSC-mode CSRF path, **unreachable** — the web app is a Vite SPA on plain `<BrowserRouter>` with no data router (`App.tsx:47`), and the fix is a react-router 8 major bump; and `glob@10.5.0` (via `archiver-utils`) is a **deprecation notice, not a CVE**. (`https://github.com/OpenBooksAccounting/OpenBooks/security/dependabot`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Next   | **CURRENT STATE (latest session): [OB-220](#follow-up--statement-of-account--report-export-table-stakes-ob-220-built) is now BUILT and gate-green (2,918 tests / 286 files) — customer statement of account (open-item, = AR aging scoped to one contact, rendered to a branded PDF, downloadable + emailable via a hosted `/public/statements/{token}/pdf` link; migration `0022`, `reports.read`, no new catalog key) and report CSV/Excel export (`GET /v1/reports/export`, a hand-rolled dependency-free CSV + `.xlsx` writer over the existing report services). Built via the orchestrated fan-out (Opus owns the schema/codegen/contracts/seams + integration; four Sonnet worktree streams authored the disjoint statement-backend / export-backend / statement-web / export-web against pinned contracts). Integration caught the usual pinned tripwires the isolated streams can't run (harness migration list, grants append-only list, permission-matrix + cross-org coverage for the new ops + the public token, a web `getByText` collision, and a `no-circular` dep-cruiser edge on the export control) plus one real seam fix (the public link retargeted from `/s/{token}` to the invoice `/public/*` prefix, which also added the missing prod-nginx `/public/` proxy). Deferred + flagged: document-list export and projection/audit export. **One environment note: the whole-repo `eslint .` OOMs at the default ~4GB heap on this machine — the _baseline_ tree OOMs identically, so it is pre-existing and unrelated to OB-220; every changed file lints clean when linted directly.** The remaining smaller alternative is the per-line-dimensions AR/AP-editor UI follow-up ([[dimensions-ui-followup]]).** — Historical context follows. The prior thread: the whole live-bank-feed thread is closed — OB-227 (live feeds, Stripe Financial Connections, BYO key, asset accounts) and OB-227b (credit-card/liability reconciliation via a normal-frame presentation transform, D-227b-1) are both BUILT and pushed (`169a7c2`). **Phases 1–3 are DONE — launch bar met.** Phase 1 (INV delivery), Phase 2 (K, cash-basis) and Phase 3 (QuickBooks CSV import: chart + contacts + opening trial balance → one opening journal, fiscal year auto-generated) are all committed with green gates and browser narratives. Phase 2's E2E caught a real transport defect (`basis` never crossed the wire schema; fixed `2cd50df`). QB import is CSV-only by decision — `.qbo`/OFX deferred. **Next: Phase 4 — automate the busywork: INV recurring + dunning first, then OCR (O, decided to use a pluggable OcrProvider).** Correction to an earlier note: Phase 1 did **not** ship a scheduler — it shipped StorageProvider, the email send-path, `org_branding`, `invoice_deliveries` and the hosted page. The scheduler is OB-127 and is the **first** Phase-4 deliverable. **The schema (OB-122), the scheduler (OB-127), and both engines (OB-128 recurring, OB-129 dunning) + their routes (OB-130) are now BUILT** — `0008_recurring_dunning` schema (`258e382`), the `runAsAutomation` + daily-tick seam (`eba3c5e`), and the two engines integrated and wired into both entrypoints with a manual `POST /v1/scheduling/run-due-work` trigger (`1ab8a08`), all gate-green. Integration caught two real bugs: `runAsAutomation` set `invocation_mode` on an automation actor (agent-only per `chk_journals_invocation_mode`), and the recurring idempotency guard compared `last_run_date` to the already-advanced `next_run_date` instead of the dispatched cycle. **Phase 4 is now COMPLETE.** The UI shipped — the Recurring invoices screen (OB-133, `/recurring-invoices`) and the Dunning screen (OB-132, `/dunning`), each a list + create/edit dialog with pause/resume via `PATCH { isActive }` and one-way retire via `POST …/deactivate`; the dunning screen's read-only overdue panel reuses the AR aging report (`GET /v1/reports/aging`) since there is no dunning-specific overdue endpoint. Both wired into `App.tsx` routing and `nav.ts` (gated `invoices.read`, D-25 advisory-only), with colocated `.test.tsx` suites. The browser narrative is `packages/e2e/tests/recurring-and-dunning.spec.ts` (register → customer → recurring template due today → pause/resume → trigger `run-due-work` → dunning policy). One deliberate narrative gap: materialisation is asserted only as `run-due-work` → 200 + `runDate`, not as the invoice appearing on Sales — the in-process queue resolves the enqueue before the job handler settles and the suite runs `retries: 0`, so there is no HTTP-observable "settled" signal to assert without a bespoke retry loop; the fix if wanted is a deterministic completion signal on the route or a server-side test against `materializeCycle`. Two authors built the screens in parallel against a pinned contract; integration caught one `exactOptionalPropertyTypes` slip (a nullable `taxRateId` needed `?? null`). **OCR (initiative O, OB-185…191) is now COMPLETE too — see [Bill capture (OCR)](#bill-capture-ocr).** Upload or forward a bill → stored via `StorageProvider` → `bills.document-extraction` job under `runAsAutomation` → a swappable `DocumentExtractionProvider` extracts into a `document_captures` staging row (vendor matched via banking's `namesMatch`) → human reviews and creates a **draft bill** (`createBill`) + `bill_attachments` row → approves (the existing `approveBill`, where `duplicate_vendor_reference` fires). Two providers ship behind config seams with the hosted adapter deferred (the `sqs`/`.qbo` idiom): extraction `deterministic` (a real key:value parser) / `anthropic` (throws), inbound-mail `dev` (JSON webhook) / `ses-inbound` (throws); a per-org `orgs.inbound_email_token` routes `POST /v1/bills/inbound/{token}`. Reuses `bills.read`/`bills.write` — no new catalog keys. Web review screen at `/bill-captures`; E2E `packages/e2e/tests/bill-capture.spec.ts`. Migration `0009_bill_capture`. Built by an orchestrated fan-out (foundation → parallel capture-backend + web + transport-tests → E2E); the gate caught six real integration issues the isolated authors couldn't: a test that resolved the extraction provider through `getConfig()` (throws in DB tests — install the seam), the inbound webhook missing the universal `Idempotency-Key` requirement (now conformed via `withGlobalIdempotency`, giving relay-redelivery dedup), and four pinned coverage tripwires (permission-matrix, route-table, OpenAPI components, cross-org A7/B11). **M5 (the whole platform surface) is now COMPLETE — see [Status — Milestone 5](#milestone-5--platform-surface).** All 13 tickets (OB-096…108) shipped in five orchestrated waves (schema+contracts → identity+outbox → integrator surfaces → transport+screens → verification), squashed into one commit, `yarn check` fully green (2,392 tests). What's in: the OAuth 2.1 AS (code+PKCE, opaque tokens, scope∩role recomputed per request), API keys, the transactional `event_log` outbox with per-org ordering, the change feed, `external_refs`, an in-process MCP host + focused tool suite (5 reads + a propose-only `journal.propose` that lands a draft), the `agents.review` queue, five web screens incl. the OAuth consent screen, and the F1–F11 security + property/mutation suites. Human decisions taken up front (D-53/57/61): opaque tokens, per-org event ordering, 90-day retention, build-to-spec with a pre-prod security review still owed on OB-098. Integration caught **three real bugs the isolated authors couldn't**: the outbox serialising `bigint` money through `JSON.stringify` (→ cents string, F7 site); the MCP host mapping errors via the global `getLogger()`/`getConfig()` inside a request handler (masked 403/400 as 500 — now `request.log`); and `external_refs`' post-race recovery re-read using a REPEATABLE-READ snapshot that couldn't see the winner's commit (now `FOR UPDATE`). Plus the browser OAuth/MCP surfaces needed dev+prod proxy rules for `/oauth` and `/mcp`. **Two honest scope edges, both flagged:** a raw `postJournal` (the agent-propose path) emits no change-feed event — OB-100 wired emission to the four subledger/banking domain sites only, not base posting — so the E2E asserts the feed reachable-and-empty for that flow; and a pre-prod external security review of the AS (OB-098) remains owed. **PAY (Stripe/Square) is now BUILT — gate-green (2,421 tests / 214 files), eleven commits `160e89e…c2b24ad`.** All 11 tickets (OB-143…153) plus the OB-143a secrets write-seam shipped via orchestrated fan-out — foundation → real Stripe/Square adapters + domain service → routes + webhook/poll/refunds → web UI + property suite + E2E — each wave integrated through `yarn check`. What's in: a per-org writable `SecretsProvider` (`local` AES-GCM `secrets` store; `aws-secrets-manager` deferred), a `PaymentProcessorProvider` (real `fake` drives the gate, real `stripe`/`square` for manual sandbox — D-102), migration `0011` (`processor_connections`, `processor_events`, `secrets`), the D-82/D-104 clearing+fee posting, the signature-verified webhook with two-level idempotency (`processor_events` event-id + `external_refs` object-id) under a `processor_connections` FOR-UPDATE lock, the daily poll backstop reconciling clearing `bookBalance` vs the processor's balance, refunds/lean chargebacks, the `/v1/processing` management routes + public pay-link + Pay button, and the F9/reconciliation/provenance/contention property suite + the pay→paid→payout→reconcile E2E. Integration caught the usual tripwires (a ` sql` `` backtick that closed the template, the config↔logger redaction cross-check, and the permission-matrix/route-table/cross-org coverage for the new routes). See the seam-pinned plan at [PAY execution](#pay-execution--dev-ready-parallelised). Four forks were settled up front ([D-101](#d-101)…[D-104](#d-104)): a real secrets **write** seam (OB-143a — the one new foundation, also unblocks Q), a **`fake`** processor under the hermetic gate, a **plain GL clearing account + `processor_connections`** model, and a **self-contained fee line** (so PAY does **not** block on the full D-79 primitive — a de-scope from the earlier "D-79 fee primitive → PAY" note). Almost every other seam already exists (`recordPayment`, `createExternalRef` with `'payment'` + the `FOR UPDATE` race fix, `source:'clearing'`, `runAsAutomation`, `link_entry` payout reconcile, `registerDailyTask`). **Deliberate lean-v1 follow-ups, all flagged:** real Stripe/Square are proven only in a manual sandbox run (D-102 — the gate runs the `fake`); the poll passes `last_polled_at` (a timestamp) as the processor cursor, which the `fake` ignores but real Stripe reads as an event id — a dedicated cursor column is the fix for live polling; chargeback losses currently code to the nominated fee account (a dedicated loss account is a follow-up, D-103 ruled out inventing one); a refund reopens the receivable (debit AR / credit clearing — full credit-note flow deferred); currency is hard-coded `'usd'` (§13 multi-currency still out); and a `failed` `processor_events` row is recovered via the poll's balance-discrepancy log, not an event replay. Square's webhook signature falls back to `appBaseUrl` for the notification-URL component (best-effort; a real webhook-URL field is a production follow-up). **Cash application (CA) is now BUILT — gate-green (2,501 tests / 222 files), eleven commits `18153a2…07dfbe5`.** All 9 tickets (OB-134…142) shipped via orchestrated fan-out — a coupled trunk (the `bank_line_clearings`→parent + `bank_line_clearing_entries` child restructure + the single-target→array clearing rewrite + `0012` payment-terms schema, [D-105](#d-105)) → payment-terms service + multi-entry property suite (parallel) → discount suggestion + `/v1` routes (parallel) → screens + suggestion-property + lockbox E2E (parallel) — each wave integrated through `yarn check`. What's in: `payment_terms` (net-days + optional early-pay discount, computed due date), the multi-entry clear (E4 generalised to `Σ(non-discount entries)+difference===line`, lockbox + split-coding subsumed), the terms-driven discount **suggested** and confirmed as a `discount`-kind allocation + a real journal to a nominated discount account ([D-106](#d-106) — a `discount_journal_id` XOR source was added to `ar/ap_allocations` so `outstanding` nets to zero), reusing `orgs.*`/`banking.match` with **no new catalog key** ([D-107](#d-107)). Integration caught the usual: a fast-check account-code collision in the property suite, a stale `suggestDiscount` permission doc (a direction-split like `recordPayment`), and the route-table/permission-matrix/cross-org coverage for 8 new routes. **Deliberate deferrals, flagged ([D-108](#d-108)):** the AP/Pay-Bills-side discount suggestion waits for PB (built AP+AR primitive, only the PB call site missing); and a manual **money-in** receipt can _see_ the discount hint but not yet _apply_ it (only the bank-clearing `discount` entry has a write path today — a follow-up once a money-in discount route exists). **Pay Bills (PB, OB-109…118) is now BUILT — gate-green (2,528 tests / 227 files), commits `90ecdf7…98860f7`.** All 10 tickets shipped via orchestrated fan-out — foundation (`0013_pay_bills` schema + 3 permission keys + wire contracts) → services (queue + issue + the shared `postSettlementDiscount` + rail/`CheckOutput`/check register) → transport (12 `/v1` routes) → screens (Pay Bills window + disbursements queue) → verification (server suite + E2E), each wave integrated through `yarn check`. Four forks settled ([D-109](#d-109)…[D-112](#d-112)): dedicated queue/issue permission keys for a real separation of duties (`disbursements.issue` seeded **owner-only**, and the queue-vs-issue split is the headline permission-matrix assertion), **rails as classification tags** (no NACHA/wire logic — external systems execute), **check** the only internal rail behind a swappable `CheckOutput` seam (American spelling throughout — no `cheque`), and the settlement discount **reusing CA's primitive** (a shared `postSettlementDiscount` both bank-clearing and PB issue call, so AR/AP cannot drift) + finishing the deferred AP suggestion. Integration caught **two real bugs the isolated authors couldn't**: issue passed `bank_accounts.id` where `recordPayment` needs the nominated **ledger** `accounts.id` (every real issuance would have thrown `NotFoundError('account')` — no gate test reached a successful issue until OB-117's happy-path test); and a **pre-existing CA-era gap** — `getBill`/`getInvoice`'s allocation projections never handled the `discount_journal_id` source (D-106's third), so any document ever settled with a discount threw `InternalError` on an individual read (list reads were unaffected, which is why CA never caught it). Both fixed and regression-covered. **Deliberate deferrals, flagged:** the E2E (`pay-bills.spec.ts`) is authored `yarn check`-clean and stack-runnable but not run by the gate (which is `yarn e2e`); `appliedVendorCreditId` consumes the credit's remaining balance against the bill (no partial-amount field on the wire — an inferred reading, flagged in `issue.service.ts`); the batch `POST /v1/disbursements/issue` takes one date and no per-payment reference, so an ACH trace uses the singular issue route; and credit-card / any-account-type **import & reconcile** plus a live feed remain out (own [follow-up note](#follow-up--import--reconcile-should-work-for-any-account-type-future)). **L, M and N are now BUILT** (see [Budgets](#budgets) for N — the budget-vs-actual report + entry surface, gate-green at 2,645 tests, one B6 bug caught by the property suite and fixed, [D-N7](#d-n7)). **P (accountant access & period close) is now BUILT too — gate-green at 2,689 tests / 252 files (see [Accountant access & period close](#accountant-access--period-close)).** All eight tickets (OB-192…199) via orchestrated fan-out: the seeded `accountant` role (a pre-baked bundle, generic `requirePermission`, assigned through the existing invite flow), the advisory close checklist + recorded sign-off over the M1 lock (D-97), adjusting/reclassifying entries flagged on `journals.source` (threaded through the **draft** flow — a `journal_drafts.entry_type` column mapped to `source` at `postDraft`, since the manual-JE UI posts through drafts and `postDraft` takes no body), the branded 3-statement PDF package, and the audit report (one new key `audit.read`, 69→70). Owner decision recorded: pre-baked bundle now, a **custom role builder** deferred (the `roles.org_id` path already reserves it). Schema `0017` (`period_close_events` + `statement_packages`, both append-only). **Next: Q (M6 Automations — a polled agent work queue, MCP-only, OB-200…210), the last scoped initiative. Owner requirement: OpenBooks has no direct AI integration except MCP — it holds no model credentials and makes no inference call; the org's own agent authenticates via the M5 OAuth AS, polls/leases queued work items over MCP, runs inference on its own infrastructure, and submits a structured proposal back into the `agents.review` queue for a human to post ([D-100](#d-100), reversed from the earlier BYO-model-through-secrets reading). Prerequisites are the M5 MCP host + `agents.review` queue + OAuth AS and the OB-127 scheduler — all built; the OB-143a secrets seam is no longer a Q dependency. Q also hardens the MCP host so a per-call failure never reads as a broken connection — JSON-RPC errors ride HTTP 200 with a typed `data.code`, reversing today's `host.ts:353` behaviour that propagates 403/404/500 ([D-118](#d-118)).** **Q is now BUILT — `yarn check` fully green (2,726 tests / 258 files), the last scoped initiative done.** Delivered by an orchestrated fan-out: foundation (schema `0018_automations` — `automations`/`work_items`/`automation_annotations`; `generated.ts` via a throwaway MySQL; the shared-types `automations` domain; **no new permission keys** — the reserved `workflows.read`/`write`/`activate` triad was already seeded, so catalog stays 70 and the compose-vs-activate SoD came free) → three parallel streams (MCP host D-118 hardening + the two `work_queue.poll`/`submit_proposal` tools; the `modules/automations` core — engine, `FOR UPDATE SKIP LOCKED` lease, the scheduled/event/lease-expiry sweeps; transport routes + job wiring) → web (automation builder + work-queue screens) → verification (a parked-transaction proof that the lease is single-grant, fast-check never-auto-posts + lease-uniqueness properties, schema structural, and an HTTP+MCP narrative). Integration caught the usual: a readonly-type slip, the async `registerAutomationsJob` signature the transport stream couldn't see, the six pinned tripwires (permission-matrix latent→enforced + `OPERATIONS` rows, route-table, cross-org A7 with a live automation/work-item fixture + B11 filter exemption, grants/tenancy/harness literals), and two Wave-2 test bugs (a first-in-file `captureEmail` install-order trap; a shared-prompt `getByText`). **Two honest edges, flagged:** `submit_proposal` is once-only via the lease row-lock (refuses a redelivery, never double-lands a draft) but not replay-idempotent — `withGlobalIdempotency` is unusable because the MCP host threads no `Idempotency-Key`; and provenance is agent-attested (`ctx.actorId` + self-reported model), since OpenBooks never calls the model (D-100). The E2E (`packages/e2e/tests/automations.spec.ts`) is authored `yarn check`-clean and stack-runnable but, like PB's, not run by the gate. (OB-119 reporting-snapshots stays out — scale, not correctness.) **Initiative R (responsive web & mobile-ready shell, OB-211…219, a launch prerequisite) is now BUILT — `yarn check` fully green (2,734 tests / 261 files), and unlike the other narratives the `mobile-smoke` E2E was actually _run_ (iPhone-13 viewport on Chromium) and passes, as does the desktop `month-of-books` narrative unchanged.** Foundation trio authored + gated by the orchestrator (`useIsCompact`, `<ResponsiveTable>`, dialog bottom-sheet, nav drawer — `273f534`), then five Sonnet sweep agents over disjoint screen dirs (worktree-isolated, cherry-picked). The run caught a real header-overflow bug the component tests could not (fixed `4f5383b`). Scope corrections found on inspection: the breakpoint tokens were already wired into Tailwind's `@theme` (OB-211 needed only the primitives), and the table sweep was **~61 `<table>` sites**, not the scope's "~19". The one discipline that kept the 402 component tests green through the fan-out: card/stack alternates gated on `useIsCompact()` (JS, `false` under jsdom), never CSS `md:hidden`. See [Initiative R](#initiative-r--responsive-web--mobile-ready-shell-built-ob-211ob-219-d-120d-125). **All M1–M6 + K–R are now built; the next candidates are the owed hardening items (Dependabot security pass, the OB-098 AS review) and the unscheduled follow-ups — the native Capacitor shell, the launchpad, the marketing/docs site. **Document-UI redesign thread (post-R polish, on `develop`):** the bills list + detail were reworked to a shared card / breadcrumb / summary-endpoint pattern (`46432a6`); this session extended it to **invoices** — list + detail + draft editor, deep-link routing `/sales/invoices/:id`, a new `GET /v1/invoices/summary` feeding tap-to-filter cards, and an `accent` tone added to the shared `Pill` — and to **estimates**, the same treatment adapted to the non-posting model: `/estimates/*` deep-link routing, `GET /v1/estimates/summary`, **Expired** as the Overdue analog (approved past `expiryDate`, not converted), no payment history, and the old modal `estimate-form.tsx` promoted to a routed editor page (now unused, left in place). Plus a shell fix: the app frame moved from `h-screen` (`100vh`) to `h-dvh` + `overscroll-contain`, so on a phone a document's header no longer scrolls out of view once the content bottoms out. All gate-green (2,837). Deliberate omissions carried across all three, matching the user's "build real, omit unbacked" call: Date-range / More-filters / Export / numbered pagination on the lists, and Attachments / Activity-log / Last-modified-by on the invoice detail — none are backed by an endpoint yet.** |

M4 is complete, including its two follow-ups: **OB-095** (the bank-account setup screen — the
banking section's Accounts tab, with `deactivate`/`reactivate` guarded by the open-session
refusal) is built, and **M5 is fully scoped** (below — 13 tickets OB-096…OB-108, criteria
F1–F11, decisions [D-53](#d-53)…[D-62](#d-62)). Wave 5 earned its keep: OB-088's property suite
computes the cleared balance four independent ways over four tables and asserts them equal (spec
§11's subledger agreement one level down), and OB-090's browser narrative caught two real seam
defects, both fixed ([D-52](#d-52)). A third defect surfaced later during manual testing and is
also fixed: a stale/revoked session cookie 401'd every request _including login_, with no way to
clear an `HttpOnly` cookie — the identity-establishing routes now ignore the incoming session
(commit `77850b1`). See [Status — Milestone 4](#status--milestone-4).

**The four choices flagged for the human before M5 are now decided** (D-53…D-62): the AS is
built in-house (OAuth 2.1, code+PKCE) with a dedicated external security review of OB-098 still
**owed before production** (build-to-spec now); **per-org** event ordering (a counter taken
`FOR UPDATE` like `journal_sequences`); a **90-day** event-log retention window; and **opaque
tokens** (not JWT). M5 shipped on those defaults — see [Status — Milestone 5](#milestone-5--platform-surface).

### Follow-up tickets — Phase 0 cleared the M3 debt

The three M3 follow-ups are **done** (Phase 0, committed on `develop`: `44101d5`, `bef26a6`, gate
green), and **OB-094** is subsumed. Nothing on this list remains outstanding.

| ID         | What                                                        | Landed                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OB-093** | `ar_only`/`ap_only` gain `journals.post`/`journals.reverse` | Seeded in `0001_tenancy`; the two clerk roles now approve, void and pay what they enter — the Pay Bills prerequisite.                                                                                    |
| **OB-091** | `PostJournalInput` gains a `source`                         | Subledger journals carry `invoice`/`bill`/`payment`/`clearing` instead of the old blanket `manual`.                                                                                                      |
| **OB-092** | AR/AP refusal vocabulary reconciled onto AP                 | AR now raises `412` with `document_approved`/`document_already_approved`/… instead of a detail-less `409`; `openapi.json` + web client regenerated; the vocabulary test now guards they stay reconciled. |
| **OB-094** | Split coding — one statement line across several accounts   | **Subsumed** by Cash application ([D-80](#d-80), OB-137): "multiple entries per statement line" is that generalisation, lockbox the same mechanism.                                                      |

**OB-095 (done, M4)** — the banking section's **Accounts** tab registers a bank account over a
ledger asset-account picker (D-46) and deactivates/reactivates it, with `deactivateBankAccount`
refusing an account that has an open reconciliation session (`bank_account_has_open_session`).

### Initiative R — Responsive web & mobile-ready shell (BUILT; OB-211…OB-219, D-120…D-125)

**R is now BUILT — `yarn check` fully green (2,734 tests / 261 files), and the `mobile-smoke`
narrative passes at 390px while the desktop narratives still pass unchanged.** Delivered by the
documented orchestration model: an Opus orchestrator authored the load-bearing trio directly and
gated it, then fanned out five Sonnet sweep agents in isolated worktrees over disjoint screen
directories, cherry-picked their commits, and ran the gate. What shipped:

- **OB-211/212/213 (foundation, one commit `273f534`).** `useIsCompact()` (the single JS
  branch point, D-121, `useSyncExternalStore`, jsdom-safe); `<ResponsiveTable>` (the
  horizontal-scroll floor, D-123); `dialog.tsx` promoted to a full-height bottom sheet `< md`
  (D-124, one seam covering all 51 `DialogContent` sites); and the nav shell as a drawer behind
  a hamburger `< md`, static sidebar `≥ md` (D-122), the drawer reusing Radix Dialog for
  focus-trap/Esc/scrim and a shared `NavList` so both presentations cannot drift. **Scope
  correction found on inspection:** the `--ob-breakpoint-*` tokens were _already_ wired into
  Tailwind's `@theme` (`tokens.css`), so `sm:`/`md:` utilities worked out of the box — OB-211
  needed only the hook + primitives, not the token wiring the scope implied.
- **The sweep (OB-215/216/217/218a/218b).** Every data table wrapped in the scroll floor — the
  real count was **~61 `<table>` sites across ~60 files**, not the scope's "~19"; the money
  tables (Pay Bills payable/pending, money-in payments) additionally collapse to a **card
  layout** `< md` (D-123 polish), and banking/side-by-side workbenches stack. The one rule that
  kept the 402 component tests green through the fan-out: **card/stack alternates are gated on
  `useIsCompact()` (JS), never CSS `md:hidden`** — under jsdom the hook returns `false`, so only
  the table renders in tests and no `getByText`/`getByRole` query sees duplicated content.
- **OB-219 (mobile e2e, `1c7fabb`).** A dedicated `mobile` Playwright project (iPhone 13
  viewport, ~390px, **driven by Chromium** so CI installs no WebKit) running exactly one
  narrative — register → drive the nav drawer → post a journal → read the trial balance — with a
  no-horizontal-scroll assertion at every stop; the desktop `chromium` project `testIgnore`s it.

Running the narrative earned its keep: it caught a **real reflow bug the component tests could
not** — at 390px the header's fixed-width session controls (org switcher + New organization +
Sign out) plus the wordmark overflowed by ~35px; fixed by yielding the wordmark below `sm`,
narrowing the org select, and `min-w-0` on the cluster (`4f5383b`). One measurement subtlety
recorded for the next reader: `document.scrollingElement.scrollWidth` **over-reports** under
Chromium's mobile emulation (it aggregates a _contained_ `ResponsiveTable` scroller's width and
claims a body overflow `window.scrollX` proves impossible), so the assertion measures the real
scroll regions (`<header>`, `#main`) instead — which still catches genuine chrome/content leaks.

The original scoping write-up follows, unchanged, for the design rationale.

The web app was built desktop-first, screen by screen, and its **mobile/responsive behaviour has
never been reviewed as a whole**. An inventory confirms it: across **~36 screen surfaces** (34
domain directories) the codebase carries **~8 responsive utility classes total** (six files with a
stray `sm:`), no `useMediaQuery` and no layout media query anywhere, a fixed-width `w-60` sidebar
shell (`app-shell.tsx`), and `w-full` data tables that lack a scroll wrapper in most of the ~19
places one would help. The breakpoint tokens already exist (`--ob-breakpoint-*` in `tokens.css`,
40/48/64/80rem) but are **unwired into layout**. This initiative is the dedicated pass, and it is a
**launch prerequisite** — and the prerequisite for the native app below, which cannot be wrapped
around views that do not yet work at phone width.

**Goal.** Every `packages/web` surface usable down to ~360px: no horizontal `<body>` scroll,
primary actions reachable, touch targets ≥ 44px — landing the mobile nav shell first (it is the
one screen every other screen sits inside, and it was just rebuilt as a sidebar in the nav
consolidation, so it is desktop-only by construction today).

**Forks to settle up front:**

- **[D-120] Minimum width & breakpoint tiers.** Support down to 360px; two tiers — _compact_
  (`< md`, 768px) and _regular_ (`≥ md`) — reusing the existing `--ob-breakpoint-*` tokens rather
  than inventing a scale. `no-raw-color`'s sibling discipline applies: breakpoints come from tokens.
- **[D-121] Mechanism.** Tailwind v4 responsive utilities (`sm:`/`md:`) are the default; a single
  small `useViewport`/`useIsCompact` hook is added only where layout must branch in JS (drawer vs.
  static sidebar, table vs. cards). CSS-first keeps it testable and avoids a JS branch per screen.
- **[D-122] Nav shell on compact.** An off-canvas **drawer behind a hamburger**, not a bottom tab
  bar — eight grouped sections with sub-items exceed a tab bar, and a drawer preserves the grouped
  nav the consolidation just shipped. The `w-60` sidebar is a drawer `< md`, static `≥ md`.
- **[D-123] Tables on compact.** The floor is a horizontal-scroll wrapper on **every** data table
  (cheap, universal). The polish, for the highest-traffic money tables only (Pay Bills, money-in,
  journal-entry rows), is an opt-in **stacked/card** layout `< md`. Not every table is card-ified —
  scroll is the floor, cards are reserved for where scrolling a wide money grid is genuinely painful.
- **[D-124] Dialogs on compact.** `dialog.tsx` already caps to `w-[calc(100vw-2rem)]` + `max-h-[85vh]`;
  promote it to a full-height **bottom sheet** `< md`. One seam fixes all ~25 dialogs at once.
- **[D-125] Test strategy.** Add a **mobile Playwright project** (`devices['iPhone 13']`, ~390px)
  running **one dedicated `mobile-smoke` narrative** (register → open the nav drawer → post a journal
  → read a report) — not the full 15, whose wide-table figure assertions are desktop by design (the
  config comment already says so). Component/unit tests stay desktop (jsdom has no layout engine). A
  manual small-viewport review checklist is recorded per screen sweep.

**Tickets:**

- **OB-211 — Responsive foundation.** Wire the `--ob-breakpoint-*` tokens into active Tailwind
  screens; add the `useViewport`/`useIsCompact` hook, a `<ResponsiveTable>` scroll-wrapper primitive,
  and a compact-sheet variant hook for dialogs. No screen changes yet — the primitives the rest build on.
- **OB-212 — Nav shell, Phase 2 (the load-bearing one).** Drawer + hamburger `< md`, static sidebar
  `≥ md`; overlay, focus-trap, Esc-to-close, the skip-link and grouped sections preserved.
- **OB-213 — Dialog → bottom sheet.** The `dialog.tsx` compact treatment, verified across the
  dialog-heavy screens (Pay Bills batch-issue, bill-capture review, banking multi-entry, account dialogs).
- **OB-214 — Tables baseline.** Wrap every remaining data table in the scroll primitive; sweep the
  settings tables and every `TABLE_CLASSES` site.
- **OB-215 — Ledger & AP/AR line grids.** The wide "workbench" forms — journal-entry `draft-editor`,
  sales/purchases/estimates line rows, the budgets grid — compact treatment (sticky first column or stack).
- **OB-216 — Banking workbenches.** The bank-match and reconciliation screens (side-by-side panels)
  stack on compact.
- **OB-217 — Pay Bills & money-in.** The named wide money tables → card layout `< md` (D-123's polish tier).
- **OB-218 — Screen sweep, the rest.** Sales/Purchases/Reports toolbars, the Reports statement tables
  (scroll), Settings, platform/automation, and auth — each verified at 360px.
- **OB-219 — Mobile e2e + a11y/touch audit.** The mobile Playwright project and `mobile-smoke`
  narrative; the touch-target and reflow audit; the review checklist recorded.

**Acceptance:** every screen usable at 360–414px with no horizontal body scroll and touch targets
≥ 44px; the nav is a drawer `< md` and static `≥ md` with correct keyboard/focus behaviour; dialogs
are bottom sheets `< md`; the `mobile-smoke` narrative passes at 390px while the existing 15 desktop
narratives still pass unchanged; `yarn check` green with the token/`no-raw-color` rules unviolated.

**Shape of the work.** ~36 surfaces, but most are cheap (a scroll wrapper and a toolbar `flex-wrap`).
The load-bearing three are the foundation, the shell, and the dialog seam (OB-211–213); the four
wide workbenches (OB-215–217) carry the real design work; the screen sweep (OB-218) parallelises once
the primitives exist.

Beyond responsive web, we still want a **native mobile app** (iOS/Android), most likely by wrapping
the existing `packages/web` SPA in a native shell via **Capacitor** rather than a separate
codebase — it reuses the React app and the same `/v1` client, and adds native capabilities
(camera for bill capture, push notifications, biometric unlock) behind a thin plugin layer.
The responsive review above is a prerequisite: the wrapped web views must already work on a
phone-sized viewport before a native shell is worth building. Also unscheduled; the decision
between Capacitor and a fuller native/React-Native rewrite is itself deferred.

### Follow-up — the document-line UI redesign must restore per-line dimensions

The AR/AP document-line editors (invoice, credit note, bill, vendor credit) are being
redesigned. That redesign **must incorporate per-line dimension tagging** — the current editors
omit it entirely (they send an empty `dimensionValueIds`), so all invoice/bill activity reaches
the ledger untagged and P&L / GL-by-dimension is blind to the bulk of the books. **This is
UI-only work: the backend is already complete end-to-end** — create/update validate
(`resolveTagsForNewLine`) and persist (`ar_document_line_dimensions` / `ap_document_line_dimensions`),
reads return `dimensionValueIds`, and approval propagates the tags onto the journal
(`journal_line_dimensions`) for reporting. Reuse the journal-entry editor's per-line
**"Details (N)"** expander pattern rather than inline columns (the subledger row is already wide,
more so after the catalog picker). This holds **only if the redesign keeps dimensions per line**
(D-18); a header-level or other-granularity model would need backend changes. POs/estimates
(D-M7) and recurring-invoice templates carry no dimensions today — extending the redesign to
either is a separate, well-patterned backend chunk (a `*_line_dimensions` table + wire + persist

- convert/materialize carry-through).

### Product follow-up — a customizable landing page / launchpad (future)

Today the app opens straight into a screen; there is no **home / landing page** that orients a
user and gives them a launchpad to the features they use most — create an invoice, enter a bill,
run Pay Bills, reconcile, open a report. We want a dashboard-style landing page that is a
**launchpad to common features**, and that **adapts to the user**: it is customizable to their
workflow (an AP clerk lands on bills and Pay Bills; an accountant on reports and close) and is
**permission-aware**, surfacing only what the caller can actually do. This reuses the advisory
permission set `GET /v1/me` already returns (the same set `nav.ts` gates on, D-25) so the
launchpad never offers an action the service would refuse. Scope is a later product decision —
at minimum a role-defaulted set of shortcuts, at most user-arrangeable tiles with saved layout.
Unscheduled; captured so the home surface is designed deliberately rather than defaulting to
whatever screen happens to load first.

### Product follow-up — public marketing site with high-quality docs (future)

Distinct from the in-app launchpad above (which orients a signed-in user): we need a **public,
static marketing website** — the front door for prospects — with **high-quality documentation**
and a clear **features** presentation. Marketing pages (what OpenBooks is, who it is for, the
feature tour, pricing, a sign-up call to action) plus a real docs surface: getting-started
guides, per-feature how-tos, an accounting-concepts primer, and the **published API/spec**
(`openapi.json` is already generated and versioned — M7's "published spec" lands here, rendered
for humans). It should be **static** for speed, cacheability and cheap hosting — a static-site
generator (e.g. Astro/Docusaurus/VitePress) that builds to a CDN — kept **separate from
`packages/web`** (the authenticated SPA) so a marketing copy change never touches the app bundle,
while still able to import shared brand tokens. Docs should be **versioned alongside releases**
and, where possible, **derived from the source of truth** rather than hand-copied — the API
reference from `openapi.json`, feature docs cross-linked to the spec's acceptance criteria — so
they cannot silently drift from what the product does (the same discipline the drift gate enforces
on `openapi.json` and the generated client). Unscheduled; overlaps M7's launch-readiness docs and
should be scoped with it, but captured separately because the **site itself** — hosting, IA,
generator choice, its own CI/deploy — is a deliverable the phase order does not yet name.

### Follow-up — import & reconcile should work for any account type (future)

The M4 banking module (import, matching, reconciliation) is built and tested for **asset bank
accounts**: `createBankAccount` accepts any ledger account at the service, but the web picker
filters to `asset` (D-46), reconciliation's balance math assumes a debit-normal account, and
`feed_source` is `ENUM('file')` — CSV upload only, no live link. Users will need to **import and
reconcile credit cards** (and, in principle, any balance-sheet account), so the harness should
generalise: (1) let registration/picker accept **liability** accounts — a credit card is the
first case; (2) make the reconciliation balance/sign **normal-balance-aware** so a credit-normal
account reconciles correctly; (3) add a live-feed provider (a new `feed_source` + an aggregator
integration) for "link," distinct from the CSV path. The UI can still **favour common paths**
(default to bank accounts, surface cards secondarily) — the point is the engine must not be
asset-only. Unscheduled; adjacent to the fixed-assets/recurring initiative (L) and the banking
work already shipped.

### Product follow-up — an optional product/service catalog (future)

Invoice and bill lines are free-form today by deliberate decision (no product/item table — see
`subledger/documents.ts`, "no product policy invented in a schema file"). We want an **optional**
reusable **catalog** of products/services for **both AR and AP** — a saved item carrying a name,
a default GL account, a default unit price, and a default tax rate — that a line can be filled
from with one pick, then still edited per line. It buys faster entry and **coding consistency**
(the same item always lands in the same account, so reporting doesn't fragment on typos), and it
is the natural anchor for later inventory/COGS if that is ever scoped. It stays **optional**:
free-form lines remain first-class, and a catalog item is a convenience that pre-fills the same
per-line fields (account, price, tax) a user can already type. New tenant table(s) + a picker on
the line editors; no change to how lines post (each still carries its own `account_id`).
Unscheduled.

### Follow-up — receipt capture for employee-expense reimbursements (future)

The bill-capture pipeline (initiative **O**, built) — snap or email-forward a document →
`StorageProvider` → `DocumentExtractionProvider` → a `document_captures` staging row → human
review → a **draft bill** → approve — is **vendor-only today**. Vendor matching filters
`contacts.is_vendor = 1` (`capture.repository.ts`) and `namesMatch`es vendor display names
(`extraction.job.ts`), and the review step creates the draft via `createBill`, which runs
`requireVendor` (`capture.service.ts`). A receipt for an **employee** never matches and could not
be filed as a reimbursement.

Initiative **M** makes this a small, natural extension: an employee expense **is** an
`ap_documents` bill (`document_type='bill'`) against an employee contact, raised through
`createExpense`/`requireEmployee` instead of `createBill`/`requireVendor` ([D-M2](#where-things-stand)).
So "receipt capture for reimbursements" reuses the whole existing pipeline with a small delta: (1) the
capture reviewer picks a **destination** — vendor bill (today) or employee expense; (2) for an expense,
match against `is_employee` contacts (reuse `namesMatch`) and call `createExpense`; (3) the
`document_captures` staging, `bill_attachments`, and the review UI are unchanged, because an
expense-bill is a bill so attachments and the draft container already fit. No new tables. Unscheduled;
captured here so the receipt→reimbursement path is designed deliberately once M lands, rather than
rediscovered. Adjacent to M (expenses) and O (bill capture).

### Competitive gap analysis — candidate initiatives vs. QuickBooks & Xero (future)

A feature sweep of OpenBooks against **QuickBooks Online** (Simple Start→Advanced), **QuickBooks
Desktop / Enterprise**, and **Xero** (2025–2026). The finding: the double-entry **core** is at or
above parity — DB-enforced append-only journals are a stronger audit posture than QBO's audit log
or QBD's audit trail (both of which _record_ edits/deletes rather than preventing them), flexible
per-line **dimensions** beat Xero's 2-category×100 ceiling and QBO Plus's 40 class+location cap, and
the OAuth AS + event outbox + MCP surface is cleaner first-party platform than either exposes. The
gaps are **breadth in the surrounding suite**, not an immature ledger. Two of the biggest (payroll,
sales-tax automation) every competitor also solves by **integration, not in-house build**, which
sets the build-vs-partner default below.

**Strategic wedge to hold while closing gaps:** append-only ledger integrity + flexible
multi-dimensions + agent-native (MCP, bring-your-own-model — [D-100](#d-100)) is genuinely
differentiated against all three incumbents and does not require catching up to be a selling point.

Prioritised candidate initiatives (proposed IDs — **not yet scoped or owner-sequenced**; existing
captures are cross-linked rather than duplicated):

| Prio                        | Candidate                                               | Status in OpenBooks                                                      | Competitors                                                  | Proposed                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1 — table stakes**       | Live bank feeds + credit-card/liability reconciliation  | **BUILT — feed (OB-227, asset) + credit-card/liability recon (OB-227b)** | QBO/Xero/QBD all live                                        | **OB-227 + OB-227b (below) — BUILT** — `BankFeedProvider` seam, **Stripe Financial Connections**, **v1 = bring-your-own key only** (managed deferred); credit-card/liability now reconciles in its owed frame (OB-227b) |
| **T1**                      | 1099 contractor tax reporting (NEC/MISC, e-file)        | **ABSENT**                                                               | QBO Simple Start+ · QBD wizard (Tax1099) · Xero all US plans | **OB-228 (below)** — own milestone; no ledger change, but PII + e-file provider seam                                                                                                                                    |
| **T1**                      | Customer statement of account · report CSV/Excel export | both **ABSENT**                                                          | all three ship both                                          | OB-220 (below)                                                                                                                                                                                                          |
| **T1**                      | Expose per-line dimensions on AR/AP editors             | backend done, UI omits it                                                | — (OpenBooks-ahead once shipped)                             | **already captured** — see [document-line dimensions](#follow-up--the-document-line-ui-redesign-must-restore-per-line-dimensions)                                                                                       |
| **T1**                      | Sales-tax automation (nexus/jurisdiction)               | flat manual rate table                                                   | QBO native · Xero=Avalara · QBD semi-manual                  | OB-221 (below) — **partner, don't build**                                                                                                                                                                               |
| **T2 — mid-market breadth** | Payroll                                                 | ABSENT                                                                   | QBO add-on · Xero native-ex-US/Gusto-US · QBD                | OB-223 (below) — **integrate (Gusto), don't build**                                                                                                                                                                     |
| **T2**                      | Inventory & COGS                                        | ABSENT (catalog is priced-line only)                                     | QBO Plus FIFO · Xero avg-cost · **QBD Enterprise leads**     | **OB-224 (below)** — own milestone; perpetual, avg-cost-first (FIFO later), append-only costing, **negative inventory in v1**                                                                                           |
| **T2**                      | Projects / job costing / time tracking                  | ABSENT                                                                   | QBO Plus · Xero Established · QBD                            | OB-225 (below)                                                                                                                                                                                                          |
| **T2**                      | Custom role builder                                     | schema reserves `roles.org_id`, not built                                | QBO Advanced · QBD Enterprise (115 pts)                      | OB-226 (below)                                                                                                                                                                                                          |
| **T3 — longer horizon**     | Native mobile app (Capacitor)                           | responsive web BUILT (R); shell unscheduled                              | QBO/Xero mature apps                                         | already noted (the unscheduled Capacitor shell)                                                                                                                                                                         |
| **T3**                      | Multi-entity consolidation                              | ABSENT                                                                   | only QBO/Xero top-of-line (IES, Xero AU "Ultra")             | not yet captured — low urgency                                                                                                                                                                                          |
| **T3**                      | Mileage tracking                                        | ABSENT                                                                   | QBO Solopreneur+ · Xero Me                                   | folds into the native-app work; low priority                                                                                                                                                                            |
| **T3 — market-gated**       | Multi-currency                                          | single-currency, `'usd'` hard-coded                                      | QBO Essentials+ · Xero Established+ · QBD                    | **OB-222 (below)** — reframed: **open-source contribution candidate**, core team pins the contracts only; revisit if target market goes international                                                                   |

Also confirmed on the sweep: the **catalog** ([product/service catalog follow-up](#product-follow-up--an-optional-productservice-catalog-future)) is in fact **BUILT** (initiative CAT — `modules/catalog/*`, `catalog.read`/`write`), so that follow-up's prose is stale; and **receipt capture for reimbursements** ([above](#follow-up--receipt-capture-for-employee-expense-reimbursements-future)) remains the right small extension of O.

### Follow-up — live bank feeds via a `BankFeedProvider` seam; Stripe Financial Connections first (OB-227, BUILT — gate-green)

Turns the [any-account-type import & reconcile](#follow-up--import--reconcile-should-work-for-any-account-type-future)
follow-up's "add a live-feed provider" clause into a concrete design. Add a swappable
**`BankFeedProvider`** interface — the same adapter idiom as `DocumentExtractionProvider` /
`CheckOutput` / `SecretsProvider` / `PaymentProcessorProvider` — with a new `feed_source` member per
adapter alongside today's `'file'` (CSV/OFX stays the zero-cost default, never removed). The first
live adapter is **Stripe Financial Connections**: transparent **pay-as-you-go, no monthly minimum**,
and its **Transactions** product ($0.30 per institution per account holder per month) _is_ the
reconciliation feed — balances/verification are incidental. It reuses the Stripe wiring PAY already
stands up, but note FC is a **data** surface, not payments (a distinct Stripe product from PAY's
charge/payout use), and is **US-only** for now.

**Headline decision (owner): v1 is bring-your-own account ONLY.** The org supplies its own Stripe
**restricted key** (scoped to Financial Connections), stored in the existing per-org AES-GCM
`SecretsProvider` exactly as PAY stores processor credentials. Stripe bills the org directly, so the
FC per-account cost never touches OpenBooks' books — which means v1 needs **no usage metering and no
OpenBooks-side billing system**, and the whole feature reduces to credential storage + the provider
seam + the pull job. Cleanest isolation, and the org owns the Stripe relationship.

**Deferred (post-v1): a managed ("use ours") model** — OpenBooks' own platform Stripe account
creates the FC sessions, the $0.30/account/month lands on OpenBooks' bill, and it is re-metered to
the org. Explicitly out of v1 because it forces per-org FC-usage metering and an OpenBooks
subscription/billing surface that does not exist yet; the `BankFeedProvider` config should still
carry a credential _source_ field so this drops in later without a schema change, but v1 only
implements `bring_your_own`.

A per-org **`bank_feed_connections`** table (linked-account id, institution, `feed_source`, the
credential-source field above, `external_refs` linkage for idempotent transaction pull) mirrors
PAY's `processor_connections` **without overloading it** — the two are different Stripe uses and must
not share a row. Ongoing pulls run under `runAsAutomation` on the existing scheduler (the same daily
tick that drives recurring/dunning and the PAY poll), writing statement lines through the
already-built matching/reconciliation pipeline.

**Cost model (verified against Stripe's published rates — the reason BYO is comfortable).** The only
recurring charge for reconciliation is FC **Transactions at $0.30 per institution per account-holder
per month** — billed per _connection_, not per transaction, with **no monthly minimum**. Balances
($0.10/call) are optional (only if we fetch the statement balance via API rather than have the user
enter it) and instant-verification ($1.50 one-time) and account-owners ($1.50/call) are **not needed
for reconciliation** (verification is for ACH money-movement). A **typical SMB** connecting ~2
institutions (one bank login covering checking+savings, one card issuer) pays **≈ $0.60–1.00/month**;
even 5 accounts across 3 institutions is **≈ $0.90–1.50/month**. Under **BYO this lands on the
customer's own Stripe bill, so it adds effectively zero to OpenBooks' COGS** — and at that scale it is
also cheap enough to absorb into a subscription if/when the managed model ships (the blocker there is
metering complexity, not the dollar cost). One unit caveat to confirm against a live invoice before
quoting customers: Stripe's "per institution _per account holder_" wording most likely means
per-connection, but if it meters per-account, multiply by account count — still trivial.

**Credit-card feeds are a data-supported, reconciliation-gated follow-on.** Stripe FC models cards as
a first-class type (`category = "credit"`, `subcategory = "credit_card"`) and `transactions` is a
general permission — only ACH/`payment_method` is cash-only — so **the feed _can_ pull card
transactions** (institution coverage permitting; the CSV/OFX path stays the fallback for cards Stripe
doesn't cover). The gating work is **not** the feed but the parent follow-up's
**normal-balance-aware reconciliation** generalisation — a credit card is a credit-normal liability
account and today's recon math assumes debit-normal assets (D-46). **v1 may therefore ship
asset-accounts-only** (Stripe FC + BYO key + the existing recon engine unchanged, the smallest
possible v1), with credit-card/liability support as a well-bounded follow-on that is mostly the
reconciliation change, not new feed plumbing.

#### OB-227 execution — BUILT (gate-green, 2,851 tests / 279 files)

**Now built** — delivered by the documented orchestrated fan-out: an Opus orchestrator owned Wave 0
(the seams — provider interface, migration `0021_bank_feeds` + the `feed_source` ENUM widened in place,
`generated.ts` regen against a throwaway MySQL, shared-types `bank-feeds` domain, `banking.connect`
seeded owner-only) and got it typechecking, then fanned out four Sonnet streams on disjoint paths —
**A** the `fake`+Stripe-FC adapters (`providers/bankfeed/`, vendor over `fetch`, no SDK), **B** the
`modules/bank-feeds/` service+sync+daily-job, **C** the six `/v1/bank-feeds` routes + component ids +
route/cross-org tripwires, **D** the web Bank-feeds screen — and integrated: `permission-matrix`
(owner-only `banking.connect` + a `bankFeedConnectionId` fixture + six OPERATIONS rows), entrypoint
wiring, and a property suite proving both idempotency layers (D-127 fingerprint via a cursor-rewind
replay that reads 3 and writes 0; D-128 cursor via a re-sync that reads nothing). Integration caught
what the isolated authors could not: the `plugin-api` barrel had to re-export the three new provider
types; `cursor` is a MySQL reserved word (→ `sync_cursor`); and the catalog 72→73 moved five pinned
literals, three of which (`resolution.test` owner-count, `harness.test` catalog-count and its
applied-migration-name list) only surface under the live MySQL suite. The E2E
(`packages/e2e/tests/bank-feeds.spec.ts`) is authored `yarn check`-clean and stack-runnable but, like
PB's and Q's, not run by the gate. **The credit-card/liability follow-on (OB-227b) is now BUILT too —
see [OB-227b](#ob-227b--credit-card--liability-reconciliation-built) below.**

**The headline finding from the code sweep: a live feed is PAY rebuilt for a _data_ surface.** It
copies three already-built idioms verbatim — `PaymentProcessorProvider`'s per-connection adapter
factory (`paymentProcessorFor(row.processor, deps)`, `providers/payment/index.ts:23`), `SecretsProvider`'s
per-org AES-GCM store (OB-143a — the restricted key lands exactly where PAY puts a Stripe key), and
`poll.job.ts`'s `runAsAutomation` cross-org sweep on the OB-127 daily tick. Two seams are **already
stubbed for this**: a placeholder `BankFeedProvider` interface (`plugin-api/src/providers.ts:45`, just
`{ name }`) and `bank_accounts.feed_source ENUM('file')` (`0006_banking.ts:143`, whose header says "this
is where a hosted feed slots in"). And the statement-line dedup is **already idempotent** —
`computeFingerprint` + `uq_bank_statement_lines_fingerprint` + `INSERT IGNORE` — so the feed reuses the
entire import→match→reconcile pipeline unchanged. The only non-plumbing code change is the debit-normal
assumption in `reconciliation.repository.ts:415`, which is why v1 is asset-only and credit-card is a
bounded follow-on (**OB-227b**).

**Forks settled ([D-126](#d-126)…[D-131](#d-131)):**

- <a id="d-126"></a>**D-126 — adapter selection off the connection row**, not config. `bankFeedProviderFor(source, deps)`
  mirrors `paymentProcessorFor`; the vestigial `BANK_FEED_PROVIDERS=['csv-ofx']` config (the file-parser
  selector) is left untouched. **No new config block.**
- <a id="d-127"></a>**D-127 — idempotency reuses the fingerprint**, not `external_refs`. The provider's stable transaction
  id is mapped into `bank_reference`, so `computeFingerprint` makes it exact-once and a re-synced
  overlap `INSERT IGNORE`s to nothing. This **retires the design note's "`external_refs` linkage"
  clause** — the unique key already enforces once, so `external_refs` would be redundant machinery (a
  new entity-type enum + A7/B11 coverage for no benefit).
- <a id="d-128"></a>**D-128 — a dedicated `sync_cursor` column** on `bank_feed_connections`, advanced only on
  sync success. Fixes PAY's documented cursor bug by design (PAY reused `last_polled_at`, which real
  Stripe reads as an event id). (`cursor` is a MySQL reserved word, so the column is `sync_cursor` — the
  same reason `bank_match_proposals.rank` is backquoted.)
- <a id="d-129"></a>**D-129 — feed lines carry `import_id = NULL`** (reuse the manual-statement-line insert path);
  connection-level `last_synced_at` is the provenance. No new ENUM member on `bank_statement_imports`.
  A per-sync audit table is a deferrable follow-on.
- <a id="d-130"></a>**D-130 — asset accounts only in v1.** Feed writes are sign-agnostic evidence so connect is not
  hard-gated, but reconciliation stays asset-correct; the normal-balance generalisation (`bookBalance`
  at `reconciliation.repository.ts:415` + the clearing sign convention at `clearing.service.ts:578,735`)
  is OB-227b.
- <a id="d-131"></a>**D-131 — a new `banking.connect` permission key** (catalog **72 → 73**), gating
  connect/deactivate; `syncBankFeed` stays on `banking.import`, reads on `banking.read`. There is no
  `admin` role in the seven-role set, so it lands **owner-only** (owner holds the whole catalog) and is
  **added to the bookkeeper exclusion list** exactly as `processing.write` is — connecting a feed stores
  a live credential and stands up a standing automated job, an org-administration act, not a clerk's file
  import. (Reusing `banking.import` was rejected; a bank credential is not a clerk task.)

**Pinned contracts (fix before the fan-out):**

- **Interface** (`plugin-api/src/providers.ts:45`): `BankFeedProvider` gains `listLinkedAccounts()` and
  `fetchTransactions({ cursor }) → { transactions, cursor, hasMore }`; `BankFeedTransaction =
{ externalId, postedDate, valueDate, amountMinor (signed cents string, + = money in), description,
counterparty }`; `BankFeedAdapterDeps = { restrictedKey, externalAccountId, appBaseUrl? }`.
- **Table** `0021_bank_feeds.ts` — `bank_feed_connections` (**MUTABLE + TENANT**; `id, org_id,
bank_account_id` FK `bank_accounts(org_id,id)` with `uq…_account` = one feed per account,
  `feed_source ENUM('stripe_financial_connections','fake')`, `credential_source
ENUM('bring_your_own','managed') DEFAULT 'bring_your_own'` (forward-compat for the managed model,
  D-forward), `secret_ref`, `external_account_id`, `institution`, `sync_cursor` (D-128), `last_synced_at`,
  `last_sync_error`, `is_active`, `created_by_user_id`, timestamps). **No BIGINT/DATE ⇒ no
  `codegen.mjs` override.** Plus **edit `0006_banking.ts:143` in place** (D-15): `feed_source
ENUM('file','stripe_financial_connections','fake')`.
- **Secret ref** `${orgId}/bank-feed/${connectionId}/restricted-key`; **queue** `'banking.feed-sync'`;
  `syncBankFeed` takes the connection `FOR UPDATE` to serialize cursor advance (journals can't be
  locked — D-14; PAY's exact pattern).
- **Service** (`modules/bank-feeds/`): `connectBankFeed` · `listBankFeeds` · `getBankFeed` ·
  `deactivateBankFeed` · `createBankFeedLinkSession` (provider-specific; `fake` deterministic) ·
  `loadConnectionProvider` (internal, mirror `connections.service.ts:278`) · `syncBankFeed` ·
  `runBankFeedSync` (sweep, mirror `runProcessorPoll`) · `mapTransactionToLine` (pure; `bank_reference
= txn.externalId`, writes via `fingerprintRows`/`existingFingerprintCounts`/`insertLinesIgnore`).

**Waves.** _Wave 0 (orchestrator, one gate-green commit — codegen needs a live DB, not a worktree
subagent):_ interface + migration + `MUTABLE_TABLES`/`TENANT_TABLES`/`tenant-tables.ts` +
`migrations/index.ts` + `generated.ts` regen (throwaway MySQL) + shared-types `bankFeeds` domain +
`banking.connect` seed in `0001_tenancy` and `catalog.ts`. _Wave 1 (five disjoint Sonnet streams):_
**A** adapters `providers/bankfeed/` (`fake` drives the gate, `stripe-financial-connections` reuses PAY's
`stripe` dep) · **B1** `connections.{service,repository}.ts` · **B2** `feed-sync.{service,job}.ts` ·
**C** `transport/routes/bank-feeds.ts` + the route/permission/cross-org/openapi tripwires · **D** web
Bank-feeds screen. _Wave 2 (orchestrator):_ entrypoint wiring (`worker.ts`/`api.ts`, one
`registerBankFeedSyncJob` line each), a contention property test (park one sync mid-flight, assert the
other hasn't advanced the cursor; re-sync inserts zero lines), cross-org, and an authored-not-gate-run
`bank-feeds.spec.ts` E2E (like PB/automations). Integration risk: widening `bank_accounts.feed_source`
ripples into the hand-written `BankAccountRow.feed_source: 'file'` type + `toBankAccount` +
`NewBankAccountRow` (`bank-accounts.repository.ts:57`).

**Tripwire ledger (exact literals):** `tenant-scope.test.ts:161` `TENANT_TABLES` **78 → 79**;
`catalog.ts:36,182` + `catalog.test.ts:57-58` **72 → 73**; `0999_app_grants.ts` `MUTABLE_TABLES`
`+bank_feed_connections` (`APPEND_ONLY_TABLES` **unchanged** — the table is mutable);
`permission-matrix.test.ts` `OPERATIONS`+`GRANTED_TO` (+`banking.connect`, +6 ops) and per-role counts if
`admin`/`owner` bump; `routes.test.ts:82` operationId set +6; cross-org `SURFACES` (A7) + B11 for the
id-addressed routes; `openapi.json` regenerated. **Manual-sandbox only (D-102 analog):** the real Stripe
FC adapter and the Stripe.js client link widget are proven outside the hermetic gate; the `fake` gives
the gate a deterministic connect→sync→lines→match path.

#### OB-227b — credit-card / liability reconciliation (BUILT)

**Now built — gate-green (2,859 tests / 280 files).** A credit card is a credit-normal **liability**
bank account, and it now reconciles in its own natural frame (positive = the balance **owed**), where
before the reconciliation only read correctly for a debit-normal asset.

**The design turned out smaller and safer than the scope implied (D-227b-1).** The scope said "flip
`bookBalance` and the clearing sign convention," but on close reading **every one of those sites is
already correct double-entry for any account type** — `bankMovementLine` posting a money-out (negative)
amount to _credit_ already increases a liability correctly, and `bookBalance = SUM(debit) − SUM(credit)`
is a correct _cash-frame_ balance. The only thing wrong for a card was that a human had to **enter and
read** balances in the cash frame (negative = owed), which is unnatural. So OB-227b is a **pure
presentation/input frame transform at the reconciliation boundary** — **no change to `bankMovementLine`,
the `bookBalance`/`selectUnclearedLedgerEntries` SQL, the clearing posting, the feed, or matching.** One
helper `inNormalFrame(x, normalBalance) = normalBalance === 'credit' ? −x : x` (an involution, and the
**identity for a debit-normal asset**, which is why the entire pre-existing banking suite — 234 tests —
passes untouched) is applied at four spots in the reconciliation module: the statement closing balance is
**entered** in the account's normal frame; and every read-back figure (`computeFigures`'s six balances,
`finalise`'s mismatch difference, and the report's reconciling-item amounts) is **displayed** in it.
`selectBankAccount` was widened to carry the ledger account's `normal_balance`. **No migration, no new
permission, no route or schema change** — the wire types are unchanged, only their semantics (documented).

Built by the documented split: the orchestrator owned the ledger-critical frame transform directly (it
needs the whole picture); an **independent** author wrote the credit-card property/example suite against
the pinned convention (open→clear→finalise on a card ties out at `bookBalance '45000'` owed, a wrong-frame
closing balance is rejected, the report ties out, and an explicit asset-regression proves the identity) —
finding no sign error; and a thin web stream added an "amount owed" caption on the reconciliation screen
(gated on the ledger account's `normalBalance`) and a "(Credit card)" marker on the feed link picker. The
`fake` feed and CSV/OFX already emit cash-frame signed amounts, so a credit-card feed needed no adapter
change; a card connected via OB-227's feed now reconciles naturally.

### Follow-up — statement-of-account & report export table-stakes (OB-220, BUILT)

Two small, independent, high-perceived-completeness gaps that all three competitors ship and
OpenBooks lacked entirely. **Both are now BUILT — `yarn check` green (2,918 tests / 286 files).**

**(1) Customer statement of account** — a per-customer, branded **open-item** statement (the
invoices still owing as at a date, aged), rendered to a PDF, downloadable and optionally emailed.
[D-220-1] the open-item model **is** `getAging({ ledger:'receivable', contactId, asOf, detail:true })`
— aging's own docstring makes "what does this customer owe and since when" that call, not a second
definition of outstanding (D-34), so this is pure assembly. New module
`modules/account-statements` (renderer copied from the statement-package pdfmake pattern; service
render→store→append-only row→signed URL, plus the invoice email+capability-token half); migration
`0022` (`customer_statements`, append-only, `invoice_deliveries` keyed by contact+`as_of` rather than
an invoice); routes `POST`/`GET /v1/customer-statements` + the hosted PDF at
`/public/statements/{token}/pdf` (shares the invoice `/public/*` proxy — prod nginx gained a
`/public/` block that also fixes the pre-existing gap where the hosted invoice PDF was unreachable
behind nginx). **[D-220-perm] gated on `reports.read`, no new permission key (catalog stays 73)** —
it renders a report the holder can already run, the statement-package precedent. Web screen at
`/customer-statements` (Reports nav), customer picker + as-of + optional "email to".

**(2) Report CSV/Excel export** — every `modules/reports/*` service already computes structured rows;
`GET /v1/reports/export?report=&format=csv|xlsx` runs the same service the JSON route runs, flattens
it through a per-report adapter into a canonical `TabularReport`, and serialises it. [D-220-2] both
serialisers are **hand-rolled and dependency-free** (the repo carries no csv/xlsx/zip lib and adds
none — `enableScripts:false`, no vendor SDKs): a store-only ZIP + minimal inline-string OOXML for a
real `.xlsx`. v1 covers trial-balance, P&L, balance-sheet, general-ledger (paged through fully),
aging, cash-flow, budget-vs-actual; a web Export control sits in the Reports shell.

**Deliberate deferrals, flagged:** document-list export (invoices/bills/estimates/PO — a distinct
all-rows-per-filter paging mechanism, not a report service) and export of `cash-flow-projection` /
`audit` (bucket-grid / `audit.read`-gated). Report export is the substantive part-2 deliverable.

**(1099 tracking & e-file was split out into its own milestone — see [1099 reporting](#milestone-1099--contractor-tax-reporting-1099-necmisc-ob-228-future).)**

### Milestone 1099 — contractor tax reporting (1099-NEC/MISC) (OB-228, future)

Split out of OB-220 into its own milestone because, while it posts **no journals** (a reporting/
compliance overlay, not a ledger change — low-risk, like budgets and the audit report), it carries
real domain subtlety, sensitive PII, and a variable-cost external integration that the two small
OB-220 items do not. US table stakes: QBO ships it from Simple Start, QBD has a 1099 wizard (e-files
via Tax1099), Xero includes W-9/1099 management on all US plans.

**The pieces:**

1. **Vendor tax data (schema change).** Mark a vendor 1099-eligible and store what a form needs: TIN
   (EIN/SSN), tax classification / legal name, address, and the default form + box (1099-NEC box 1
   is the common case; 1099-MISC for rent/royalties). The **TIN is sensitive PII** — store it
   **encrypted via the existing per-org AES-GCM `SecretsProvider`** (or an encrypted column), never
   a plaintext contacts field — plus W-9 capture on the contact editor. New columns on the vendor
   contact or a `vendor_tax_info` table.
2. **Payment accumulation by calendar year (the report) — where most of the real work is.** Sum
   **cash actually paid** to each 1099 vendor in the tax year, with two correctness anchors: (a) it
   is **cash-basis, calendar-year** — payments/disbursements in the year, not bills accrued; and (b)
   it must **exclude card / third-party-network payments**, which the processor reports on 1099-K —
   double-reporting is the classic 1099 bug. **OpenBooks fits unusually well here:** PB already
   models rails as classification tags (check/ACH/wire vs. card), so the exclusion is a filter on
   existing data, not new plumbing. Threshold ($600, kept configurable — thresholds keep moving).
3. **Form generation.** 1099-NEC/MISC PDFs + the 1096 transmittal, and Copy B delivery to recipients
   — all reusing the branded-PDF **delivery** infra (the invoices / statement-package path). An
   append-only **`form_1099_filings`** record of what was filed fits the existing precedent
   (`statement_packages` / `period_close_events` are already append-only).
4. **E-file — the variable-cost piece, behind a seam.** IRS IRIS/FIRE is the compliance treadmill.
   Introduce a **`Form1099Provider`** seam (same idiom as `DocumentExtractionProvider` / `CheckOutput`)
   with a **`manual` adapter as the v1 default** — generate the data + PDFs + a CSV / IRS-format
   export the user files themselves (gate-safe, no external dependency) — and a real **e-file adapter
   deferred** (Tax1099 / Track1099 / Yearli). Optional **TIN matching** is a provider feature.

**Architecture & tripwires.** No posting path, no ledger risk. Per the schema/route-tripwire
checklist: a new migration + `MUTABLE_TABLES` / append-only entries, `generated.ts` regen against a
throwaway MySQL, and **likely a dedicated permission key** (`tax_filings.read`/`write` — SoD around
PII and filing argues against reusing `bills`), which moves the permission-matrix count, the
route-table, and OpenAPI coverage.

**Recommended v1 slice:** vendor tax fields (encrypted TIN) → calendar-year cash-paid report
excluding card rails → 1099-NEC/MISC + 1096 PDF → CSV/IRS-format export. Defer live e-file to the
`Form1099Provider` adapter. **The correctness anchor for whoever builds it is the card/third-party-
payment exclusion (1099-K overlap)** — the single most likely source of a wrong-numbers support
ticket. Effort: the track+accumulate+PDF+export slice is **small–medium**; only live e-file is
medium-large, and the seam keeps it out of the critical path.

### Follow-up — sales-tax automation via a pluggable tax provider (OB-221, future)

Today tax is a **flat, org-maintained percentage rate table** (`modules/tax/tax-rates.service.ts`)
applied per line — no jurisdiction, nexus, or filing concept. For US sellers this is below table
stakes: QBO ships a native automated engine, Xero partners with **Avalara**, QBD is semi-manual.
The recommendation is to **partner, not build the nexus engine** — introduce a `SalesTaxProvider`
seam (the same swappable-adapter idiom as extraction/mail/secrets/check output) with a `manual`
adapter (today's rate table, drives the gate) and an `avalara`/`taxjar` adapter that resolves the
rate from ship-to address + product taxability at document time. Filing/remittance stays the
provider's; OpenBooks holds the calculation seam and the liability accounting. No change to how a
line posts — the rate resolution moves behind an interface.

### Multi-currency — a community-contribution candidate, not a core milestone (OB-222, market-gated)

**Reframed (do not treat as core-team roadmap spend).** Earlier notes filed this as "the single
largest architectural gap" and an eventual own-milestone. On reflection it is **not table stakes for
the customer OpenBooks is currently built for**, and — because OpenBooks is **open source** — it is a
feature the people who need it can build, rather than one the core team should spend its scarcest
cycles on. Two independent reasons to deprioritise it, then the important part: how to keep the door
open so a contribution composes.

**Why it is lower priority than its old T1 billing suggested:**

- **The incumbents don't treat it as day-one either.** QBO gates it at **Essentials** (not Simple
  Start); Xero at **Established / Comprehensive** (top tier); only QBD has it throughout. Two of
  three put it _behind_ their entry tiers — it is a mid-tier, segment-specific feature (importers/
  exporters, cross-border services, foreign-currency accounts, most non-US businesses), not
  something every SMB needs. The large majority of US domestic SMBs never touch FX.
- **It is inconsistent with the current US-domestic direction.** Every other integration choice is
  US-only — Stripe Financial Connections (OB-227), Stripe Tax (OB-221), Gusto payroll (OB-223), 1099s
  (OB-228). Multi-currency serves a customer the rest of the near-term product isn't targeting.
  Its priority should therefore **follow market strategy**: it stays low while the target is the US
  domestic SMB, and only leads if the strategy deliberately pivots to international/cross-border or a
  non-US market (in which case it must come _before_ the US integrations, a different product bet).
- **It is the highest-blast-radius build with no cheap 80%.** It touches every money-handling module
  (currency on accounts/contacts/documents, a rate source + store, FX gain/loss accounts, period-end
  revaluation, multi-currency banking/reconciliation and payments), and a half-build that skips
  revaluation produces **wrong books** — worse than not having it. The cost is breadth, not any one
  hard problem, which is exactly the shape of change that is dangerous to accept as an uncoordinated
  external PR touching the money layer.

**The core team's job here is the contract, not the build.** Because this is a well-understood,
well-bounded, segment-motivated problem, it is a strong open-source contribution candidate — _if_ the
seams are defined up front so a contributor extends the money layer rather than forking it (the
project's own "fix the seams before you fan out" discipline). What the core team should specify and
protect, so a contribution can land safely:

- **A currency-aware money type.** The `bigint` minor-units primitive is compatible (currency is
  orthogonal to the integer amount), but the single-functional-currency assumption is baked into
  reports and the clearing/posting paths — the contract is a `(amount, currency)` pair threaded end
  to end, not a second bare integer.
- **An `FxRateProvider` seam** (the same provider-seam + BYO-credentials idiom as FC/Tax/payroll/PAY)
  for the rate source, so the rate feed is swappable and the gate runs a deterministic fake.
- **The revaluation posting path and FX gain/loss accounts** as a first-class, append-only journal
  `source` — the invariant a contributor must not break is that realized/unrealized FX is posted, not
  computed-and-discarded, so the books stay correct.
- **The append-only + cents invariants** (`no-float-money`, reversing-entry corrections, subledger
  agreement) that any multi-currency PR must continue to satisfy — these are the tripwires that keep
  a large external contribution from silently producing wrong books.

**Net:** move it off the T1 table-stakes line and onto the **strategic / market-gated** tier
alongside the T3 bets. The core team's deliverable is a **short design note pinning the four contracts
above** (so the feature is buildable and reviewable by an outside contributor), not the
implementation. Revisit only if the target market changes.

### Follow-up — payroll via a pluggable provider integration (OB-223, future)

**ABSENT** entirely, and a flagship add-on for QBO (own payroll tiers) and QBD (Enhanced/Assisted);
notably **Xero in the US ships no native payroll either — it integrates Gusto**. That is the
recommended default here too: **integrate, don't build.** Payroll is a compliance treadmill (federal

- 50 states, filings, tax tables) that is a business in itself; the industry pattern for a new
  entrant is a Gusto-style partner that runs the pay run and syncs summary journal entries + the
  liability/expense postings back in. The OpenBooks side is a provider seam + the journal-sync mapping,
  reusing `runAsAutomation` and `external_refs` for idempotent write-back — not a payroll engine.

### Milestone INVENTORY — tracked inventory & COGS (OB-224, future)

**ABSENT today** — invoice/bill lines are free-form-or-catalog-priced with no quantity-on-hand or
COGS concept; the built **catalog** module is explicitly "the natural anchor for later
inventory/COGS." Promoted to a milestone (not a small follow-up) because it is the most
architecturally involved item on the gap list — the **append-only journal kernel makes inventory
costing work differently from every competitor**, and that is the whole design. The competitive
frame: QBO Plus does FIFO + bundles, Xero does thin average-cost (≈4,000-item ceiling), **QBD
Enterprise leads** (FIFO, lot/serial, bin-level multi-warehouse, barcode, single-level BOM). "Compete
with Enterprise inventory" is a separate large programme; **v1 targets QBO/Xero parity**.

**Perpetual, not periodic.** To match the competitors, every sale posts COGS live: on an
inventory-type **purchase** `Dr Inventory asset / Cr AP` (qty ↑, cost recorded); on a **sale** the
normal `Dr AR / Cr Revenue` **plus a second COGS journal** `Dr COGS / Cr Inventory asset` at the cost
of units sold (qty ↓). The catalog item gains `item_type` (inventory / non-inventory / service), an
**inventory-asset account**, a **COGS account**, a costing method, a **`default_cost`** (standard
cost, needed as the fallback below), and a reorder point.

**Costing method — average first, and why the append-only kernel decides it.** FIFO needs
cost-_layer_ state that changes as sales draw layers down, and OpenBooks **cannot mutate** posted
records. Weighted-average maps cleanly onto an **append-only movement ledger**: each movement appends
a signed `(qtyDelta, valueDelta)`, on-hand is a running sum, and the unit cost is _derived_
(`value / qty`), never a stored mutable field. So — mirroring L's two depreciation methods —
**weighted-average ships first (matches Xero)**; **FIFO is a later second method (matches QBO)**,
modelling layers as append-only movements folded at read time.

**The defining constraint, which is a feature here.** A backdated purchase re-costs sales already
recorded; traditional perpetual systems _mutate history_ to recompute. OpenBooks resolves it with the
existing correction idiom: cost movements are sequenced, a sale costs at inventory state as of its
posting, and a correction is a **reversing + re-post adjustment journal**, never an edit. Inventory
history stays immutable and auditable — more defensible than competitors' silent recost. This reuses
the **subledger-agreement** discipline (spec §11): an `inventory_movements` subledger tying to the
inventory-asset GL account, verified the OB-088 way (compute the value several ways, assert equal).

**Negative inventory IS in v1 (owner decision) — the backorder accommodation.** Note first that a
_backorder_ is properly a **fulfillment-timing** concept (order now, ship — and only then move
COGS — later), which a non-posting sales-order / ship-on-fulfillment document solves without any
negative on-hand; OpenBooks has no order/fulfillment split today (an **invoice posts on approval**),
so negative inventory is the right accommodation for now, with a **sales-order/fulfillment model
flagged as the eventual "proper" backorder mechanism (deferred, its own scope)**. Mechanically under
append-only: (1) at a sale with no cost layer, post COGS at an **estimated** unit cost — the current
moving average, or the item `default_cost` when it has _never_ held stock — driving on-hand qty
negative and the inventory asset to a negative (credit) balance; (2) when the real receipt lands at
actual cost, do **not** mutate the original — post a **COGS true-up adjustment journal** for the
variance, dated at the receipt. That variance-as-a-visible-entry is more auditable than a silent
recost (the tradeoff to surface in the UI: users see a labelled COGS adjustment, which surprises
folks coming from QBO). Default posture **allow-with-warning**, not block.

**Cents discipline (this bites).** Money is `bigint` minor units, so **carry value in cents and
quantity separately and never store a rounded per-unit cost** — the average is a derived rational.
Load-bearing rule: **when on-hand quantity reaches zero, remaining value must be exactly zero** (the
final movement sweeps residual cents so the inventory-asset account actually clears) — the inventory
analog of `no-float-money`, and where a naive build silently drifts.

**Data model & posting.** Catalog item gains the fields above. `inventory_movements` (append-only
tenant table): item, movement type (receipt / sale / adjustment), signed `qty_delta` + `value_delta`
(cents), source-doc ref, and the `journal_id` that posted its GL effect. On-hand qty/value is a fold
over movements (any snapshot table is a rebuildable _cache_, like the journal-sequence counter is its
own table — the append-only log stays the source of truth). COGS posts through
`posting.repository.ts` (the only sanctioned path) as a **separate journal with `source='inventory'`**
so reversing an invoice reverses both revenue and COGS. Receiving is on **bill approval**, reusing
M's PO→bill (Dr Inventory instead of Dr expense for inventory-type lines). Adjustments (count /
shrinkage) are their own document `Dr/Cr Inventory vs. a shrinkage account`.

**v1 scope:** tracked inventory items, **weighted-average** costing, perpetual COGS-on-sale +
inventory-on-purchase, **negative inventory via estimate + append-only true-up**, stock adjustments,
an **Inventory Valuation** report tying to the asset account, reorder alerts. **Deferred (the QBD
Enterprise moat, separate programme):** multi-warehouse / bin locations, lot & serial, barcode,
assemblies/BOM, FIFO as the second method, and the sales-order/fulfillment backorder model. Tripwires
per the checklist: new migration + `APPEND_ONLY_TABLES`/`TENANT_TABLES` entries, `generated.ts` regen
against a throwaway MySQL, a new `source='inventory'` journal value, likely `inventory.read`/`write`
permission keys (moving the permission-matrix count, route-table, OpenAPI coverage). Defer the whole
milestone until the T1 table-stakes tier is closed.

### Follow-up — projects, job costing & time tracking (OB-225, future)

**ABSENT.** QBO Plus (Projects), Xero Established (Xero Projects), and QBD (Customer:Job + Classes)
all group income/expense/time by job for real-time profitability. OpenBooks already has the
dimensional substrate (flexible per-line dimensions) that a lightweight project object can build on
— a project as a first-class dimension that documents, bills, and time entries tag, with a
profitability report rolling up tagged activity. Time tracking is the companion piece (competitors
deliver it via QuickBooks Time / Xero Me, often a separate app). Recommend a **project-as-dimension
profitability report** as the minimal parity slice, with standalone time-clock/scheduling as a later
or partner-integrated addition.

### Follow-up — custom role builder (OB-226, future)

Roles today are **7 fixed system bundles** over a 70-key permission catalog
(`0001_tenancy`, `permissions/catalog.ts`); a **custom role builder is already deferred with the
`roles.org_id` path reserved for it** ([Accountant access & period close](#accountant-access--period-close)
decision). QBO Advanced and QBD Enterprise (115 granular permission points, data-level restriction
by customer/class) both sell this as an up-market differentiator. The build is a UI + a per-org role
row assembling existing catalog keys — no new enforcement primitive, since `requirePermission` is
already the single service-layer gate; the harder, optional extension is **data-scoped** permissions
(restrict a role to specific dimensions/customers), which QBD has and would be net-new. Recommend the
key-assembly builder first (small, reuses everything), data-scoping as a separate later question.

### Milestone MOBILE — native app shell via Capacitor (OB-232, future)

**Placeholder — not scoped.** Responsive web (Initiative R) is built and its `mobile-smoke` narrative
passes at 390px, which was the stated prerequisite: the wrapped views already work at phone width. The
candidate wraps the existing `packages/web` SPA in a **Capacitor** native shell (iOS/Android) rather
than a separate codebase, reusing the React app and the same `/v1` client, and adds native capabilities
behind a thin plugin layer — **camera** (feeds the O bill-capture pipeline directly), **push
notifications**, **biometric unlock**. The fork left open at scoping time and still open: **Capacitor
wrap vs. a fuller React-Native rewrite** — the wrap is far cheaper and reuses everything, the rewrite
buys deeper native UX; recommend the Capacitor wrap as the v1 unless a concrete native-UX requirement
forces otherwise. No ledger or API change; the work is packaging, the plugin layer, and store
submission. [Mileage tracking](#follow-up--mileage-tracking-ob-234-future) folds in here.

### Follow-up — multi-entity consolidation (OB-233, future)

**Placeholder — not scoped; low urgency (T3).** ABSENT today — every org is a standalone tenant. Only
the top-of-line competitor plans ship this (QBO Advanced "Intercompany"/IES, Xero AU "Ultra"), so it is
an up-market/agency play, not table stakes. The shape: a **parent/consolidation entity** that rolls up
several `org_id` tenants into combined statements, with **intercompany elimination** entries and a
shared or mapped chart of accounts across the set. This is the most **tenancy-invasive** candidate on
the list — consolidated reads cross the `tenantDb(orgId)` boundary that the whole architecture is built
to prevent (see the tenancy non-negotiables in `CLAUDE.md`), so the real design question is whether
consolidation is a **read-only reporting overlay** over multiple tenant scopes (preferred — no new write
path, no cross-tenant journals) or a first-class consolidation entity with its own ledger. Defer the
decision to scoping; flagged here so the tenancy implications are visible before anyone starts.

### Follow-up — mileage tracking (OB-234, future)

**Placeholder — folds into [MOBILE](#milestone-mobile--native-app-shell-via-capacitor-ob-232-future).**
ABSENT today. A low-priority solopreneur/field feature (QBO Solopreneur+, Xero Me) that is primarily a
**native-app** capability — GPS trip capture — so it is gated on the Capacitor shell and should be
scoped as part of it, not standalone. The accounting side is thin: a mileage log with a per-mile rate
produces an expense/reimbursable amount that reuses the existing expense-claim path (O / M procure-to-pay
reimbursement surface); no ledger change. Placeholder only, to keep the gap list complete.

### Open-source & self-host readiness (OB-229…OB-231)

From an OSS-readiness review (2026-08-01). These are not competitive-feature gaps — they are what
OpenBooks needs to work as an open-source project and an honest self-host, and two of them undercut
headline claims in `README.md`.

**OB-229 — SMTP email adapter (makes the self-host promise real).** The README sells "a single Docker
image you can self-host," and storage (`local`), secrets (`local` AES-GCM) and queue (`in-process`)
all have working self-host adapters — but **email does not**. The `EmailProvider` seam
(`packages/server/src/config/providers.ts`) offers only `log`/`dev` (logs, doesn't send) and `ses`
(whose `@aws-sdk/client-ses` isn't even a dependency, so it is effectively a throw-stub). A
self-hosted instance therefore **cannot send invoices, dunning, or statements** — core accounting
function. Add an **`smtp` adapter (nodemailer)** and make it the `SELF_HOST_PROVIDERS.EMAIL_PROVIDER`
default; config is host/port/user/pass/from over env (SMTP creds are the standard self-host path),
`log`/`dev` stay the deterministic gate default, and `ses` stays the hosted option. Small: one
adapter + one dependency + a config default + a provider test + docs. No schema, no permission change.

**OB-230 — reconstruct CI (unblocks external contribution).** `.github/workflows/ci.yml.disabled` is
a **0-byte empty file** — the workflow content was lost, not merely commented out, so CLAUDE.md's
"uncommenting is the whole change" and `docs/ci.md` are both wrong. With no CI: external PRs are never
validated, the pinned tripwire tests (permission-matrix, route-table, cross-org) go unenforced on
contributions, and there is no public green-build signal. Rebuild the workflow from git history
(`f8a126c`, `5d3d2cb`) + `docs/ci.md`, running `yarn check` on PRs (Docker-in-CI for the
testcontainers suite). Highest-leverage OSS fix.

**OB-231 — migrate the roadmap from `ROADMAP.md` to GitHub Issues/Projects.** This file has become a
~5,000-line internally-voiced execution log — overwhelming for outside contributors and mixing
durable decisions with session narrative. Move planned work to **Issues** (this section's `OB-NNN`
items become issues, tracked on a **Projects** board by tier/area/status), promote the **`D-NN`
decision log to ADRs** under `docs/decisions/` (which today only _points_ at this file — see
`adr-template.md`), and **freeze `ROADMAP.md` as an archived record**. Supporting elements already
drafted alongside this note: issue **forms** (`bug_report.yml`, `feature_request.yml`,
`initiative.yml`) + a `config.yml` routing security to private reporting and open questions to
Discussions, a **PR template** carrying the CONTRIBUTING gate checklist, an **ADR template**, and
`SECURITY.md` + `CODE_OF_CONDUCT.md`. Still to do in the migration proper: define the **label
taxonomy** (`type:*`, `tier:*`, `area:*`, `status:*`, `good first issue`, `help wanted`), stand up the
Projects board, port open `OB-NNN` items to issues, and **update `README.md`/`CONTRIBUTING.md`**
(which point at `ROADMAP.md`) to point at the board and `docs/decisions/`. The provider-seam stubs
(`smtp` above, `anthropic` OCR, `aws-secrets-manager`) make natural **good-first-issue** entries.

### Operations — evaluate AWS deployment architecture (OB-235, future)

**Placeholder — evaluation, not a build.** `infra/terraform` already describes a **hosted AWS topology
that is plan-clean but has never been applied** ("hosted topology, plan-clean, never applied" —
`CLAUDE.md`), and the provider seams were built with a hosted future in mind (`ses` email,
`aws-secrets-manager`, `s3` storage, `sqs` queue are all stubbed adapter slots). This todo is the
decision pass that must happen **before** a managed/hosted offering — or a production self-host on
AWS — is stood up. Open questions to settle:

- **Compute** — ECS Fargate vs. EKS vs. plain EC2/ASG for the single three-role image (`api`, `worker`,
  `migrate` — `OPENBOOKS_ROLE`); how the append-only two-user DB split (`openbooks_migrator` /
  `openbooks_app`, `0999_app_grants`) maps onto **RDS MySQL 8.4** (the `infra/scripts/check-db-bootstrap-parity.sh`
  parity contract must hold against RDS, not just Compose/testcontainers).
- **Provider adapters to make real** — the hosted path needs the currently-stubbed `ses` (or the new
  `smtp`, OB-229), `aws-secrets-manager` (deferred at PAY), `s3` storage, and a durable queue to replace
  `in-process` (`sqs` or equivalent) so the `worker` role survives a restart (the known-gap-7 restart
  caveat).
- **Migrations** — where `yarn migrate` runs in a managed deploy (one-shot task vs. init container) and
  how it holds the "migrator has DDL, app never does" split under RDS-managed users.
- **Networking / secrets / cost** — VPC + private RDS, ALB/TLS termination, secret delivery to tasks,
  and a first-order cost model (Fargate vs. EC2, RDS sizing) for a small-tenant baseline.

Deliverable is a written recommendation (a decision `D-NN` + an ADR under `docs/decisions/`), not code;
it unblocks whether a managed offering is worth building and what the reference self-host-on-AWS looks
like. Related: the [managed bank-feed model](#follow-up--live-bank-feeds-via-a-bankfeedprovider-seam-stripe-financial-connections-first-ob-227-built--gate-green)
and managed PAY both presuppose an OpenBooks-run hosted plane this evaluation would define.

### Environment notes that cost time to rediscover

- A host `mysqld` owns `127.0.0.1:3306` on the development machine, so Compose publishes
  MySQL on `DATABASE_HOST_PORT` (default **13307**) and the API on `API_HOST_PORT` (default
  **3100**). Those are deliberately separate from `DATABASE_PORT`/`HTTP_PORT`, which are
  what the processes bind _inside_ the network — setting those to dodge a host clash
  silently repoints the application. See the comments in `docker-compose.yml`.
- **The prod image builds and runs now** (was OB-027's blocker). The Docker Hub "pull hang" is the
  `credsStore: desktop` helper being consulted on public pulls; a throwaway `DOCKER_CONFIG` (empty
  `auths`, `~/.docker/contexts` copied in) does an anonymous pull without touching the real config.
  Once `node:22.19.0-slim` is cached, plain `docker compose build` works. Three latent build bugs were
  also fixed to make the image build+run for the first time since M4 (commit `2766e5a`: missing
  `packages/e2e` COPY; `__dirname` ESM shim; swagger-ui externalised). A **persistent containerised
  stack now runs on this host** — UI `:8089`, API `:3100`, MySQL `:13307`, data in
  `openbooks_mysql-data`; update with `docker compose build && docker compose up -d`.
- Editing a migration in place (D-15) leaves an already-migrated local database
  inconsistent, and `migrate:down` is what discovers it. Drop and recreate the schema; the
  reset procedure is in `src/db/migrations/README.md`.
- **Running the app end to end from the host** (proven this session): Compose MySQL up on
  13307, then two host processes with `.env.example`'s vars overridden to
  `DATABASE_HOST=127.0.0.1 DATABASE_PORT=13307 HTTP_PORT=3100 QUEUE_PROVIDER=in-process
SESSION_COOKIE_SECURE=false` — `OPENBOOKS_ROLE=api yarn workspace @openbooks/server dev`
  (the api registers the import handler in-process, [D-52](#d-52)) and
  `yarn workspace @openbooks/web dev` (Vite on 5173, proxies `/v1` and `/health` to 3100; its
  default `OPENBOOKS_API_TARGET` is already 3100). Vite binds `localhost` (IPv6) by default; add
  `--host 0.0.0.0` to reach it from a phone on the LAN, and note the macOS firewall may block
  `node`'s inbound connections. To seed a demo org over the API, `register` requires a nested
  `org` object (`{ name, chartTemplateId: 'general_small_business', fiscalYearStartMonth }`), the
  fiscal-year field is `fiscalYear` (not `year`), the bank ledger account is code `1010`, and
  every write needs an `Idempotency-Key`.

---

## Phase 1 execution — INV delivery, parallelised

The active phase, broken down so several developers can work concurrently without blocking each
other. Phase 1 is the **delivery core of INV, not all of it**: an org sets branding, and a user sends
an approved invoice — a themed PDF is rendered, retained, and emailed to the customer as a link to a
hosted, token-gated page where they view it and download the PDF. **Recurring and dunning are Phase 4**
(OB-127 scheduler, OB-128, OB-129), so they and their schema/contract/screen slices are out of scope
here.

### Status — foundations done (F1/F2/F3); S1–S5 is the active wave

The three foundation streams are **integrated on `develop`, gate green (2073 tests)**. The concrete
names S1–S5 build against:

- **F1 (OB-123) — contracts.** `packages/shared-types/src/delivery/{branding,delivery}.ts`:
  `orgBrandingSchema` / `updateOrgBrandingRequestSchema`; `sendInvoiceRequestSchema` (`{ recipientEmail? }`);
  `invoiceDeliverySchema` (`status` ∈ `['sent','failed']`, `publicUrl`, no token secret/hash);
  `publicInvoiceViewSchema` (customer-safe — no internal ids; `branding.logoUrl`, never `logoStorageKey`).
  The `ORG_BRANDING_*_MAX_LENGTH` constants in `branding.ts` are the width source of truth.
- **F2 (OB-122) — schema.** `0007_invoice_delivery`: `org_branding` (lazy one-row-per-org, PK `org_id`,
  MUTABLE) and `invoice_deliveries` (APPEND-ONLY: `id`, `org_id`, `invoice_id`→`ar_documents`,
  `recipient_email`, `artifact_storage_key`, `key_prefix`, `token_hash` BINARY(32), `provider_message_id`,
  `status` CHECK IN `('sent','failed')`, `sent_at`). `generated.ts` regenerated.
- **F3 (OB-120) — storage.** `storageProvider(): StorageProvider` / `setStorageProvider(...)` in
  `providers/index.ts` (lazy, no logger). Local `signedUrl` returns `/artifacts/<key>` (the api streams
  it); s3 is a real presigned GET. `@aws-sdk/client-s3` + `s3-request-presigner` added.

**Locked forks:** PDF via **pdfmake** behind an `InvoiceRenderer` interface; the hosted page is a
per-delivery capability token `{prefix}.{secret}` (`key_prefix` + SHA-256, no expiry), served by public
endpoints `GET /public/invoices/{token}` and `.../pdf` **outside `/v1`** (resolve org→`tenantDb` from the
token; its own security review).

**Codegen note:** a pre-release DB cannot take `0007` incrementally (it sorts before the applied
`0999`), so codegen against a **throwaway** MySQL migrated fresh — never the running stack (see
CLAUDE.md → Agents).

**Next: the five parallel streams** — S1 branding · S2 renderer · S3 hosted page · S4 web UI · S5
transport — each against the above, then C1 `sendInvoice` integrates and C2 covers it. The DAG and the
interface contracts are below, unchanged.

### The Phase 1 slice of the INV tickets

Some INV tickets span both phases; Phase 1 takes only their delivery portion.

| Ticket                              | Phase 1 scope                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| **OB-120** StorageProvider adapters | Whole — `local` + `s3` + `storageProvider()`. First consumer, foundation.                   |
| **OB-121** Hosted invoice page      | Whole — capability token, the two public endpoints, the SPA public route.                   |
| **OB-122** Schema                   | **Delivery only** — `org_branding` + `invoice_deliveries`. (recurring/dunning tables → P4.) |
| **OB-123** Wire contracts           | **Delivery only** — branding, send request/response, public-invoice view.                   |
| **OB-124** Branding service + logo  | Whole.                                                                                      |
| **OB-125** PDF renderer             | Whole.                                                                                      |
| **OB-126** `sendInvoice`            | Whole.                                                                                      |
| **OB-130** `/v1` surface            | **Delivery only** — branding, send, and the public page endpoints.                          |
| **OB-131** Screens                  | **Delivery only** — invoice preview/send + branding settings.                               |
| **OB-132/133** Enforcement + E2E    | **Delivery only** — brand → send → view → download.                                         |

### Two forks resolved, so no stream is blocked on a decision

- **PDF library → `pdfmake`.** Declarative document-definition, tables are first-class (an invoice is
  a header + an addresses block + a line-item table + totals + footer), Node-native, deterministic,
  and lighter than `@react-pdf/renderer`. Wrapped behind an `InvoiceRenderer` interface so the choice
  is swappable and every consumer depends on the interface, not the library. _(My call — overridable;
  `@react-pdf/renderer` is the JSX-layout alternative if the web team prefers it.)_
- **Hosted-page token.** A **per-delivery capability token**, minted as `prefix.secret` (32-byte
  secret) and stored on `invoice_deliveries` as `key_prefix` + SHA-256 hash — the exact pattern
  `sessions`/`api_keys`/`oauth_tokens` already use. URL `/(i)/{token}`; **no expiry** (an approved
  invoice stays viewable), read-only, no session — the token is the whole authorization ([D-74](#d-74)).
  Served by two **public, token-gated endpoints outside the `/v1` permission surface**:
  `GET /public/invoices/{token}` (the view) and `GET /public/invoices/{token}/pdf` (streams the
  retained artifact). The endpoint resolves org → `tenantDb` from the token, so tenant isolation
  still holds below it; this is the **one sanctioned unauthenticated read**, and it gets its own
  security review (a new surface that bypasses `requirePermission`).

### The contract-first seams (built first, fast — they gate everything)

- **F1 — Wire contracts** (OB-123 delivery subset): branding, the send request/response, the
  `PublicInvoiceView` shape, and the token format. Once these Zod schemas land, service _and_ web
  developers code against them, not each other.
- **F2 — Schema** (OB-122 delivery subset): `org_branding` + `invoice_deliveries` + grants.
- **F3 — StorageProvider interface**: already exists in `plugin-api`; OB-120 builds the adapters, but
  every consumer codes against the interface from day one.

### Parallel workstreams (the DAG)

**Foundation (day 0–1, front-loaded — small, gates the rest):**

| #   | Stream           | Ticket            | Depends on           |
| --- | ---------------- | ----------------- | -------------------- |
| F1  | Wire contracts   | OB-123 (delivery) | —                    |
| F2  | Schema + grants  | OB-122 (delivery) | —                    |
| F3  | Storage adapters | OB-120            | — (interface exists) |

**Then five concurrent streams, each against the contracts/interfaces — not against each other:**

| #   | Stream                                 | Ticket            | Depends on       | Works standalone via                            |
| --- | -------------------------------------- | ----------------- | ---------------- | ----------------------------------------------- |
| S1  | Branding service + logo                | OB-124            | F2, F3-interface | —                                               |
| S2  | PDF renderer (`pdfmake`)               | OB-125            | F1, F3-interface | a **branding fixture** (doesn't wait on S1)     |
| S3  | Hosted page + token + public endpoints | OB-121            | F1, F2           | a **stub PDF + stub view** (doesn't wait on S2) |
| S4  | Web delivery UI + branding settings    | OB-131 (delivery) | F1               | a **mock client** off the contracts             |
| S5  | `/v1` transport (branding, send)       | OB-130 (delivery) | F1               | maps arguments; wires to services when ready    |

**Convergence (the integrator, once S1+S2+S3 land):**

| #   | Stream            | Ticket                | Depends on                                      |
| --- | ----------------- | --------------------- | ----------------------------------------------- |
| C1  | `sendInvoice`     | OB-126                | S1, S2, S3, F2 (the one place the streams meet) |
| C2  | Enforcement + E2E | OB-132/133 (delivery) | C1, S4                                          |

**Critical path:** F1 → S2 → C1 → C2. Everything else fans out around it; with ~5 developers the
foundation clears in a day or two and S1–S5 run in parallel until `sendInvoice` integrates them.

### The interface contracts between streams (so a stream never has to read another's code)

- **`InvoiceRenderer.render(invoice, branding) → { bytes, contentType }`** — S2 owns; C1 and S3
  consume. Branding is a typed input from F1, so S2 develops against a fixture until S1 is ready.
- **`storageProvider().put/get/signedUrl(key)`** — F3 owns the adapter; S1/S2/S3/C1 code against the
  `plugin-api` interface that exists today. Keys are org-scoped (`{orgId}/branding/logo`,
  `{orgId}/invoices/{id}/{deliveryId}.pdf`).
- **`PublicInvoiceView` + the token format** (F1) — S3 and S4 both consume; neither invents its own.
- **`invoice_deliveries` columns** (F2) — C1 writes the row (recipient, artifact key, `key_prefix` +
  token hash, provider message id, sent-at); S3 reads it to resolve a token to an invoice + artifact.

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

| #   | Acceptance criterion                                                                                | Verified by    |
| --- | --------------------------------------------------------------------------------------------------- | -------------- |
| B1  | A full month of books runs end to end in a real browser against the Compose stack                   | OB-055         |
| B2  | P&L and balance sheet tie to the trial balance for any date range                                   | OB-053         |
| B3  | The balance sheet balances without a closing journal — corrected identity in [D-20](#d-20)          | OB-043, OB-053 |
| B4  | GL opening balance + movement = closing balance, for every account and every range                  | OB-044, OB-053 |
| B5  | A draft is freely editable and discardable; posting it is the only path to the ledger, exactly once | OB-038, OB-054 |
| B6  | Dimension tagging never moves money — every report unsliced equals its slices plus unassigned       | OB-041, OB-053 |
| B7  | Hierarchy subtotals equal the sum of descendants, and a cycle is unrepresentable                    | OB-035, OB-039 |
| B8  | A retried register / create-org / switch-org yields exactly one of the thing (M1 gap 1 closed)      | OB-028, OB-054 |
| B9  | No component names a raw colour, spacing, or radius — tokens only, lint-enforced                    | OB-046, OB-056 |
| B10 | Every screen's affordances follow the caller's permission set, and the service refuses regardless   | OB-030, OB-054 |
| B11 | The new resources hold the A7 line — a cross-org read is a 404 with a byte-identical body           | OB-054         |

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
migration files; the two that touch `journal_lines` and `0999_app_grants` are **edited in
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
tables since M1 to need `UPDATE`/`DELETE` in `0999_app_grants`. That allowlist is the
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

| ID         | Title                                                       | Size | Depends on |
| ---------- | ----------------------------------------------------------- | ---- | ---------- |
| **OB-053** | Report property suite (fast-check)                          | L    | 041–044    |
| **OB-054** | Enforcement and permission matrix for M2 resources          | M    | 045, 051   |
| **OB-055** | Playwright e2e — the B1 narrative                           | M    | 047–052    |
| **OB-056** | CI: web build, token lint, e2e job                          | M    | all        |
| ~~OB-057~~ | ~~Walk ACH Pro's QBO integration~~ — dropped, [D-33](#d-33) | —    | —          |

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

**OB-057** — **Dropped ([D-33](#d-33)).** ACH Pro connectivity is not a primary v1
objective, so the walkthrough's findings would shape endpoints against a consumer v1 does
not commit to serving. What it would have bought, and what declining it costs, is in the
decision.

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

### M3 status

All fourteen M3 tickets are built on `develop`, plus two follow-ups the wave forced
(OB-066a, and the enforcement scan repair). `yarn check` passes: 1,745 tests across 146
files.

**C2 found a real defect on its first run**, which is what spec §11 named the invariant
for. `aging.repository.ts` bounded an allocation by `allocated_on <= asOf` and never asked
whether the document at its _other_ end had posted by then. An allocation's date defaults
to its source's date and a source routinely predates its target, so a deposit taken on
5 January and applied to an invoice approved on 23 February carried 5 January: at 22
February the subledger said the customer owed nothing while the control account still held
their credit. A back-dated credit note reads the same way from the other side. Nothing
threw, the report was internally consistent, and only comparison with the ledger noticed —
which is the entire argument for [D-34](#d-34) and for making subledger agreement a test
rather than a review item. Fixed by a fourth as-at predicate; reproduced by reverting it
(`expected 0n to be -10000n`) before the fix was accepted.

Two follow-ups are recorded rather than folded in:

1. **`PostJournalInput` has no `source`**, so every document journal posts as `'manual'`
   rather than `'invoice'`/`'bill'`/`'payment_received'`. Reported by three agents. It
   touches the ledger kernel — `plugin-api` plus `posting.service.ts` — and deserves its
   own ticket.
2. **AR and AP spell the same refusals differently**, and AR raises `ConflictError` for
   double-approve and double-void, which carries no `details` bag at all — so a client gets
   `409` with prose and nothing machine-readable, where AP gives `412` plus
   `document_already_approved`. That is a functional gap, not a naming preference. The AP
   vocabulary should win. Reconciling it is a wire-contract change, since
   `document_not_draft` is already published in the `updateInvoice` description.

Also known and unchanged: `ar_only` and `ap_only` hold `invoices.*`/`bills.*` but not
`journals.post`, so the roles that exist to enter AR and AP documents cannot approve, void,
or record a payment — ten published operations, pinned as a known gap rather than fixed,
because seeding those codes is a migration and a product decision.

### M2 status

All of M2 is built on `develop`. `yarn check` passes: 1,319 tests across 118 files, plus
the B1 e2e narrative in a real browser. **Every M2 ticket is complete**, and OB-057 is
dropped rather than outstanding ([D-33](#d-33)). M3 is scopeable now.

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
| **OB-059** | Built | A posted draft carries its contacts and tags. New ticket — the wave-2 defect     |
| **OB-041** | Built | Report core: `getAccountBalances`, differential-tested against the trial balance |
| **OB-042** | Built | P&L; sign keyed off `type`, never `normalBalance` — contra accounts              |
| **OB-043** | Built | Balance sheet; **two** derived equity lines, not one ([D-20](#d-20))             |
| **OB-044** | Built | General ledger; running balance recomputed per page, not carried in the cursor   |
| **OB-045** | Built | 42 operations over 27 new paths; the whole M2 surface is now reachable           |
| **OB-047** | Built | Auth, org switch, routing; three route tables rather than in-route redirects     |
| **OB-048** | Built | Chart of accounts; detached rows named rather than dropped                       |
| **OB-049** | Built | Contacts; the two delete refusals get different remedies                         |
| **OB-050** | Built | Settings — periods first, because a fresh org cannot post without them           |
| **OB-051** | Built | Journal entry; balancing stays in `bigint`, one idempotency key per draft        |
| **OB-052** | Built | Four report viewers, shared controls, drill-through                              |
| **OB-053** | Built | Rescoped: the five properties that span _two_ reports, which nobody owned        |
| **OB-054** | Built | 59 operations × 6 roles, plus body and query cross-org references                |
| **OB-055** | Built | The B1 narrative in Chromium, ~7s; asserts figures rather than headings          |
| **OB-056** | Built | `build` and `lint:tokens` in the gate; new web and e2e jobs                      |
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
after `0999_app_grants` can never be granted, and numbering around it (`0003a`, `0003b`, …)
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

Outstanding work, as against notes:

Both items previously listed here are done. The report core's two internal cleanups landed
with wave 4 — `dimensionFilterPredicate` is exported and shared (the two copies were
verified byte-identical before being collapsed, rather than assumed equivalent), and the
core gained an internal-only `accountIds` option so the general ledger no longer aggregates
the whole chart to read one account. The third, the thrice-declared dimension group key,
was resolved by OB-045 while deciding component identity for the published spec. And the
starter chart is now applied at org creation, through `deriveContext`/`runInContext` inside
`createOrgIn`'s transaction rather than through an org parameter (spec §4).

One follow-up OB-045 could not make: the members module's **request** schemas are still in
`modules/members/input.ts`, so its routes import them and re-register them with an id.
Moving that file into `shared-types` changes zero bytes of `openapi.json` and removes the
one place a wire contract has two homes.

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

## Milestone 3 — Accounts receivable and payable

### Definition of done

A business invoices its customers, records its bills, applies payments to both, issues
credit notes, and reads what it is owed and what it owes as at any date — with every
figure reconciling to the ledger that M1 and M2 built.

This is the milestone where **spec §11's subledger-agreement invariant becomes testable**.
M1 deferred it with "no subledger exists until M3"; one exists now, and C2 below is that
deferred test arriving.

| #   | Acceptance criterion                                                                       | Verified by    |
| --- | ------------------------------------------------------------------------------------------ | -------------- |
| C1  | Approving an invoice or bill posts a balanced journal; nothing else writes to the ledger   | OB-062, OB-063 |
| C2  | **Subledger agrees with the ledger**: outstanding AR = the AR control account, at any date | OB-070         |
| C3  | An allocation reduces what is outstanding; over-allocating an invoice is refused           | OB-064, OB-070 |
| C4  | An unapplied payment is a credit on the contact, and applying it later reconciles          | OB-064, OB-070 |
| C5  | Inclusive and exclusive entry of the same invoice post identical journals — [D-35](#d-35)  | OB-061, OB-071 |
| C6  | A credit note nets its invoice to zero on every report and in the subledger                | OB-062, OB-070 |
| C7  | Voiding leaves the document and its reversal visible; nothing is deleted                   | OB-062, OB-063 |
| C8  | Aging as at a date sums, per bucket and in total, to the control account at that date      | OB-065, OB-070 |
| C9  | Document numbers are gapless per org per type                                              | OB-060, OB-070 |
| C10 | Every new resource holds the A7 line — cross-org is a 404 with a byte-identical body       | OB-071         |
| C11 | The permission matrix shows AR/AP powers arriving, per known gap 6                         | OB-071         |

### Explicitly out of M3

- Multi-currency (spec §13), and therefore FX gain/loss on settlement.
- Bank feeds, import, and reconciliation — M4. A payment here is recorded, not matched.
- Recurring invoices, dunning, statements-by-email, customer portals.
- Compound and multi-jurisdiction tax. See [D-35](#d-35).
- Purchase orders, quotes, estimates, inventory costing.
- Cash-basis reporting, still. [D-22](#d-22) is unchanged: it needs a payment date to
  switch on, and now that payments exist it becomes _possible_ — but it is a reporting
  milestone's work, not AR/AP's.

---

### Ticket board

#### Wave 0 — Contract and schema (2 parallel)

| ID         | Title                                              | Size | Depends on |
| ---------- | -------------------------------------------------- | ---- | ---------- |
| **OB-060** | The M3 schema, and the grants migration renumbered | L    | —          |
| **OB-061** | M3 wire contracts and the tax primitive            | M    | —          |

**OB-060** — Every M3 table, plus the structural fix M2 deferred: `0999_app_grants` is
renumbered to sort **last** permanently. M2 worked around the ordering constraint with
`0003a`/`0003b`/`0003c` suffixes and then dissolved them by folding everything into
`0002_ledger`; that file is now large, and M3's ten-odd tables are a coherent subsystem
rather than a change to the ledger. Renaming the grants migration is what makes a
`0005_subledger` possible at all — MySQL refuses a table-level `GRANT` on a table that
does not exist, so anything created after it can never be granted.

**OB-061** — The wire contracts, in `packages/shared-types`, with **no `.meta({ id })`**
until OB-066 adds routes. Independent of the schema by construction: this is API shape,
not storage. Fixing it first is what lets five services fan out in wave 1 without each
inventing its own money-and-tax vocabulary.

#### Wave 1 — Subledger services (5 parallel)

| ID         | Title                                   | Size | Depends on |
| ---------- | --------------------------------------- | ---- | ---------- |
| **OB-062** | AR documents: invoices and credit notes | L    | 060, 061   |
| **OB-063** | AP documents: bills and vendor credits  | L    | 060, 061   |
| **OB-064** | Payments and allocation                 | L    | 060, 061   |
| **OB-065** | Aging and subledger reporting           | M    | 060, 061   |
| **OB-066** | Tax rates service                       | M    | 060, 061   |

#### Wave 2 — Transport and screens

| ID         | Title                                   | Size | Depends on |
| ---------- | --------------------------------------- | ---- | ---------- |
| **OB-067** | `/v1` surface for everything M3 adds    | M    | 062–066    |
| **OB-068** | Invoices and credit notes screens       | L    | 067        |
| **OB-069** | Bills and vendor credits screens        | L    | 067        |
| **OB-070** | Payments, allocation, and aging screens | L    | 067        |

#### Wave 3 — Verification

| ID         | Title                                             | Size | Depends on |
| ---------- | ------------------------------------------------- | ---- | ---------- |
| **OB-071** | Subledger agreement property suite (spec §11)     | L    | 062–066    |
| **OB-072** | Enforcement matrix extension, and gap 6 made loud | M    | 067        |
| **OB-073** | E2E: invoice → payment → aging                    | M    | 068–070    |

OB-071 is the milestone's centre of gravity, not its afterthought. Spec §11 named
subledger agreement as an invariant in M1 and it has waited two milestones for something
to agree with.

---

## Milestone 4 — Banking

The largest phase, and the last one before a credible public launch (M1–M4 plus
QuickBooks import).

### Definition of done

A business uploads a statement, sees each line proposed against something — an existing
entry, an open invoice or bill, or a new coding — accepts or corrects the proposals, and
finishes a reconciliation that asserts the books agreed with the bank at a stated balance
on a stated date.

Acceptance criteria are lettered **E** rather than D, because `D-nn` is already the
decision register.

| #   | Acceptance criterion                                                                           | Verified by    |
| --- | ---------------------------------------------------------------------------------------------- | -------------- |
| E1  | Re-importing the same statement produces no duplicate lines, whatever the file's ordering      | OB-078, OB-088 |
| E2  | A statement line is never modified after import — what the bank said is a fact                 | OB-074, OB-088 |
| E3  | **Matching proposes; it never posts.** Every ledger write on this path is a human decision     | OB-079, OB-088 |
| E4  | A cleared line and the entry it clears agree exactly on amount, and the difference is recorded | OB-081, OB-088 |
| E5  | Finalising a session asserts book balance = statement balance at the date, or refuses          | OB-082, OB-088 |
| E6  | Reopening a finalised session is permission-gated and leaves a record of who and when          | OB-082, OB-089 |
| E7  | Reconciliation and fiscal-period close are independent locks                                   | OB-082, OB-088 |
| E8  | A rule change never restates an entry already posted                                           | OB-080, OB-088 |
| E9  | Cross-org holds for every new resource — 404, byte-identical                                   | OB-089         |
| E10 | A 5,000-line statement imports and matches without pathological behaviour, measured            | OB-088         |

### Explicitly out of M4

- **Live bank feeds.** File import only; see [D-41](#d-41). The provider interface ships so
  a feed slots in behind it.
- Multi-currency, still (spec §13) — and therefore FX on settlement.
- Payment initiation. This reads what happened; it never moves money.
- The workflow engine. Bank rules are a lookup table, not an engine — [D-44](#d-44).
- Cash-basis reporting. Possible since M3 gave payments a date, still not scoped; it
  belongs to a reporting milestone rather than to banking.

---

### Ticket board

18 tickets across 6 waves.

#### Wave 0 — Schema and contracts (2 parallel)

| ID         | Title                     | Size | Depends on |
| ---------- | ------------------------- | ---- | ---------- |
| **OB-074** | Banking schema and grants | L    | M3         |
| **OB-075** | Banking wire contracts    | M    | M3         |

#### Wave 1 — Ingest (3 parallel)

| ID         | Title                                           | Size | Depends on |
| ---------- | ----------------------------------------------- | ---- | ---------- |
| **OB-076** | CSV import with saved column mappings           | L    | 074, 075   |
| **OB-077** | OFX/QFX parser                                  | M    | 074, 075   |
| **OB-078** | Statement service: dedupe, idempotent re-import | L    | 074, 075   |

#### Wave 2 — Matching (3 parallel)

| ID         | Title                                      | Size | Depends on |
| ---------- | ------------------------------------------ | ---- | ---------- |
| **OB-079** | Match proposal engine                      | L    | 078        |
| **OB-080** | Bank rules                                 | M    | 078        |
| **OB-081** | Accepting a match: post, link, or allocate | L    | 079, M3    |

#### Wave 3 — Reconciliation (2 parallel)

| ID         | Title                                                   | Size | Depends on |
| ---------- | ------------------------------------------------------- | ---- | ---------- |
| **OB-082** | Reconciliation sessions and the reopen                  | L    | 081        |
| **OB-083** | Reconciliation reporting and the cleared-balance report | M    | 082        |

#### Wave 4 — Transport and screens (4)

| ID         | Title                             | Size | Depends on |
| ---------- | --------------------------------- | ---- | ---------- |
| **OB-084** | `/v1` surface for banking         | M    | 076–083    |
| **OB-085** | Import and column-mapping screens | M    | 084        |
| **OB-086** | The matching screen               | L    | 084        |
| **OB-087** | The reconciliation screen         | L    | 084        |

OB-086 is the milestone's hardest screen and the one its usability rests on: a few hundred
rows, each with a proposal to accept, correct, split, or defer, and it has to stay fast and
keyboard-driven or the whole feature is worse than a spreadsheet.

#### Wave 5 — Verification and the worker (3)

| ID         | Title                                                    | Size | Depends on |
| ---------- | -------------------------------------------------------- | ---- | ---------- |
| **OB-088** | Banking property suite and the reconciliation invariants | L    | 082, 083   |
| **OB-089** | Enforcement matrix extension                             | M    | 084        |
| **OB-090** | E2E: import → match → reconcile                          | M    | 085–087    |

Plus the carried item [D-47](#d-47) forces: the worker's restart policy and the queue
decision, both of which M4 is the first milestone to actually need. Both are now settled by
[D-49](#d-49) — the queue implementation and the policy change land together in wave 1.

---

### Status — Milestone 4

**M4 is built and verified.** All of OB-074 … OB-090 (bar the two deferred follow-ups OB-094
and OB-095); the gate is green and the E2E passes against a real stack.

#### Wave 5 — verification, and the two defects it caught (OB-088, OB-090)

- **OB-088 — the property suite.** The centre is the cross-cutting invariant no single-ticket
  test sees: after a generated import → clear → reconcile, the cleared balance is computed
  **four independent ways over four tables and asserted equal** — the session's own figure, Σ
  of the clearings, the bank ledger account recomputed straight from `journal_lines`, and the
  report's enumeration (`bookBalance − Σ items`). That is spec §11's subledger agreement one
  level down. Plus reproducibility (D-51), exact finalisation (E5), the cents round-trip, and
  **E10 measured** — a 5,000-line file imports in ~130 ms, a shuffled re-import (all duplicate)
  in ~40 ms, and proposals per page are O(1) in page size (6 queries at 50 and at 200 lines).
  Three mutations introduced by hand, all caught. No defect surfaced here.
- **OB-090 — the browser narrative.** Import a statement, match it, reconcile, and the figures
  tie (cleared 850 = statement 850; the unpresented cheque a reconciling −100 that does not
  block). It runs green against a real host-run API and Compose MySQL — and it did its job by
  catching two defects the unit tests structurally could not:
  1. **The banking tabs looped to an OOM.** Relative `NavLink`s under the `/banking/*` splat
     resolved by appending (`/banking/match/import`), then the catch-all redirected again
     without bound. The jsdom tests mount the sub-screens directly and never clicked a tab.
     Fixed with absolute paths; a routing test now clicks a tab and asserts the path is
     replaced, not appended.
  2. **The async import never drained in the shipped topology** — see [D-52](#d-52).

#### Wave 4 — the `/v1` surface and the three screens (OB-084–OB-087)

- **Transport (OB-084)** — 27 banking operations across five route files, thin handlers that
  map arguments (dependency-cruiser enforces no business logic in transport). The wire schemas
  gained their `.meta({ id })`; spec and client regenerated; `yarn drift` clean. Two thin read
  services (bank-account register/list, statement-line list) that waves 1–3 never needed
  because they only ever read one at a time.
- **The async import got a poll surface.** `startImport` answers `202` with a queued row; a new
  `GET /v1/bank-statement-imports/:id` polls it. `bankStatementImportSchema` now carries the
  lifecycle — `status`, `result` nullable (present only when `complete`), `failureReason` (only
  when `failed`) — with a refinement mirroring `0006`'s CHECK, so an impossible import neither
  parses nor emits. `listBankImportMappings` became a query filter, not a nested collection:
  the service answers an unknown account with an empty page, and a path-nested list would
  promise a 404 it does not give (the A7/B11 distinction).
- **The screens.** Import with a mapping editor that encodes the contract's two traps — the date
  order is chosen not guessed, the credit column is money in (OB-085). The matching screen,
  keyboard-driven, one batch of proposals per visible window (E10), accept mapping a proposal's
  `kind` one-to-one onto a clearing method, and **no score rendered** because confidence is the
  ordering (OB-086, D-43/D-48). The reconciliation screen splitting "what must agree to finalise"
  from "reconciling differences — expected", so an unpresented cheque reads as a difference the
  report explains, and finalise defers to the server's assertion (OB-087). Wired into a tabbed
  **Banking** section gated on `banking.read` (advisory, D-25 — the services enforce).
- **Publishing the routes forced all three enforcement coverage matrices**, not one: a gated
  operation must appear in permission-matrix (coverage), cross-org (A7) and cross-org-references
  (B11). One shared banking scene extends all three — the 27 operations each a real service
  call, cross-org ids 404-parity, body refs scoped. This is OB-089's coverage core, landed with
  OB-084 because the gate couples them.

**Known deviation — split is a decision, not a screen.** OB-086's definition of done lists
"accept, correct, split, or defer", but a **split** — one statement line coded across several
accounts — is not expressible: a line clears once (`uq_blc_line`) and a clearing codes it to
one target. The screen does accept/correct/defer/undo cleanly. Split needs a clearing contract
that carries multiple coded portions under one clearing (an array of `{ accountId, amount }`
summing to the line), which is a schema and product decision, deferred pending that call.

#### Wave 3 — reconciliation (OB-082, OB-083)

- **A session is the assertion the milestone exists to make.** Open, update, finalise,
  reopen, with every balance computed on read (D-46) except the statement's closing figure —
  the one claim from outside. Finalisation asserts `clearedBalance === statementClosingBalance`
  ([D-50](#d-50)): an unpresented cheque is a reconciling difference the session reports, not
  a blocker. Membership is frozen at finalisation by stamping the session id onto the
  clearings it counted ([D-51](#d-51)); reopen unstamps. E7 independence is proven (closing a
  fiscal period then finalising leaves the period row byte-identical), and contention is
  proven on the session row with two real connections.
- **D-51 reached back into OB-081.** Its undo refusal read the line's date against any
  finalised session's window; after D-51 that is the wrong notion of membership — it would
  refuse undoing a straggler the assertion never counted. It now reads the clearing's own
  stamp. The date query is gone and `0006`'s "falsifiable" comment is rewritten.
- **The reconciliation report ties to the ledger (OB-083).** The reconciling items — bank
  account journal movements in the window not linked to a counted clearing — sum exactly to
  `unclearedAmount`, so `clearedBalance + Σ items === bookBalance`. Uncleared statement lines
  are a separate labelled list, because a line with no journal moves neither balance and
  cannot belong to that sum — the honest reading of D-50. This is D-40's C8 for reconciliation:
  a report that does not tie to the gap is a list of hopes. Reproducible as at a past date
  because a finalised report reads the frozen membership, not a re-query.
- **`banking.reconcile` and `banking.reopen` are now enforced**, the last two latent banking
  codes. `reopen` is its own operation and its own code because withdrawing an assertion (E6)
  is a power held apart from making one.

#### Wave 2 — the matching pipeline (OB-079, OB-080, OB-081)

Fanned out around a committed `RuleEvaluator` seam (`modules/banking/rule-evaluator.ts`), so
the read-only engine and the rules stayed parallel without importing each other; they meet
at the banking barrel, which pairs the engine with the concrete evaluator the way
`parseStatement` pairs the import service with the concrete parsers.

- **Matching proposes, it never writes (D-43, E3).** The engine ranks candidates from four
  sources loaded once per page — existing journals (`link_entry`), open documents
  (`allocate_document`, reusing aging's outstanding), a rule match, and the org's own coding
  history — and emits `rank` plus the reasons behind it, **never a score** ([D-48](#d-48)).
  The tie-break is on each candidate's durable identity, not the per-call proposal id, so a
  statement ranks identically twice. E10 held: ~7 reads for a whole page, proven by a
  `Com_select` delta that does not grow with line count.
- **Rules are a deterministic lookup (D-44), first match by `(priority, created_at, id)`.**
  The winner is proven invariant under all 720 permutations of a six-rule set. No regex, and
  no backward reach (E8) — there is no re-run-over-existing-lines shape.
- **Clearing is the one write path (E4).** `clearedAmount + differenceAmount = line.amount`
  is an invariant that closes by construction: a £990 line settling a £1,000 invoice records
  the payment in full (the subledger stays in agreement, C2) and reconciles only the bank to
  the line via a charges journal. Undo reverses, never deletes (D-16), and is refused once a
  finalised session has counted the line. Contention proven with two real connections on the
  clearing insert keys, since the append-only line and journal cannot be locked (D-14).
- `banking.match` is now enforced (rules and clearing) and moved into the matrix — the wave-2
  slice of OB-089. `banking.reconcile`/`reopen` stay latent for wave 3.
- A contract fix landed: `bankRuleConditionSchema`'s "match on something" refinement counted
  `bankAccountId`, so a condition naming only an account passed the wire and then failed the
  DB CHECK as a 500. Narrowed to the four real predicates.

#### Wave 1 — ingest, the queue, the async import path (OB-076, OB-077, OB-078)

Fanned out around a committed parser seam (`modules/banking/parser.ts`): a parser turns
bytes into bank facts and nothing else — the occurrence index, the fingerprint and the
dedupe belong to the stage that can see the stored lines and the rest of the file, which is
the statement service. Both parsers add **no dependency**: a tolerant hand-written
tokeniser reads OFX 1.x SGML and 2.x XML alike (a strict XML parser rejects valid 1.x), and
a hand-written RFC-4180 tokeniser reads CSV.

- **E1 is proven as properties, not examples.** The fingerprint is SHA-256 over a canonical
  JSON array of the supplied fields (injective, delimiter-safe); the occurrence index is
  stored beside it and numbered order-independently; persistence is `INSERT IGNORE`. The
  suite asserts re-import collapses, a shuffled file produces the identical stored set, two
  identical transactions both survive, an overlapping re-upload adds only the new lines, and
  a **crash re-run inserts nothing new** — which matters because the in-process queue does
  not survive a restart, so an interrupted import is re-run and E1 is what makes that safe.
- **`bank_statement_imports` became mutable** — the resolution of the tension wave 0 handed
  forward. The async lifecycle updates a `status` (`queued`→`complete`/`failed`) on a single
  pollable row, which an append-only table cannot carry. The evidence argument is unmoved: a
  re-import creates a **new** row and rewrites none, and E2's immutability lives on
  `bank_statement_lines`, still append-only at the grant level. `0999_app_grants` moved the
  import table from `APPEND_ONLY_TABLES` to `MUTABLE_TABLES`; the line log stays append-only.
- **The queue is the in-process adapter of the existing `QueueProvider`** (D-49, D-07's rule
  a third time), selected like the email provider. `startImport` enqueues; the worker parses,
  dedupes and inserts. The worker's Compose restart policy is now `unless-stopped`.
- **The permission matrix moved with the services.** `banking.import` and `banking.read` left
  `LATENT_GRANTS` for `GRANTED_TO` the moment the import and mapping services enforced them,
  with `OPERATIONS` rows carrying `operationId: null` until OB-084 gives them routes — the
  shape `getPeriod` has held since M2. This is the wave-1 slice of **OB-089**;
  `banking.match`/`reconcile`/`reopen` stay latent for waves 2–3.

#### Wave 0 — schema and contracts (OB-074, OB-075)

Ten tenant-scoped tables in `0006_banking`, nine wire contract files in
`packages/shared-types/src/banking/`.

Three facts the schema had to be **measured** to learn, all recorded in `0006_banking.ts`'s
header so they are not paid for twice:

- **No composite tenant FK can ever be `ON DELETE SET NULL`.** MySQL 8.4 requires every
  column of a `SET NULL` key to be nullable, and `org_id` is `NOT NULL` on every tenant
  table. `CASCADE` and `RESTRICT` are the only actions available anywhere in this schema.
- **At most one open reconciliation session per bank account** is enforced by a stored
  generated column plus a unique key — but only with `ON DELETE RESTRICT`, because MySQL
  refuses a foreign-key action on a column a `STORED` generated column reads. This is the
  same finding `0003` made, arrived at independently.
- Amounts on `bank_statement_lines` are **signed, with no direction column** — the only
  signed money in the schema. E4 is then `cleared + difference = line.amount`, an equation
  rather than an equation with a conditional in it. `inbound`/`outbound` survives as a rule
  condition and a list filter, which is where a direction is genuinely a category.

Two things wave 0 decided against its own brief, both worth knowing before wave 1:

- **`bank_line_clearings` is mutable, not append-only.** The argument is `ar_allocations`':
  a clearing posts no journal, so un-matching restates no financial statement. Freezing
  clearings inside a _finalised_ session is a rule about another row's column value that no
  grant can express, and belongs to OB-082.
- **QFX is not a third format.** `format` is `ENUM('csv','ofx')`. QFX is OFX with
  proprietary tags and one parser; a second token would be a second name for one thing.
  OB-077's title still says "OFX/QFX" and means this.

#### Carried into wave 4

The server side is done, so what wave 4 (transport + screens) inherits is small and known:

- **The permission-matrix `OPERATIONS` rows for banking carry `operationId: null`.** Every
  banking service is enforced and represented, but by a service call rather than a route,
  the way `getPeriod` has been since M2. OB-084 gives them routes and OB-089 fills the ids
  in; until then the coverage check ignores them and the source scan carries the guarantee.
- **Truncating an account's first reconciliation past its history is an M7 onboarding
  concern**, not a wave-4 one — there is no `start_date` column and the opening balance a
  truncated first session needs is not something the ledger can supply. The contract comment
  was corrected to stop promising it.

All of wave 3's own open questions were settled before it started: [D-50](#d-50) and
[D-51](#d-51) above. Earlier waves closed `bank_statement_imports.status` (OB-078) and
`bank_match_proposals` rank-not-score ([D-48](#d-48), OB-079).
E5 says "book balance = statement balance at the date"; read literally, an uncleared item —
a written cheque not yet presented — would block finalisation, which is wrong for a bank
reconciliation. The contracts model `clearedBalance` alongside `bookBalance` with
`unclearedAmount` as the difference, so both readings stay visible and OB-082 settles which
one refuses.

---

## Milestone 5 — Platform surface

**Status: BUILT.** All 13 tickets (OB-096…108) shipped and `yarn check`-green (2,392 tests); see
the [Where things stand](#where-things-stand) summary for the wave structure, the human decisions
taken (D-53/57/61), the three integration bugs the gate caught, and the two owed follow-ups (the
OB-098 pre-prod security review, and change-feed emission on base `postJournal`). The scope below
is the as-built record.

The milestone the API was built to be a product for. M1–M4 made OpenBooks a bookkeeping system
usable in the browser; M5 makes it a platform a third party integrates with and an agent keeps
books through — over the same service layer, gated by the same permissions, without opening a
side door around any invariant M1 spent itself locking in. README says it plainly: the frontend
has no privileged path, third parties integrate as OAuth clients with scoped revocable access,
and there is a change feed and an event bus for integrators who follow activity rather than poll
it. This is where five contracts shipped since M1 — `EventBus`, `McpToolDefinition`,
`RouteDefinition`'s transport-agnosticism, the `PermissionKey` catalog, the identity seam — get
their first real consumers, which is [D-07](#d-07) applied to the platform rather than to a
provider.

Acceptance criteria are lettered **F**: `A`–`C` are M1–M3, M4 took `E` to keep clear of the
`D-nn` decision register, and `F` is the next free letter.

### Definition of done

A third-party application registers as an OAuth client, a user authorizes it against a chosen
subset of their own permissions, and the client reads and writes over `/v1` with a token that can
never exceed the granting user. An operator issues a server-to-server API key bound to a role. An
agent, connected over MCP with a model the user already pays for, proposes an entry that a human
approves — the agent never posts to the ledger on its own. An integrator follows a resumable,
tenant-scoped change feed of what happened and correlates its own record ids to OpenBooks entities
through `external_refs`, idempotently. Every write still carries actor provenance onto the journal
(spec §6), every read is still a 404-not-403 across orgs, and no new transport reaches a tenant
table except through `tenantDb`.

| #   | Acceptance criterion                                                                           | Verified by    |
| --- | ---------------------------------------------------------------------------------------------- | -------------- |
| F1  | Authorization-code + PKCE issues a token scoped to a subset of the granting user's permissions | OB-098, OB-106 |
| F2  | **A token can never exceed its granting user** — narrowing the user's role narrows the token   | OB-098, OB-106 |
| F3  | Every OAuth/API-key write carries actor provenance onto the journal it causes (spec §6)        | OB-099, OB-106 |
| F4  | Revoking a token or key takes effect on the next request, and the revocation is logged         | OB-099, OB-106 |
| F5  | One permission catalog governs REST, MCP, and OAuth — a scope naming no permission is refused  | OB-098, OB-103 |
| F6  | **An agent proposes; a human posts.** A propose-only tool lands a draft, never a ledger write  | OB-103, OB-106 |
| F7  | The event bus emits exactly the committed changes — none for a rolled-back transaction         | OB-100, OB-107 |
| F8  | Per-org event ordering is total, and the change feed replays every event once from any cursor  | OB-101, OB-107 |
| F9  | `external_refs` makes create idempotent by external identity, and correlates both directions   | OB-102, OB-107 |
| F10 | Cross-org holds for every new resource — 404, byte-identical                                   | OB-106         |
| F11 | No platform transport bypasses `requirePermission` or `tenantDb` — enforced, not reviewed      | OB-106         |

### Explicitly out of M5

- **OpenID Connect / "log in with OpenBooks".** The authorization server authorizes API access; it
  is not an SSO identity provider, and being one is a different security surface. See
  [D-53](#d-53).
- **Public dynamic client registration** (RFC 7591). A client is registered by an org admin under
  `integrations.write`; self-service registration is an anti-abuse surface of its own. [D-53](#d-53).
- **Push delivery — webhooks and SSE.** The change feed is a resumable pull with a durable cursor;
  push is a later delivery option layered on the same log, and settles the SSE-vs-polling open
  decision as _pull, for now_. See [D-57](#d-57).
- **The workflow engine and automations that subscribe to events** — M6. M5 ships the bus and the
  first events; the first orchestrating consumer is M6's, not M5's. [D-44](#d-44).
- **QuickBooks import.** `external_refs` and the change feed ship as the seam an importer uses; the
  importer that drives them in bulk is M7. [D-33](#d-33).
- **A dynamic module loader.** M5 implements `EventBus` and the MCP host against the `plugin-api`
  types, but keeps the manual wiring the server uses today; `ModuleDefinition` auto-registration is
  not required to ship the surface and would be tuned against a handful of modules. [D-07](#d-07).
- **Multi-currency (spec §13), still**, and no `plugin-api` 1.0 — M5 is the milestone that finally
  stresses `events`/`mcp`/`registry` with real consumers (M1 known gap 4), which is the input 1.0
  needs, not the moment to freeze it.

---

### Ticket board

13 tickets across 5 waves, numbered on from M4. Sizes as before: **S** ≈ one focused change,
**M** ≈ a coherent subsystem, **L** ≈ non-trivial design or test surface.

#### Wave 0 — Schema and contracts (2 parallel)

| ID         | Title                      | Size | Depends on |
| ---------- | -------------------------- | ---- | ---------- |
| **OB-096** | Platform schema and grants | L    | M4         |
| **OB-097** | Platform wire contracts    | M    | M4         |

**OB-096** — The M5 tables and the grant split they force. New: `oauth_clients`, `oauth_grants`
(authorization codes, short-lived, single-use), `oauth_tokens` (access and refresh, stored as a
`key_prefix` + SHA-256 hash exactly like `sessions` and `api_keys`, with `revoked_at` and
`last_used_at`), `oauth_consents` (which scopes a user granted a client); `external_refs`; an
append-only `event_log` (the outbox — the same record the change feed replays, [D-56](#d-56)) plus
its per-org position counter, taken `FOR UPDATE` the way `journal_sequences` is ([D-14](#d-14));
`change_feed_cursors` for a subscriber's position; and an append-only `security_events` for
issuance and revocation ([D-61](#d-61)). `api_keys` already exists from M1, unused — this is where
it stops being. The grant split is the load-bearing edit: token, consent, client, cursor and
`external_refs` tables are **mutable** and named in `MUTABLE_TABLES` (revocation, `last_used_at`,
cursor advance, ref re-point); `event_log` and `security_events` join `APPEND_ONLY_TABLES` beside
`reconciliation_session_events`. A table in neither list is a forgotten oversight by construction,
and `0999_app_grants` still has to sort last (see [migrations/README.md](packages/server/src/db/migrations/README.md)).

**OB-097** — The wire contracts in `packages/shared-types`, with **no `.meta({ id })`** until
OB-104 gives them routes: OAuth's token, authorize, and client-registration shapes; API-key
management; the change-feed page and cursor; `external_refs`. OAuth's own endpoints are
form-encoded and status-coded by RFC 6749/9700, not the project's JSON error envelope — the one
place M5's transport is not shaped like the rest, called out here so OB-104 does not try to force
it into the typed envelope. Independent of the schema by construction: this is API shape, not
storage.

#### Wave 1 — Identity and the event backbone (3 parallel)

| ID         | Title                                  | Size | Depends on |
| ---------- | -------------------------------------- | ---- | ---------- |
| **OB-098** | OAuth authorization server             | L    | 096, 097   |
| **OB-099** | API-key authentication                 | M    | 096, 097   |
| **OB-100** | Event bus and the transactional outbox | L    | 096        |

**OB-098** — Authorize, token, and revocation endpoints; authorization-code with PKCE mandatory,
implicit and resource-owner-password refused ([D-53](#d-53)). The consent screen grants a subset of
the catalog, and the token's effective permissions are **recomputed every request** as the granted
scopes intersected with the user's current role in that org ([D-54](#d-54)) — the same re-derivation
`resolveSessionIdentity` already does for a session's org and role, which is why nothing below the
auth service returns a baked-in role. This is the **second identity resolver** on the seam
`api.ts` wires as `resolveIdentity`; it produces a `ResolvedIdentity` with an agent/automation
`actorType`, so provenance lands on the journal for free (F3).

**OB-099** — Issue, list, and revoke API keys — the M1 table finally used. A key is bound to its
**own role**, not the issuer's (the column has said so since `0001`), authenticates as an org+role
with no user, and is the **third resolver** on the same seam. Opaque `key_prefix` + hash, instant
`revoked_at` ([D-61](#d-61)). The API-key/OAuth boundary is [D-55](#d-55): a key is first-party and
represents no person; a token is third-party and always represents one.

**OB-100** — The first real `EventBus` (D-07's fourth application, after email at M2 and the queue
at M4). The state change and its `event_log` row are written in the **same tenant transaction**, so
an event exists if and only if the change committed — no phantom event for a rolled-back posting,
which is F7 and is exactly what the `events.ts` header means by "an event announcing a journal that
was rolled back is worse than a late event". A relay in the `worker` assigns the host-side
`eventId`, `occurredAt`, and per-org position, and delivers at-least-once to idempotent subscribers
([D-56](#d-56)). M5 adds the additive `.v1` events the subledger and banking should always have
emitted — `invoice.approved.v1`, `bill.approved.v1`, `payment.recorded.v1`, `credit-note.*`,
`reconciliation.finalised.v1` — each a new member of `OpenBooksEvent`, never an edit to an existing
payload.

#### Wave 2 — Integrator surfaces (3 parallel)

| ID         | Title                         | Size | Depends on   |
| ---------- | ----------------------------- | ---- | ------------ |
| **OB-101** | Change feed                   | M    | 100          |
| **OB-102** | `external_refs` service       | M    | 096          |
| **OB-103** | MCP server and the tool suite | L    | 098, 099, M3 |

**OB-101** — A resumable, tenant-scoped feed that is a **projection of the event log, not a second
store** ([D-57](#d-57)): a keyset read over the append-only log keyed on the per-org position
([D-21](#d-21)), where the consumer holds the cursor, so replay is re-reading from a position. No
denormalized second copy that could disagree with the log — the same rule [D-34](#d-34) and
[D-46](#d-46) apply to balances. Gated `integrations.read`. Retention bounds how far back a
consumer can resync ([D-57](#d-57), and the spec §14 open decision) — **the number is the human's
to set.**

**OB-102** — `external_refs`: an integrator's own id mapped to an OpenBooks entity, unique both
ways, so a create carrying a known ref returns the existing entity rather than duplicating
([D-58](#d-58)). This is [D-04](#d-04)'s idempotency generalized from a one-shot request key to a
durable external identity, and it is the seam [D-33](#d-33) named for the M7 QuickBooks import — it
ships now, its bulk consumer arrives then.

**OB-103** — The MCP server, mounted **in-process on the `api` role** over streamable HTTP behind
the same ALB — not a fourth process ([D-59](#d-59), preserving one-image-three-roles). Tools are a
second transport over the existing services, each carrying the same `PermissionKey` its REST route
does, enforced by the same `requirePermission` (F5). A tool that would post to the ledger is
`supportsProposeOnly` and lands a **draft** — M2's `journal_drafts`, M3's document lifecycle — that
a human with `agents.review` approves ([D-60](#d-60)); the agent never holds an auto-posting path.
This is [D-43](#d-43)'s "matching proposes, a human posts" generalized to every agent write, and
what finally activates the `agents.review` code seeded since M1.

#### Wave 3 — Transport and screens (2)

| ID         | Title                                      | Size | Depends on |
| ---------- | ------------------------------------------ | ---- | ---------- |
| **OB-104** | `/v1` surface and the OAuth endpoints      | M    | 098–103    |
| **OB-105** | Developer and integration settings screens | L    | 104        |

**OB-104** — The management routes (clients, connected apps, API keys, change feed) plus OAuth's own
authorize/token/revoke endpoints wired in. The management surface gets its `.meta({ id })` and
`openapi.json` drift stays a build failure (A10); OAuth's endpoints stay outside the typed envelope,
by RFC, as OB-097 flagged. Handlers map arguments and hold no logic, unchanged.

**OB-105** — Screens for API keys, connected OAuth apps (including the consent screen the AS
redirects to), and the **agent-review queue** where a human turns an agent's proposals into
postings ([D-60](#d-60)) — the screen `agents.review` exists for. Permission-aware and advisory as
ever ([D-25](#d-25)); the services are the gate.

#### Wave 4 — Verification (3)

| ID         | Title                                        | Size | Depends on |
| ---------- | -------------------------------------------- | ---- | ---------- |
| **OB-106** | Platform enforcement and the security suite  | L    | 104        |
| **OB-107** | Event and change-feed property suite         | L    | 100–102    |
| **OB-108** | E2E: authorize → agent-propose → follow feed | M    | 105        |

**OB-106** — The milestone's guarantees as tests, not review items: a token's effective permissions
are the intersection with the user's live role and never exceed it (F1/F2); revocation is effective
on the next request and logged (F4); the MCP transport refuses exactly what the REST route refuses,
role for role (F5); every new resource holds the 404-byte-identical line (F10); and the
dependency-cruiser boundary that no transport reaches a tenant table or enforces authorization
itself extends to the new surfaces (F11). This is the A7/E9 cross-org matrix widened to OAuth,
API-key, and MCP callers.

**OB-107** — The property suite that spec §11's discipline points at the platform: after a generated
run of postings, the events emitted equal exactly the committed changes and none of the rolled-back
ones (F7); per-org ordering is total and the feed replays every event once from any cursor (F8); and
`external_refs` re-import collapses to one entity (F9), the E1-style idempotency property one layer
up. The outbox is the load-bearing piece and gets the mutation testing the ledger kernel got — an
event delivered before its transaction commits, or twice, is the failure the outbox exists to
prevent.

**OB-108** — One browser-and-client narrative, against the real stack ([D-26](#d-26)): register a
client, authorize it against a scope, have an agent propose an entry over MCP, approve it in the
review queue, then follow the change feed and correlate the resulting journal back through
`external_refs`. It is the only test that can prove the surfaces compose, and — as OB-090 was for
M4 — the one most likely to catch a seam defect no unit test sees.

**Critical path:** 096 → 098 → 103 → 104 → 105 → 108. OB-098 (the AS) and OB-100 (the outbox) are
the two most likely to expand — the AS for its security surface, the outbox for the exactly-committed
guarantee — the way OB-013 and OB-020 were in M1.

---

## Pay Bills & disbursements

An AP enhancement scoped out of session conversation, sitting outside the spec's phase order — so it
carries its own ticket range (OB-109…OB-119) and its own criteria letter **G** (F was M5; G is next
free). It makes paying bills a **first-class organizational function** rather than a side effect of
the Money screen: a batch **Pay Bills** window over bills already entered, a **pending-payment
queue** that posts no ledger effect until money actually moves, settlement-time discounts and credit
application, and a double-payment guard that lives where the duplicate cheque is actually cut.

Two facts in the existing model shape the whole thing. A payment carries one `contactId` and
allocations refuse to cross contacts (`assertSameContact`), so a batch fans out into **one payment
per vendor** — which is also one cheque per vendor; Pay Bills is an orchestrator over N payments,
not one payment ([D-63](#d-63)). And a Payment _is money that moved_ — `journalId` is never null,
no draft state (D-37/D-38) — so the queued-but-unpaid state cannot be a draft Payment. It is a
separate **pending payment** that posts no journal and materialises into a real Payment only when it
is issued ([D-64](#d-64), [D-65](#d-65)). That separation is not a workaround: it is what lets cash
stay put until the cheque is cut, and what puts a clean separation-of-duties seam between the clerk
who builds the queue and the controller who releases it.

### Definition of done

From the Purchases side a user selects bills already entered, applies available vendor credits and a
settlement discount coded to an account they choose, and queues the result. Nothing has touched the
ledger yet, and the bills those pending payments cover are no longer offered for payment a second
time. A treasury step routes the queue to a rail — cheque, ACH, or wire — and issues it: at that
moment, and not before, each vendor's payment posts one balanced journal (debit payables and the
discount account, credit the bank), the allocations are written, the bills reach `paid`, and the
rail's identifier (cheque number from the account's register, ACH trace, wire confirmation) lands on
the payment's `reference`. "I already sent this cheque" is the same path with queue and issue
collapsed into one gesture. `outstanding` and every financial statement stay posted-only and tie to
the control account throughout; the double-payment guard is a computed overlay, never a stored
balance.

| #   | Acceptance criterion                                                                                             | Verified by    |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| G1  | A pending payment posts no journal and has no ledger effect until issued                                         | OB-111, OB-117 |
| G2  | Issuing posts exactly one balanced journal per vendor and writes the allocations, **atomic per payment**         | OB-112, OB-118 |
| G3  | A settlement discount posts to the **user-selected** account and brings the bill to `paid`                       | OB-113, OB-118 |
| G4  | `available_to_pay = outstanding − committed`; a bill an open pending payment covers cannot be queued again       | OB-111, OB-117 |
| G5  | Cancelling or editing a pending payment frees the bill with **no ledger correction**                             | OB-111, OB-117 |
| G6  | A pending payment routes to a rail; its identifier lands on the payment; the cheque register is per bank account | OB-114, OB-118 |
| G7  | Queue-building needs no `journals.post`; **issuing does** — the separation-of-duties split                       | OB-112, OB-117 |
| G8  | `outstanding` and every statement stay posted-only and tie to control; `committed` never enters a report         | OB-111, OB-117 |

### Explicitly out

- **The reporting-snapshot layer for scale.** Per-document settlement — including `committed` —
  scales; whole-history statement aggregates (`selectAccountBalances`, aging's unbounded outer scan)
  do not. A close-driven period snapshot that memoises an _immutable_ prefix is the fix, and
  append-only makes it uniquely safe ([D-69](#d-69)). It is orthogonal to Pay Bills correctness —
  gating "millions", not this feature — so it is its own ticket, **OB-119**, not part of this DoD.
- **Vendor bank-credential entry.** ACH and wires need the vendor's routing/account or wire
  instructions on the contact — new, _sensitive_ data. The schema ships (OB-109); populating real
  numbers is the user's, never seeded.
- **Cheque-printing polish, positive pay, and ACH return handling beyond void.** The first cut prints
  a cheque with a stub and assigns a number; the treasury-grade tail is a fast-follow. An ACH return
  after issue is a void (reversing journal), the same answer D-38 gives everywhere.

### Ticket board

11 tickets across 4 waves, numbered on from M5. Sizes as before.

#### Wave 0 — Schema and contracts (2 parallel)

| ID         | Title                             | Size | Depends on |
| ---------- | --------------------------------- | ---- | ---------- |
| **OB-109** | Pending-payment schema and grants | L    | —          |
| **OB-110** | Pay Bills wire contracts          | M    | —          |

**OB-109** — `pending_payments` (one per vendor: bank account, rail, status, memo) and
`pending_payment_intents` (the bill lines it will settle — each `{ bill_id, amount }` — plus the
per-line settlement discount `{ amount, account_id }` and the vendor credits it will apply). Vendor
disbursement details on `contacts` (a mailing address is there; ACH/wire add routing/account or wire
instructions — sensitive, D-67). A per-bank-account cheque-number register. All of it **mutable** and
named in `MUTABLE_TABLES`: a pending payment is pencil, edited and cancelled up to issue, and nothing
here is a ledger fact, so nothing here is append-only. `0999_app_grants` still sorts last.

**OB-110** — The contracts in `packages/shared-types`: the pending payment, the batch `payBills`
request, rail routing, the settlement-discount line, and `committed` / `available_to_pay` added to
the AP settlement read beside `outstanding` (all three computed on read, none stored — D-34, D-68).
No `.meta({ id })` until OB-115 gives them routes.

#### Wave 1 — Services (4; 113 and 114 parallel to the 111→112 spine)

| ID         | Title                                       | Size | Depends on  |
| ---------- | ------------------------------------------- | ---- | ----------- |
| **OB-111** | Pending-payment queue service               | L    | 109, 110    |
| **OB-112** | Issue service                               | L    | 111, OB-093 |
| **OB-113** | Settlement-discount primitive               | M    | 110         |
| **OB-114** | Rail adapters + vendor disbursement details | L    | 111         |

**OB-111** — Build, edit, and cancel a pending-payment queue; posts no journal. Computes
`committed = Σ open pending intents targeting a bill` and `available_to_pay = outstanding − committed`,
and refuses queueing beyond it — under the same `FOR UPDATE` lock on the bill the allocation code
already takes, so two concurrent builds cannot each spend the same remainder ([D-68](#d-68)).
Cancelling frees the bill with nothing to unwind: the allocation-delete symmetry, one layer up.

**OB-112** — Materialise one pending payment into a real `Payment` per vendor: post the journal
(payables + discount-account debit, bank credit), write the allocations under the over-allocation
lock (C3 the backstop), flip the covered bills to `paid`, and stamp the rail identifier onto
`reference`. **Atomic per payment, not per run** — one vendor's bad ACH detail must not roll back the
cheques. Issue is the step that requires `journals.post`; queue-building does not — the seam that
gives OB-093 its cleaner answer ([D-65](#d-65)).

**OB-113** — The settlement-discount journal line: debit payables, credit an account the **user
selects**, defaulted from an org setting and overridable per line ([D-66](#d-66)). Brings the bill to
`paid` honestly, rather than through a synthetic vendor credit that litters the vendor's ledger.

**OB-114** — Rail adapters over the shared issue core ([D-67](#d-67)): cheque (draw the next number
from the account register, render a printable cheque + stub), ACH (emit into a NACHA batch, capture
the trace), wire (capture the confirmation). Rail defaulted at creation from the vendor's preferred
method, changeable in the queue. Vendor bank-detail entry is the user's; the schema ships, the data
does not.

#### Wave 2 — Transport and screens (2)

| ID         | Title                                        | Size | Depends on |
| ---------- | -------------------------------------------- | ---- | ---------- |
| **OB-115** | `/v1` surface for pending payments/pay-bills | M    | 111–114    |
| **OB-116** | Pay Bills window and the disbursements queue | L    | 115        |

**OB-115** — Routes: build/edit/cancel pending payments, the batch `payBills`, route-to-rail, issue,
and the cheque print run. Handlers map arguments and hold no logic, unchanged.

**OB-116** — The **Pay Bills** window (select bills by due date and vendor, apply credits and
discounts, see _owed / in-flight / available_) and the **disbursements** screen (the pending queue,
rail routing, issue, cheque print run). Permission-aware and advisory ([D-25](#d-25)); the services
are the gate.

#### Wave 3 — Verification (2)

| ID         | Title                                              | Size | Depends on |
| ---------- | -------------------------------------------------- | ---- | ---------- |
| **OB-117** | Enforcement matrix + double-payment property suite | L    | 115        |
| **OB-118** | E2E: enter → queue → route → issue → reconcile     | M    | 116        |

**OB-117** — The queue-vs-issue permission split across the matrix (queue needs no `journals.post`,
issue does); and a **contention** property for D-68 — two builders racing the same bill, one parked
mid-transaction, proving the second cannot queue the covered amount. Prove contention, don't simulate
it — the habit the ledger kernel earned.

**OB-118** — One narrative against the real stack ([D-26](#d-26)): enter bills, build a Pay Bills
queue carrying a discount and a vendor credit, route part to cheque and part to ACH, issue, then
follow the journals to the ledger and match one against a bank line — the seam test most likely to
catch what no unit sees, as OB-090 was for M4.

**Critical path:** 109 → 111 → 112 → 116 → 118. **OB-093 gates OB-112** (issue needs the
`journals.post` / `reverse` split resolved, and the queue/issue design is what gives that gap its
answer — `ap_only` owns the queue, an issuer role holds post). **OB-119** (reporting snapshots,
[D-69](#d-69)) gates _scale_, independently, and is tracked as an outstanding ticket, not on this
path.

### PB execution — dev-ready, parallelised

The prose above is criteria + tickets; this is the seam-pinned build plan (the M5/PAY/CA "decide before
you fan out" discipline). PB is **greenfield** (no `pending_payments`/`disbursement` code exists) and
**reuse-heavy** — `recordPayment`, the allocation `FOR UPDATE` lock + C3 guard + `assertSameContact`,
the `document_sequences` gapless-counter pattern, and CA's already-AP-capable discount primitive all
carry it. **Four forks settled up front** ([D-109](#d-109)…[D-112](#d-112)): dedicated queue/issue
permission keys for a real separation of duties; **rails are classification tags, not adapters** (no
NACHA, no wire logic); **cheque is the only internal rail**, behind a swappable output seam; and the
settlement discount **reuses CA's primitive** and finishes the deferred AP-side suggestion. The
load-bearing model is [D-64](#d-64): the queued state is a **separate mutable entity that posts no
journal**, materialising into a real `Payment` per vendor only at issue.

#### Seams that already exist — reuse verbatim

| Need                                     | Reuse (symbol @ path)                                                                                                                                                                                                                 | How PB uses it                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Materialise one vendor's payment (issue) | `recordPayment` @ `modules/payments/payments.service.ts:132` (`direction:'made'`, `allocations:[{targetType:'bill', …}]`)                                                                                                             | Posts debit-payables/credit-bank + writes allocations in one txn; the rail id lands on `reference`. Enforces `payments_made.write`+`journals.post`.                                                    |
| Double-payment guard + same-vendor       | `applyAllocations` @ `modules/payments/allocate.ts:96`; the bill `FOR UPDATE` via `selectDocumentByIdForUpdate` @ `allocations.repository.ts:104`; C3 `overAllocated`; `assertSameContact` @ `allocate.ts:302`                        | `committed = Σ open pending intents on a bill` computed under the **same** bill lock; C3 is the issue-time backstop (D-68); `assertSameContact` is why a batch fans out one payment per vendor (D-63). |
| Cheque-number register                   | `allocateSequenceNumber` + `document_sequences` @ `modules/payments/payments.repository.ts:163` (`FOR UPDATE`, gapless)                                                                                                               | Copy the pattern into a new counter table keyed `(org_id, bank_account_id)` — journals can't be locked, so the counter is its own table (D-14).                                                        |
| Settlement discount (reuse, D-112)       | `resolveDiscountAccount(db,'received')` @ `modules/settings/discount-accounts.ts:138`; the `discount` posting shape @ `clearing.service.ts` (debit payables control / credit discount account + `applyAllocations` kind `'discount'`) | Extract a shared `postSettlementDiscount(side,…)` both bank-clearing and PB issue call; the `discount_journal_id` XOR source already exists on `ap_allocations`.                                       |
| AP discount suggestion (finish D-108)    | `suggestDiscount(ctx,{targetType:'bill',…})` @ `modules/payment-terms/suggestion.service.ts` (already AP-capable)                                                                                                                     | The Pay Bills window surfaces it for bills — no new service, just the surface.                                                                                                                         |
| Bill `outstanding` / `paid`              | `settlementOf`/`statusOf` @ `modules/bills/ap-documents.service.ts:416,394` (both derived, no stored flag)                                                                                                                            | `available_to_pay = outstanding − committed`; a bill reaches `paid` when allocations (payment + discount) sum to gross — no status write.                                                              |
| ACH-return-after-issue                   | `voidPayment` @ `modules/payments/payments.service.ts:382` (reversing journal, clears allocations)                                                                                                                                    | An ACH return is a void — the same answer D-38 gives everywhere.                                                                                                                                       |
| Cheque PDF + artifact                    | `createInvoiceRenderer` @ `modules/delivery/renderer/index.ts:117` → bytes; `storageProvider().put`/`signedUrl` (see `send-invoice.service.ts:109`)                                                                                   | The `ChequeOutput` default renders a cheque+stub and stores it, exactly the invoice-PDF path.                                                                                                          |

#### Schema — migration `0013_pay_bills` (next free prefix)

New tenant tables, all **mutable** (pencil until issue — nothing here is a ledger fact, D-64):

- **`pending_payments`** (one per vendor per batch): `id`, `org_id`, `contact_id` (the vendor, FK
  contacts RESTRICT), `bank_account_id`, `rail ENUM('cheque','ach','wire')`, `status ENUM('open','issued','cancelled')`,
  `issued_payment_id BINARY(16) NULL` (set on issue → the real `Payment`), `memo`, author, timestamps.
- **`pending_payment_intents`** (the bill lines it settles): `id`, `org_id`, `pending_payment_id` (FK,
  CASCADE), `bill_id` (FK ap_documents RESTRICT), `pay_amount_minor BIGINT`, `discount_amount_minor BIGINT NULL`,
  `discount_account_id BINARY(16) NULL`, `applied_vendor_credit_id BINARY(16) NULL` (a vendor credit it
  applies, FK ap_documents). `committed` on a bill = `Σ pay_amount_minor` over intents whose pending
  payment is `open`.
- **`cheque_number_sequences`** (the register): `PRIMARY KEY (org_id, bank_account_id)`, `next_value BIGINT UNSIGNED NOT NULL DEFAULT 1` — the `document_sequences` twin.
- **In-place adds** ([D-15](#d-15)): `contacts.ach_routing_number` / `ach_account_number` / `wire_instructions VARCHAR NULL` (`0002_ledger`) — **sensitive, never seeded**; flag them for log-redaction and a possible encryption-at-rest follow-up (they are account numbers, not API-key secrets, so plain nullable columns in v1, redacted). No new column on `payments` — the rail id reuses `reference` (D-110/D-67).
- Registries: `TENANT_TABLES` + `MUTABLE_TABLES` (all three) + `grants.test` rows; codegen `generated.ts` (a throwaway-MySQL run — no money override needed beyond the standard BIGINT rule).
- **Permissions ([D-109](#d-109))**: add `pending_payments.read`, `pending_payments.write`, `disbursements.issue` → bump `AssertCatalogSize<53>`→`<56>`; seed in `0001_tenancy` (queue keys to `ap_only`+owner+bookkeeper; `disbursements.issue` to **owner only**); update the permission-matrix/catalog/grants tripwires.

#### Contract-first seams (pin before fan-out)

- **`ChequeOutput`** (new interface): `emit(cheque): Promise<{ artifactKey?: string }>` — default `pdf`
  implementation renders + stores; a `handoff` implementation no-ops and relies on the query API
  ([D-111](#d-111)). (A config selector is optional — `pdf` is the real default; do NOT add the PAY-style
  fake/provider machinery, [D-110](#d-110).)
- **Wire contracts** (`shared-types`): `pendingPaymentSchema` + intents; the batch `payBillsRequestSchema`
  (`{ contactId → bills[] }` fanned out server-side, D-63); `railSchema`; `committed`/`available_to_pay`
  added to the AP settlement read beside `outstanding` (all computed, none stored — D-34/D-68); a
  list-by-rail query shape (for external handoff).
- **The issue is atomic per payment, not per run** (G2/D-63): the `payBills`/issue service loops vendors,
  each in its **own transaction** — one vendor's failure leaves the others issued and it stays `open`/flagged.

#### Waves (OB-109…118; **OB-119 is explicitly out** — reporting snapshots for scale, D-69)

| Wave                                               | Tickets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Deliverable                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **0 — Schema + contracts** (parallel)              | **OB-109** `0013` schema + contacts columns + cheque register + the 3 permission keys + registries · **OB-110** wire contracts                                                                                                                                                                                                                                                                                                                                                                                                          | Orchestrator owns codegen + the 0002 in-place edit + role reseed.                   |
| **1 — Services** (111→112 spine; 113,114 parallel) | **OB-111** pending-payment queue (build/edit/cancel; `committed`/`available_to_pay` under the bill `FOR UPDATE`; **gated `pending_payments.write`, NOT `journals.post`**) · **OB-112** issue (materialise per vendor via `recordPayment` + `postSettlementDiscount` + cheque number; atomic per payment; **gated `disbursements.issue`**) · **OB-113** the shared `postSettlementDiscount` helper (reuse CA, D-112) · **OB-114** the rail tag + `ChequeOutput` seam + cheque register + list-by-rail read + vendor disbursement columns | OB-112 is the expansion risk (the per-vendor atomicity + the discount/credit legs). |
| **2 — Transport + screens**                        | **OB-115** `/v1` routes (build/edit/cancel, batch `payBills`, route-to-rail, issue, cheque output, list-by-rail) · **OB-116** the Pay Bills window (owed / in-flight / available, apply credits + the AP discount suggestion) + the disbursements queue screen                                                                                                                                                                                                                                                                          | New keys → permission-matrix moves this time.                                       |
| **3 — Verification**                               | **OB-117** enforcement matrix (queue vs issue: `ap_only` queues but **cannot** issue) + the D-68 double-payment **contention** property (two builders racing one bill, one parked mid-txn) + mutation testing · **OB-118** E2E: enter bills → queue with a discount + a vendor credit → route part cheque part ACH → issue → follow journals → match a cheque against a bank line                                                                                                                                                       |                                                                                     |

**Critical path:** OB-109 → OB-111 → OB-112 → OB-116 → OB-118. OB-093 (done) already resolved the
`journals.post` prerequisite; the new `disbursements.issue` key is what makes the queue/issue split real.

#### Tripwire / registry checklist

`db/tenant-tables.ts` (+3) · `0999_app_grants.ts` `MUTABLE_TABLES` (+3) + `grants.test.ts` · `catalog.ts`
`PERMISSION_KEYS` (+3) with `AssertCatalogSize<53>`→`<56>` + `0001_tenancy` seed (incl. the role split) +
`catalog.test.ts` · **`permission-matrix.test.ts`** — this milestone genuinely moves it (new keys →
`GRANTED_TO`, new OPERATIONS rows, the queue-vs-issue split is the headline assertion) · route-table +
openapi (+ regenerate `openapi.json`/web client) + cross-org A7/B11 · `generated.ts` via throwaway codegen.

#### Deliberate scope edges (flagged)

- **No NACHA, no wire execution** ([D-110](#d-110)) — ACH/wire are tags; an external integration moves
  the money and writes back the trace/confirmation to `reference`.
- **Cheque printing behind `ChequeOutput`** ([D-111](#d-111)) — default renders a PDF; positive pay and
  cheque-printing polish stay fast-follows (the scope's "Explicitly out").
- **Vendor bank details are schema-only** — the columns ship redacted; real routing/account numbers are
  the user's to enter, never seeded (D-67).
- **OB-119 (reporting snapshots, D-69) is out** — it gates scale independently, not PB correctness.

---

## Invoicing — delivery, recurring & dunning

The AR counterpart to Pay Bills: where that made _disbursement_ a product, this makes the invoice's
**customer-facing lifecycle** one. Today an invoice is a purely internal ledger record — no way to
deliver it, no way to chase it, no way to issue it on a schedule. This initiative adds all three: a
**themed PDF emailed to the customer**, an **org branding record** that brands the PDF and the email
(and, later, the portal and statements), a **full dunning policy** that escalates overdue invoices
automatically, and **recurring invoice templates** that post on a schedule. Criteria letter **H**
(G was Pay Bills); tickets OB-120…OB-133.

Two shared foundations are net-new, both first-consumer moments under [D-07](#d-07): the
**StorageProvider has no adapter yet**, so invoicing — its logo and retained PDFs the first use —
builds the `local` + `s3` adapters; and the worker has **no scheduler** (it blocks on the queue and
runs only what is enqueued), so a time-driven runner is built here for reminders and recurring alike.
The **EmailProvider** already sends HTML, so nothing there changes: v1 delivery is a themed email that
**links a hosted, token-gated invoice page** with a downloadable PDF ([D-74](#d-74)) — no attachment,
and that hosted page is the very seam the future pay-link reuses. The **inbound payment slice —
Stripe/Square "pay this invoice online" — is parked**
as its own future initiative ([D-78](#d-78)); this one delivers, reminds, and recurs, but does not
itself accept a payment.

### Definition of done

An org sets its branding once — identity block, logo, a brand colour, a footer. A user opens an
approved invoice and sends it: the server renders a themed PDF, retains it, and emails the customer a
themed link to a hosted, token-gated page where they view the invoice and download the PDF; a
delivery record captures what was sent and when, and a later branding change does not alter that
retained artifact. Overdue invoices are walked through an
org-defined dunning policy — escalating stages, each sent at most once, suppressed the moment the
invoice is paid or voided. A recurring template issues an invoice every cycle on the new scheduler;
by default it approves and posts the journal unattended, carrying **system-actor provenance** onto
that journal (spec §6), or lands a draft when the template is set to draft. `outstanding`, the ledger
and every statement are untouched by any of it except the recurring post, which goes through the same
`approveInvoice` path a human uses.

| #   | Acceptance criterion                                                                                                                | Verified by    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| H1  | An approved invoice renders to a **themed** PDF via the server-side library; a draft cannot be sent                                 | OB-125, OB-126 |
| H2  | The org branding record (identity, logo, brand colour, footer) brands **both** the invoice PDF and the email                        | OB-124, OB-126 |
| H3  | Sending records an `invoice_delivery` + a retained PDF artifact that does **not** change on a later theme edit                      | OB-126, OB-133 |
| H4  | The StorageProvider `local` and `s3` adapters round-trip (`put`/`get`/`signedUrl`) — invoicing the first consumer                   | OB-120         |
| H5  | The email links a **hosted, token-gated invoice page** with a downloadable PDF — no attachment                                      | OB-121, OB-126 |
| H6  | The worker runs a **time-driven scheduler** that enqueues due work on a daily tick                                                  | OB-127         |
| H7  | A recurring template materialises an invoice each cycle: auto-approve by default (posts journal + number), draft on request         | OB-128, OB-133 |
| H8  | A dunning policy escalates each open invoice through its stages until paid; **each stage sends at most once**; paid/void suppresses | OB-129, OB-132 |
| H9  | Every automated ledger write (auto-approved recurring) carries actor provenance (spec §6); send/schedule are permission-gated       | OB-128, OB-132 |

### Explicitly out

- **Stripe/Square inbound payment** ([D-78](#d-78)) — a separate initiative; the pay-link is the
  documented seam this one leaves for it.
- **A full customer portal** (login, an account, a list of their invoices, self-service pay) —
  deferred. v1 ships only a **single hosted invoice page** reached by a capability link
  ([D-74](#d-74)); the logged-in portal and online payment belong with the Stripe/Square slice
  ([D-78](#d-78)).
- **Multi-brand** (several trading names under one org) — one branding record per org for v1
  ([D-70](#d-70)).
- **Durable / multi-instance scheduling** — v1 is a single-worker in-process tick; durable scheduling
  waits on the still-unimplemented `sqs` adapter ([D-49](#d-49), [D-75](#d-75)).
- **Statements and other themed documents** — the branding record is built to serve them later, but
  they are not in this scope.

### Ticket board

14 tickets across 5 waves, numbered on from Pay Bills.

#### Wave 0 — Foundations, schema and contracts (4 parallel)

| ID         | Title                                        | Size | Depends on |
| ---------- | -------------------------------------------- | ---- | ---------- |
| **OB-120** | StorageProvider adapters (`local` + `s3`)    | M    | —          |
| **OB-121** | Hosted invoice page + public capability link | M    | —          |
| **OB-122** | Invoicing schema and grants                  | L    | —          |
| **OB-123** | Invoicing wire contracts                     | M    | —          |

**OB-120** — The first `StorageProvider` consumer builds it ([D-07](#d-07), [D-73](#d-73)): the
`local` and `s3` adapters behind the existing `packages/plugin-api` interface, plus a
`storageProvider()` accessor beside `queueProvider()`/`outboundEmail()`. Keys are org-scoped
(`{orgId}/branding/logo`, `{orgId}/invoices/{id}/{deliveryId}.pdf`). The logo and every retained
invoice PDF live here.

**OB-121** — The **hosted invoice page**: a public, token-gated view of one invoice with a **Download
PDF** action ([D-74](#d-74)). A high-entropy capability token per delivery is the whole authorization
— the one sanctioned unauthenticated read path, read-only, no session — and the PDF is served gated
by that same token (streamed by the api, or a short-lived `signedUrl`). No EmailProvider change: the
existing HTML email carries the link, and this page is the seam the Stripe/Square pay-link
([D-78](#d-78)) later reuses.

**OB-122** — The tables and grants: **org branding** (identity, logo storage key, brand colour,
footer — columns on `org_accounting_settings` or a sibling `org_branding`, lazy-row like the control
accounts); **`invoice_deliveries`** (invoice, recipient, sent-at, artifact key, provider message id,
status); **`recurring_invoice_templates`** (customer + line template + tax mode + terms + schedule +
`draft|approved` mode); **`dunning_policies`** + **`dunning_stages`** (ordered offset + template +
optional late fee); and an append-only **`dunning_sends`** log (the once-per-stage guard). Branding,
templates and policies are **mutable**; deliveries and dunning-sends are **append-only** and join
`APPEND_ONLY_TABLES`. `0999_app_grants` still sorts last.

**OB-123** — The wire contracts: branding, the send request, the recurring template, the dunning
policy. No `.meta({ id })` until OB-130.

#### Wave 1 — Rendering and delivery (3)

| ID         | Title                                    | Size | Depends on    |
| ---------- | ---------------------------------------- | ---- | ------------- |
| **OB-124** | Org branding service + logo upload       | M    | 120, 122, 123 |
| **OB-125** | Invoice PDF renderer (server-side lib)   | L    | 120, 122      |
| **OB-126** | Invoice send — themed email + attachment | M    | 121, 124, 125 |

**OB-124** — Read/write the branding record and upload the logo through the storage adapter. Colours
and text are **stored data** the renderer consumes, not app design tokens — no `no-raw-color`
conflict ([D-70](#d-70)).

**OB-125** — The invoice PDF, rendered by a **server-side library** (deterministic, dependency-light —
not headless Chromium, [D-71](#d-71)), taking the branding as typed inputs and the money as the
already-string-formatted wire values (no float). Emits the artifact to storage.

**OB-126** — `sendInvoice` (permission `invoices.send`): render and retain the artifact, mint the
delivery's capability token, email the customer a themed link to the hosted page (OB-121), and write
the `invoice_delivery`. Only an **approved** invoice is sendable; "sent" is a delivery fact, never a
ledger status ([D-72](#d-72)).

#### Wave 2 — Scheduler and automation (3)

| ID         | Title                              | Size | Depends on   |
| ---------- | ---------------------------------- | ---- | ------------ |
| **OB-127** | Scheduler — time-driven job runner | L    | —            |
| **OB-128** | Recurring invoice templates        | L    | 127, 122, M3 |
| **OB-129** | Dunning policy engine              | L    | 126, 127     |

**OB-127** — The net-new capability ([D-75](#d-75)): a single-worker in-process tick alongside
`blockUntilShutdown` that, each day, enqueues due work onto the existing `QueueProvider`. Non-durable
across restart in v1 (acceptable single-instance); a durable multi-instance scheduler waits on the
unimplemented `sqs` adapter ([D-49](#d-49)).

**OB-128** — Each cycle materialises an invoice from the template. **Auto-approve by default** — posts
the journal and takes the number through the same `approveInvoice` path a human uses, unattended, via
a **system/automation actor** so provenance still lands on the journal ([D-76](#d-76)) — or lands a
draft when the template's mode is `draft`. Cycle materialisation is idempotent (one invoice per
period).

**OB-129** — The dunning engine ([D-77](#d-77)): the scheduler feeds each overdue invoice through its
org's policy stages; each stage sends **at most once** (the `dunning_sends` guard) and reuses the
OB-126 send path; paid/void/dispute suppresses the sequence; an optional late fee posts as the
punitive twin of the settlement discount.

#### Wave 3 — Transport and screens (2)

| ID         | Title                                          | Size | Depends on |
| ---------- | ---------------------------------------------- | ---- | ---------- |
| **OB-130** | `/v1` surface for delivery, recurring, dunning | M    | 124–129    |
| **OB-131** | Screens                                        | L    | 130        |

**OB-130** — Routes: send/preview an invoice, branding settings, recurring templates, dunning policy.
Handlers map arguments and hold no logic.

**OB-131** — Screens: invoice preview + send, org branding settings, the recurring-template editor
(with the draft|approved toggle), and the dunning-policy configurator. Permission-aware; the services
are the gate.

#### Wave 4 — Verification (2)

| ID         | Title                                        | Size | Depends on |
| ---------- | -------------------------------------------- | ---- | ---------- |
| **OB-132** | Enforcement matrix + idempotency suite       | L    | 130        |
| **OB-133** | E2E: brand → recur → post → send → dun → pay | M    | 131        |

**OB-132** — The guarantees as tests: dunning sends **once per stage** under a generated run, recurring
cycles are idempotent, an auto-approved recurring post carries provenance (F3-style), the storage
adapters round-trip, and send/schedule sit behind their permissions across the matrix. The
once-per-stage and once-per-cycle properties get the mutation testing load-bearing guards get.

**OB-133** — One narrative against the real stack ([D-26](#d-26)): brand an org, set a recurring
template to `approved`, let a cycle fire and post, watch the invoice go out as a themed PDF+email,
let dunning escalate an overdue one, then mark it paid and see the sequence suppress.

**Critical path:** 120 → 125 → 126 → 129 → 133; OB-127 (scheduler) gates 128 and 129, and OB-121
(the hosted page) gates 126. OB-120 (storage), OB-121 (the public token-gated page) and OB-127 (the
scheduler) are the three most likely to expand — the first and last are net-new plumbing, and the
page is a new unauthenticated surface with its own security review.

---

## Cash application

The AR receipt side: turning money that arrived into settled invoices. The bank-feed match screen
(OB-086) is already the working surface — it ranks the open invoice a deposit probably pays and
settles it in one accepted keystroke (`allocate_document` → `recordPayment` + allocation). This
initiative closes the two gaps that surface leaves: a statement line can settle only **one** target
today, and an early-payment discount has no first-class home. Criteria **I**; tickets OB-134…OB-142.

It introduces the concept both this and Pay Bills were missing — **payment terms** ([D-79](#d-79)):
a term (Net 30, 2/10 Net 30, Due on receipt) computes the due date and, when it carries one, the
early-pay discount and its deadline; simple (net only) and rich (with a discount) both supported.
And it generalises bank clearing to **multiple entries per statement line** ([D-80](#d-80)) — one
deposit across several customers' invoices (lockbox) and one line coded across several accounts (the
deferred **OB-094** split) as a single mechanism.

### Definition of done

An org defines payment terms and assigns a default to a customer or vendor, overridable per document.
A deposit lands in the feed and the operator clears it across **several** targets at once — three
customers' invoices, or one invoice plus a bank-charge line — the entries summing to the line. When
an invoice being settled is within its discount window the screen **suggests** the discount as one of
the entries; the operator confirms (never auto-posted), and it lands on the org's discount account.
The same suggestion appears when paying a bill within terms in Pay Bills. The multi-entry clear still
balances to the line (E4), and `outstanding` and the ledger stay exactly as the accepted entries
posted them.

| #   | Acceptance criterion                                                                                                                      | Verified by    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| I1  | A payment term computes the due date and, when set, the early-pay discount + deadline; customer/vendor default, per-document override     | OB-136         |
| I2  | A bank statement line clears against **multiple entries** (invoices/bills/GL/discount) summing to the line; the clear still balances (E4) | OB-137, OB-141 |
| I3  | Lockbox: one deposit settles **several customers'** invoices in one accepted action                                                       | OB-137, OB-142 |
| I4  | An in-window invoice/bill shows a **suggested discount** entry; confirmed, never auto-posted, to the org's discount account               | OB-138, OB-141 |
| I5  | The discount suggestion appears both in bank clearing **and** in Pay Bills                                                                | OB-138         |
| I6  | Both a **simple** term (net only) and a **manual** ad-hoc discount work — rich is optional                                                | OB-136, OB-138 |
| I7  | **OB-094 is subsumed**: one line coded across several GL accounts is the same multi-entry mechanism                                       | OB-137         |
| I8  | Propose-then-post preserved ([D-43](#d-43)): every multi-entry clear and suggestion is human-accepted                                     | OB-141         |

### Explicitly out

- **Auto-posting a match** — unchanged from [D-43](#d-43): the engine proposes, a human accepts.
  Multi-entry and discount suggestions are still one accepted keystroke, not an auto-poster.
- **Remittance-advice file ingestion** (a customer's file listing which invoices a lump covers) —
  later; the reference/amount/counterparty ranking already covers the common case.
- **A dedicated batch "receive payments" grid** separate from the match workbench — the workbench,
  extended to multi-entry, is the surface ([D-81](#d-81)).

### Ticket board

9 tickets across 4 waves, numbered on from Invoicing.

#### Wave 0 — Schema and contracts (2 parallel)

| ID         | Title                                      | Size | Depends on |
| ---------- | ------------------------------------------ | ---- | ---------- |
| **OB-134** | Payment terms + discount schema and grants | L    | —          |
| **OB-135** | Cash-application wire contracts            | M    | —          |

**OB-134** — `payment_terms` (name, net days, optional discount percent + window days), a default
term on `contacts`, an override on the document, and the discount-given/received account nominations
(alongside the control accounts in `org_accounting_settings`). Terms are **mutable**.

**OB-135** — The contracts: the term, the multi-entry clearing request (an array of entries where
today there is one), and the discount-suggestion shape. No `.meta({ id })` until OB-139.

#### Wave 1 — Terms, multi-entry, and the suggestion (3)

| ID         | Title                            | Size | Depends on |
| ---------- | -------------------------------- | ---- | ---------- |
| **OB-136** | Payment terms service            | M    | 134, 135   |
| **OB-137** | Multi-entry bank clearing        | L    | 135, M4    |
| **OB-138** | Terms-driven discount suggestion | M    | 136, 137   |

**OB-136** — Compute the due date and, when the term carries a discount, the allowed amount and its
deadline, from the term on the document (or the contact default). Simple terms carry no discount.

**OB-137** — Extend `clearBankStatementLine` from one target to an **array of entries** —
`allocate_document` × N, `post_entry` × N, and a discount line — generalising the difference logic
([D-80](#d-80)). This is one deposit across many customers' invoices (lockbox) and OB-094's
split-coding as the same mechanism; the clear still balances to the line (E4), each entry posts as
today, and undo reverses the set.

**OB-138** — When an invoice or bill being settled is within its discount window, surface the
computed discount as a **suggested entry** the operator confirms — in bank clearing and in Pay Bills
alike ([D-79](#d-79)). Never auto-posted; the account is the org's discount nomination.

#### Wave 2 — Transport and screens (2)

| ID         | Title                                            | Size | Depends on |
| ---------- | ------------------------------------------------ | ---- | ---------- |
| **OB-139** | `/v1` surface for terms and multi-entry clearing | M    | 136–138    |
| **OB-140** | Screens                                          | L    | 139        |

**OB-139** — Routes for terms, the multi-entry clear, and the suggestion. Handlers map arguments.

**OB-140** — The multi-entry match row on the bank-match screen (add/remove entries against one
line, with the running difference), payment-terms settings, and the discount-suggestion affordance.
Permission-aware; the services are the gate.

#### Wave 3 — Verification (2)

| ID         | Title                                    | Size | Depends on |
| ---------- | ---------------------------------------- | ---- | ---------- |
| **OB-141** | Enforcement + multi-entry property suite | L    | 139        |
| **OB-142** | E2E: lockbox deposit with a discount     | M    | 140        |

**OB-141** — The guarantees as tests: a multi-entry clear **sums to the line** (E4) under a generated
run of entry sets, the discount suggestion computes from the term, and every clear stays
human-accepted. The sum-to-line and suggestion properties get the mutation testing load-bearing
guards get.

**OB-142** — One narrative ([D-26](#d-26)): a single deposit split across three customers' invoices,
one of them settled with an in-terms early-pay discount, and the clear balancing to the deposit.

**Critical path:** 134 → 137 → 138 → 140 → 142. OB-137 (multi-entry clearing) is the load-bearing
change — it is the generalisation OB-094 was deferred for, now the mechanism for lockbox too.

### CA execution — dev-ready, parallelised

The prose above is criteria + tickets; this is the seam-pinned build plan (the M5/PAY "decide before you
fan out" discipline). CA is **greenfield** — a grep for `payment_term|discount_given|net_days|write_off`
returns zero — so almost everything is additive. **Four forks were settled up front**
([D-105](#d-105)…[D-108](#d-108)): multi-entry clearing is **parent + child** (`bank_line_clearing_entries`),
the discount is a **discount-kind allocation + a journal line**, terms **reuse `orgs.read`/`orgs.write`**
(no new catalog key), and CA builds the **AR-side** suggestion (clearing + money-in) with the **Pay-Bills
side deferred to PB**. The one load-bearing change is OB-137 (single-target clear → array); everything
else composes on seams that already exist.

#### Seams that already exist — reuse verbatim

| Need                                 | Reuse (symbol @ path)                                                                                                                                                     | How CA uses it                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Multi-target allocation array        | `createAllocationsRequestSchema` @ `shared-types/src/subledger/allocations.ts:119`; `applyAllocations` @ `modules/payments/allocate.ts:85`                                | The N-target allocation shape is **already done**; add a third `AllocationSource` kind `'discount'` ([D-106](#d-106)).             |
| Discount-account nomination          | `resolveControlAccount` / `getControlAccounts` / `updateControlAccounts` @ `modules/settings/control-accounts.ts`; `upsertControlAccounts` @ `settings.repository.ts:122` | Mirror exactly for `discount_given_account_id`/`discount_received_account_id` on `org_accounting_settings`.                        |
| The clear entry point (to extend)    | `clearBankStatementLine` @ `modules/banking/clearing/clearing.service.ts:131`; the `method` union @ `shared-types/src/banking/clearing.ts:184`                            | OB-137 turns the single-target request into an **array of entries**; the shared body schema flows to the web client automatically. |
| E4 invariant + difference            | `assertClearingBalances` @ `clearing.service.ts:448`; `resolveDifference` @ `:402`                                                                                        | Generalise to `Σ(entries) + difference === line.amount`; keep `resolveDifference` for the residual.                                |
| Reconciliation stamp / undo          | `stampMembership` @ `reconciliation.repository.ts:676`; `removeBankLineClearing` @ `clearing.service.ts:204`                                                              | Both stay on the **parent** `bank_line_clearings` — unchanged ([D-105](#d-105)); undo reverses the child entries as a unit.        |
| `outstanding` computation            | `documentTotal` − `allocatedToDocument` @ `modules/payments/allocations.repository.ts:164,195`                                                                            | Untouched — the discount-kind allocation makes it net to zero without a special case.                                              |
| Record a receipt (allocate_document) | `recordPayment` @ `modules/payments/payments.service.ts:132`                                                                                                              | Each `allocate_document` entry still records through it, exactly as today.                                                         |
| Bank-match workbench                 | `matching-screen.tsx` (`accept` :206), `banking-match/queries.ts` (`proposalToClearRequest` :308, `useClearLine` :241)                                                    | Replace the scalar clear with an add/remove-entries editor + running difference + discount affordance (OB-140).                    |
| Manual money-in path                 | `screens/money-in.tsx` + `money-in/allocation-editor.tsx` → `POST /v1/payments`                                                                                           | Surface the same discount suggestion here (D-81 receipts-not-in-the-feed).                                                         |

#### Schema — migration `0012_cash_application` (next free prefix; `0011` is the highest before `0999`)

New tables/columns are additive; the `bank_line_clearings` **restructure** edits `0006_banking` **in place**
([D-15](#d-15) pre-release), so the orchestrator does the full reset + codegen (a schema change is the
orchestrator's hand, per CLAUDE.md). Money is cents `bigint`; a rate is ppm like `tax_rates.rate_ppm`.

- **`payment_terms`** (new, tenant, **mutable**): `id`, `org_id`, `name`, `net_days INT UNSIGNED NOT NULL`,
  `discount_rate_ppm INT UNSIGNED NULL`, `discount_window_days INT UNSIGNED NULL` (both null = a **simple**
  term), `is_active`, timestamps; `uq (org_id, name)`. → `TENANT_TABLES` + `MUTABLE_TABLES` + a `grants.test` row.
- **`bank_line_clearing_entries`** (new, tenant — belongs to the banking subsystem, so it may live in
  `0006` alongside its parent): `id`, `org_id`, `clearing_id` (FK `bank_line_clearings`),
  `entry_type ENUM('allocate_document','post_entry','discount')`, `cleared_journal_id`, `payment_id NULL`,
  `account_id NULL` (post_entry/discount target), `target_type`/`target_id NULL` (allocate_document),
  `amount_minor BIGINT` (signed), author, timestamps; `uq_blce_journal (org_id, cleared_journal_id)` (the
  moved `uq_blc_journal`). The `chk_blc_*` CHECKs move here per `entry_type`.
- **`bank_line_clearings`** (edit 0006 in place): drop the singular target columns (`method`,
  `cleared_journal_id`, `payment_id`) and `uq_blc_journal`; keep `statement_line_id`, `uq_blc_line`
  (still one clearing per line), `reconciliation_session_id`, the total `cleared_amount_minor`,
  `difference_amount_minor`/`difference_account_id`/`difference_journal_id`.
- **In-place column adds** ([D-15](#d-15)): `contacts.default_payment_term_id BINARY(16) NULL`
  (`0002_ledger`), `ar_documents.payment_term_id` + `ap_documents.payment_term_id BINARY(16) NULL`
  (`0005_subledger`), `org_accounting_settings.discount_given_account_id` +
  `.discount_received_account_id BINARY(16) NULL` (`0005_subledger`) — all composite FKs.
- Codegen `generated.ts` overrides: none new needed (no money/DATE columns beyond the existing rules; ppm
  and day-count INTs map to `number` correctly).

#### Contract-first seams (pin before fan-out)

- **Payment term** (`shared-types`): `paymentTermSchema` `{ id, name, netDays, discountRatePpm: number|null, discountWindowDays: number|null, isActive }`; `createPaymentTermRequestSchema`; a `computedDueDate`/`discountWindow` result type.
- **Multi-entry clear** — the load-bearing contract change: `clearBankStatementLineRequestSchema`
  (`banking/clearing.ts:184`) becomes `{ entries: ClearingEntry[] }` where `ClearingEntry` is the existing
  `post_entry`/`link_entry`/`allocate_document` union **plus** a `discount` member
  `{ entryType:'discount', accountId, targetType, targetId, amount }`. The set sums to the line (E4).
  Keep a one-entry array as the common case (the current single-target proposal maps to `entries:[one]`).
- **Discount suggestion**: a read/preview shape `{ targetId, discountAmountMinor, deadline, accountId }`
  computed from the term — surfaced by a preview endpoint the workbench/money-in call before the human confirms.
- **Permissions**: none new (D-107) — terms CRUD gates `orgs.read`/`orgs.write`; the clear gates `banking.match`.

#### Waves (OB-134…142 as scoped)

| Wave                                              | Tickets                                                                                                                                                                                                                                                                                                                 | Deliverable                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **0 — Schema + contracts** (parallel)             | **OB-134** `0012` schema + the `bank_line_clearings` restructure + `TENANT/MUTABLE/grants` + discount-account columns · **OB-135** wire contracts (term, multi-entry clear array, suggestion)                                                                                                                           | Orchestrator owns the 0006 in-place edit + codegen reset.                           |
| **1 — Terms, multi-entry, suggestion** (parallel) | **OB-136** payment-terms service (compute due date + discount window; contact default → document override) · **OB-137** multi-entry clearing (the load-bearing change: array of entries, E4 = Σ, parent+child, undo-as-unit) · **OB-138** terms-driven discount suggestion (a `'discount'` allocation + journal, D-106) | OB-137 is the expansion risk (reconciliation reads, race test, undo).               |
| **2 — Transport + screens**                       | **OB-139** `/v1` routes (payment-terms CRUD, extended clear body, suggestion preview) · **OB-140** the multi-entry match row (add/remove entries + running difference) + payment-terms settings + discount affordance, on the workbench and money-in                                                                    | The clear route body extends in place; new term routes trip the coverage tripwires. |
| **3 — Verification**                              | **OB-141** enforcement + multi-entry property suite (Σ-to-line under generated entry sets; suggestion computes from the term; every clear human-accepted) + mutation testing · **OB-142** E2E: one deposit split across three invoices, one with an in-terms discount, balancing to the deposit                         |                                                                                     |

**Critical path:** OB-134 → OB-137 → OB-138 → OB-140 → OB-142.

#### Tripwire / registry checklist

`db/tenant-tables.ts` (+`payment_terms`, +`bank_line_clearing_entries`, compile-checked) · `0999_app_grants.ts`
`MUTABLE_TABLES` (+both) + `grants.test.ts` rows · **the `bank_line_clearings` restructure updates the pinned
banking suites** — `clearing.e4.test.ts`, `clearing.service.test.ts` (the `statement_line_already_cleared`/
`journal_already_cleared` refusals loosen), `clearing.race.test.ts` (the uniqueness it proves moves to the
child), `report.property.test.ts` (its one-signed-amount-per-line sum) · `test/transport/routes.test.ts` +
`test/transport/openapi.test.ts` (regenerate `openapi.json` + web client) + `cross-org.test.ts` /
`cross-org-references.test.ts` for the new term routes · **no** permission-catalog/permission-matrix change
(D-107) · `generated.ts` via throwaway-MySQL codegen after the reset.

#### Deliberate deferrals (flagged)

- **The Pay-Bills-side discount suggestion (I5) is deferred to PB** ([D-108](#d-108)) — the primitive is
  built AP+AR, only the PB call site is missing.
- **Remittance-advice file ingestion** stays out (per the CA "Explicitly out") — the reference/amount ranking covers the common case.
- **Multi-currency** unaffected and still out (§13).

---

## Payment integration — Stripe & Square

Accepting a customer payment online, and the AR inbound-rail mirror of the AP disbursement rails
([D-67](#d-67)). Its own initiative, deliberately separate from cash application: that one applies
money the org already has; this one **brings money in through a processor** and models the very
different settlement shape a processor imposes. Criteria **J**; tickets OB-143…OB-153. It leans on
three earlier seams — the hosted invoice page ([D-74](#d-74)) as the pay-link surface, M5's
`external_refs` for webhook idempotency, and the new scheduler (OB-127) for the polling backstop.

The load-bearing model is [D-82](#d-82): **a processor is a clearing account, not a bank.** A charge
clears AR into the processor's clearing account _immediately_; the periodic **payout** moves the
accumulated balance to the real bank, net of fees and refunds; the bank feed reconciles that single
payout. So "invoice paid" (at charge) and "cash in bank" (at payout) decouple, and the books
reconcile because the clearing account nets to zero against the payout.

### Definition of done

An org connects Stripe or Square with its own keys (in the secrets provider — OpenBooks never sees a
card, [D-83](#d-83)). A customer opens the hosted invoice page, clicks pay, and pays on the
processor's own checkout. A signed, `external_refs`-idempotent webhook records a `received` payment
via a **system actor**, allocates it to the invoice named in the checkout metadata (certain identity,
not a guess), and posts the per-charge fee ([D-84](#d-84)) — all into the clearing account. A daily
poll backstops missed webhooks and reconciles the clearing balance against the processor's own
([D-85](#d-85)). When the processor pays out, the bank feed reconciles the net deposit against the
clearing account. Refunds post as opposite-direction payments; a chargeback is recorded and coded at
payout, its full lifecycle deferred.

| #   | Acceptance criterion                                                                                        | Verified by    |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| J1  | A processor is a **clearing account**: a charge clears AR into it, a payout moves it to the bank            | OB-147, OB-153 |
| J2  | **Hosted checkout only** — no card data touches OpenBooks (PCI SAQ-A); keys in the secrets provider         | OB-145, OB-151 |
| J3  | An online payment auto-records + auto-allocates to the invoice in checkout metadata, via a **system actor** | OB-148, OB-153 |
| J4  | The **per-charge fee** posts at charge through the discount/fee primitive ([D-79](#d-79))                   | OB-147         |
| J5  | Webhooks are **signature-verified** and `external_refs`-idempotent — a replay collapses to one payment (F9) | OB-148, OB-152 |
| J6  | A scheduled poll reconciles the clearing balance against the **processor's reported balance**               | OB-148         |
| J7  | Refunds post as opposite-direction payments; **chargebacks are recorded-and-coded at payout** (lean)        | OB-149         |
| J8  | The **payout reconciles** against the clearing account through the bank match pipeline                      | OB-147, OB-153 |
| J9  | Stripe **and** Square work behind one `PaymentProcessorProvider`; the pay-link reuses the hosted page       | OB-145, OB-146 |

### Explicitly out

- **Embedded card fields** (Stripe Elements and the like) — hosted checkout only, to stay out of PCI
  scope ([D-83](#d-83)).
- **Full dispute lifecycle** (opened/evidence/won/lost states) — v1 records and codes the chargeback
  at payout ([D-84](#d-84)).
- **Multi-currency** (spec §13) — the processor charges in the org's currency; still deferred.
- **A full customer portal** — the pay-link opens the single hosted invoice page ([D-74](#d-74)), not
  a logged-in account.

### Ticket board

11 tickets across 5 waves, numbered on from Cash application.

#### Wave 0 — Provider, schema and contracts (2 parallel)

| ID         | Title                                         | Size | Depends on |
| ---------- | --------------------------------------------- | ---- | ---------- |
| **OB-143** | `PaymentProcessorProvider` + processor schema | L    | M5         |
| **OB-144** | Payment-integration wire contracts            | M    | M5         |

**OB-143** — The new provider interface (create hosted-checkout link, verify webhook, normalise
events — charge/fee/refund/dispute/payout) and its schema: the processor **clearing account** (a
ledger account plus processor-import metadata, like a bank account is — D-46), the webhook-event log,
and the `external_refs` rows that key a processor object to an OpenBooks entity. The provider is the
AR mirror of the AP rails ([D-67](#d-67), [D-86](#d-86)).

**OB-144** — The contracts: connect-processor, the normalised event, the pay-link. OAuth-style
processor endpoints stay outside the typed envelope where the processor dictates their shape.

#### Wave 1 — Adapters and the clearing model (3)

| ID         | Title                                       | Size | Depends on   |
| ---------- | ------------------------------------------- | ---- | ------------ |
| **OB-145** | Stripe adapter                              | L    | 143, INV     |
| **OB-146** | Square adapter                              | M    | 143          |
| **OB-147** | Clearing-account posting + payout reconcile | L    | 143, M4, 138 |

**OB-145** — Hosted-checkout link (invoice id in the session metadata for certain identity),
signature verification, and event normalisation. The pay-link lands on the hosted invoice page
(OB-121 / [D-74](#d-74)).

**OB-146** — The Square adapter behind the same interface — the second implementation that proves the
abstraction, the way M5's consumers proved the platform contracts.

**OB-147** — The posting model ([D-82](#d-82)): charge → clear AR + per-charge fee + credit clearing;
payout → debit bank, credit clearing; and the payout reconciled against the clearing account through
the M4 match pipeline. The fee is the discount/fee primitive ([D-79](#d-79)) on the receiving side.

#### Wave 2 — Webhooks and the money events (2)

| ID         | Title                               | Size | Depends on    |
| ---------- | ----------------------------------- | ---- | ------------- |
| **OB-148** | Webhook receiver + polling backstop | L    | 145, 147, 127 |
| **OB-149** | Refunds + lean chargeback coding    | M    | 148           |

**OB-148** — The signed inbound endpoint (distinct from M5's deferred _outbound_ push, [D-57](#d-57)):
verify, dedupe through `external_refs` (F9), and drive `recordPayment` + allocation via a system
actor so provenance lands (spec §6). A scheduled poll on OB-127 backstops missed webhooks and
reconciles the clearing balance against the processor's own ([D-85](#d-85)) — the subledger-agreement
discipline OB-088 applied to reconciliation, one level further out.

**OB-149** — Refunds as opposite-direction payments (the retained fee stays an expense); a chargeback
recorded and coded when it hits the payout, its full lifecycle deferred ([D-84](#d-84)).

#### Wave 3 — Transport and screens (2)

| ID         | Title                                       | Size | Depends on |
| ---------- | ------------------------------------------- | ---- | ---------- |
| **OB-150** | `/v1` surface + pay-link on the hosted page | M    | 145–149    |
| **OB-151** | Connect-a-processor settings screen         | M    | 150        |

**OB-150** — The management routes and the pay-link wired onto the hosted invoice page (OB-121).

**OB-151** — Connect Stripe/Square per org, keys stored through the secrets provider — never entered
into or echoed by OpenBooks ([D-83](#d-83)).

#### Wave 4 — Verification (2)

| ID         | Title                                                 | Size | Depends on |
| ---------- | ----------------------------------------------------- | ---- | ---------- |
| **OB-152** | Enforcement + idempotency property suite              | L    | 150        |
| **OB-153** | E2E: pay a hosted invoice → paid → payout → reconcile | M    | 151        |

**OB-152** — The guarantees as tests: a replayed webhook collapses to one payment (F9-style), the
clearing account reconciles against a generated charge/fee/refund/payout stream, and every
processor-driven write carries provenance. The idempotency property gets mutation testing.

**OB-153** — One narrative against the real stack ([D-26](#d-26)), with a processor sandbox: pay an
invoice on hosted checkout, watch the webhook mark it paid and post the fee into clearing, then a
payout reconcile the clearing account against the bank line.

**Critical path:** 143 → 145 → 147 → 148 → 153. OB-147 (the clearing model) and OB-148 (the webhook
receiver) are the two most likely to expand — the settlement shape and the exactly-once guarantee,
the way OB-098 and OB-100 were for M5.

### PAY execution — dev-ready, parallelised

The prose scope above is criteria + tickets; this is the seam-pinned build plan. **Four forks were
settled up front** ([D-101](#d-101)…[D-104](#d-104), the M5 "decide before you fan out" discipline):
build a real secrets **write** seam, run a **`fake`** processor under the gate, model the clearing
account as a **plain GL account + `processor_connections` row**, and post the fee as a **self-contained
line** (no D-79 dependency). The good news the exploration surfaced: almost every seam PAY needs
already exists and is load-bearing elsewhere — the only new **foundation** is the secrets write path
(OB-143a). _(An earlier note said this also unblocks initiative Q; that no longer holds — Q went
MCP-only ([D-100](#d-100)) and holds no model credentials, so it does not use the secrets seam.)_

#### Seams that already exist — reuse verbatim (no new machinery)

| Need                             | Reuse (symbol @ path)                                                                                                                                                                       | How PAY uses it                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook idempotency (F9, J5)     | `createExternalRef`/`lookupExternalRef` @ `modules/external-refs/external-refs.service.ts:75,216`; `entityType:'payment'` already allowed @ `shared-types/src/platform/external-refs.ts:18` | Key a processor charge/refund/payout **object id** → the OpenBooks payment/journal. The `FOR UPDATE` post-race recovery (`external-refs.repository.ts:99`) is already fixed.                                                                                            |
| Record + allocate the payment    | `recordPayment` @ `modules/payments/payments.service.ts:132`; `applyAllocations` @ `modules/payments/allocate.ts:85`                                                                        | `recordPayment({direction:'received', accountId: clearing_account_id, allocations:[{targetType:'invoice', targetId, amount}]})` — posts the AR↔clearing leg (`source:'payment'`), auto-allocates on the checkout-metadata invoice id (certain identity, [D-83](#d-83)). |
| The per-charge fee journal (J4)  | `postJournal` @ `modules/ledger/posting.service.ts:115`; `source:'clearing'` already valid @ `plugin-api/src/posting.ts:63`                                                                 | Debit fee-expense, credit clearing — **no migration, no new `source` value** ([D-104](#d-104)).                                                                                                                                                                         |
| System-actor provenance (J3)     | `runAsAutomation` @ `modules/scheduling/automation.ts:45`                                                                                                                                   | Wrap every webhook/poll write; yields `actor_type:'automation'`, `invocation_mode` NULL → satisfies `chk_journals_invocation_mode` (`0002_ledger.ts:360`). `actorId` = the connection uuid.                                                                             |
| Payout reconcile (J8)            | `clearBankStatementLine(method:'link_entry')` @ `modules/banking/clearing/clearing.service.ts:131`                                                                                          | The payout is an ordinary bank statement line; link it to the payout journal (debit bank, credit clearing) — existing M4 pipeline, unchanged.                                                                                                                           |
| Backstop balance discipline (J6) | `bookBalance` @ `modules/banking/reconciliation/reconciliation.repository.ts:415`; property model `reconciliation/report.property.test.ts`                                                  | Daily poll asserts the clearing account's ledger `bookBalance` equals the processor's reported balance, two independent ways (OB-088 discipline, [D-85](#d-85)).                                                                                                        |
| Polling-backstop scheduling      | `registerDailyTask` + `queue.subscribe` @ `modules/scheduling/tick.ts:39`; wired in `entrypoints/api.ts` (in-process branch) **and** `worker.ts`                                            | A `processor-poll` daily task, registered in both entrypoints exactly like recurring/dunning.                                                                                                                                                                           |
| Pay-button surface (J2)          | hosted-page footer @ `packages/web/src/screens/public-invoice.tsx:~296`; public-route pattern @ `transport/routes/public-invoices.ts` + `transport/app.ts:273`                              | A "Pay now" link → the processor's hosted checkout; the return/confirmation lands on a **session-less public route**, like the hosted invoice page.                                                                                                                     |
| Nominate accounts, don't invent  | `createBankAccount` pattern @ `modules/banking/bank-accounts/bank-accounts.service.ts:86`                                                                                                   | connect-processor registers an **existing** clearing + fee account ([D-23](#d-23)/[D-103](#d-103)).                                                                                                                                                                     |

#### The one new foundation — a secrets write seam (OB-143a)

Add `put(name, value)` to `SecretsProvider` (`packages/plugin-api/src/providers.ts:24`); create
`packages/server/src/providers/secrets/` with an exhaustive-`switch` factory (`createSecretsProvider`),
a real self-host adapter (`env`/local, encrypted-at-rest under an app key from `src/config/`) and a
**throwing** `aws-secrets-manager` adapter; add the `secretsProvider()`/`setSecretsProvider()` accessor
pair in `providers/index.ts` alongside the others. The config vocabulary already exists
(`SECRETS_PROVIDERS`, `SecretsConfig`, `selectSecrets`, the `PROVIDER_REQUIREMENTS` row) — only the
adapter/accessor layer is missing. This is the [D-101](#d-101) seam; keep it tiny and generic so Q
reuses it unchanged.

#### Schema — migration `0011_payment_processing` (next free prefix; `0010` is the highest before `0999`)

Two tenant tables, both **mutable** (status/cursor transitions), the `bank_accounts`/`bank_statement_imports` register:

- **`processor_connections`** — `id`, `org_id`, `processor ENUM('stripe','square','fake')`,
  `clearing_account_id` + `fee_account_id` (composite FKs `(org_id, account_id) → accounts`, [D-103](#d-103)),
  `secret_ref` + `webhook_secret_ref VARCHAR` (handles in the secrets provider — **never the key**),
  `publishable_key VARCHAR NULL` (non-secret, needed to build the checkout link), `external_account_id`,
  `reconciled_through`/`last_polled_at` (backstop cursor), `is_active`, timestamps; one active
  connection per `(org_id, processor)`.
- **`processor_events`** — `id`, `org_id`, `connection_id`, `processor`, `external_event_id VARCHAR`
  with **`uq (org_id, processor, external_event_id)`** (event-level F9 gate), `external_object_id`,
  `event_type` (`charge|fee|refund|dispute|payout`), `payload JSON` (money as **cents strings**, the
  F7 site the M5 outbox tripped on), `received_at`, `status`/`processed_at`.

**Idempotency is two-level and both matter.** Webhook redelivery is stopped by the `processor_events`
unique insert (cheap, pre-journal); the same object arriving from _both_ a webhook and the poll is
stopped by `external_refs` on the charge **object id**. Because journals are append-only and cannot be
`SELECT … FOR UPDATE`'d, the "check-external-ref-then-`recordPayment`" step must run under a lock on
the `processor_connections` row (or a dedicated dedup row) so two concurrent deliveries of one charge
cannot both post — **prove this with a contention test**, don't assume it (the project's earned rule;
OB-152). OB-148 owns nailing this — it is the OB-098/OB-100-shaped ticket.

#### Contract-first seams (pin these before any fan-out)

- **`PaymentProcessorProvider`** (new interface in `plugin-api/src/providers.ts`, mirror `DocumentExtractionProvider`):
  `createCheckoutLink({connection, invoiceId, amountMinor, returnUrl}) → {url, sessionId}`;
  `verifyWebhook({rawBody, signatureHeader, webhookSecret}) → NormalizedEvent` (throws on bad signature);
  `fetchBalance(connection) → {availableMinor}`; `listObjectsSince(connection, cursor) → NormalizedEvent[]` (poll).
- **`NormalizedEvent`** (internal, in `shared-types`): `{kind:'charge'|'fee'|'refund'|'dispute'|'payout', externalEventId, externalObjectId, invoiceId?, grossMinor, feeMinor?, netMinor?, occurredAt, raw}` — money always **cents strings**.
- **Wire contracts (OB-144):** connect-processor request, pay-link response. Per the known gotcha,
  route querystring/body Zod schemas are defined **locally in the route file** (`…Wire` suffix), not
  reused from the module — see `transport/routes/recurring-invoices.ts:56`. The signed webhook body and
  processor OAuth-style endpoints stay **outside** the typed envelope where the processor dictates shape.
- **Permission keys:** two new — `processing.read` / `processing.write` — for the connect/manage
  surface (the webhook is signature-gated and system-actor-driven, so it needs no key). Bumps
  `AssertCatalogSize<51>` → `<53>` (`modules/permissions/catalog.ts:127`) and seeds in `0001_tenancy.ts`.

#### Waves (OB-143…OB-153 as scoped, plus OB-143a)

| Wave                                   | Tickets                                                                                                                                                                                                                                                                         | Deliverable                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 — Foundations** (parallel)         | **OB-143a** secrets write seam · **OB-143** provider iface + `0011` schema + `stripe`/`square`/`fake` config seam · **OB-144** wire contracts                                                                                                                                   | The seams everything composes against. OB-143a gates OB-143 (connect stores a secret).                                                     |
| **1 — Adapters + clearing** (parallel) | **OB-145** Stripe adapter (real) **+ the `fake` adapter that drives the gate** ([D-102](#d-102)) · **OB-146** Square adapter · **OB-147** clearing/fee posting + payout reconcile                                                                                               | OB-147 is `recordPayment` on the clearing account + a `source:'clearing'` fee journal + `link_entry` payout — assembly, not new machinery. |
| **2 — Webhooks + money events**        | **OB-148** webhook receiver (public, signature-verified, two-level dedup under the connection-row lock) + poll backstop (`registerDailyTask`, `bookBalance` reconcile) · **OB-149** refunds (opposite-direction `recordPayment`) + lean chargeback coding at payout             | **OB-148 is the expansion risk.**                                                                                                          |
| **3 — Transport + screens**            | **OB-150** `/v1` management routes + Pay button on the hosted page + session-less return route · **OB-151** connect-a-processor settings screen (keys → secrets seam, never echoed)                                                                                             |                                                                                                                                            |
| **4 — Verification**                   | **OB-152** enforcement + idempotency property suite (replay collapses to one payment; clearing reconciles against a generated charge/fee/refund/payout stream; provenance on every write) + mutation testing · **OB-153** E2E: pay a hosted invoice → paid → payout → reconcile | Both run on the `fake` processor.                                                                                                          |

**Critical path:** OB-143a → OB-143 → OB-145 → OB-147 → OB-148 → OB-153.

#### Tripwire / registry checklist (a new table + new routes must touch all of these)

`db/tenant-tables.ts` (+2, compile-checked) · `0999_app_grants.ts` `MUTABLE_TABLES` (+2) and per-table
grant · `test/enforcement/grants.test.ts` (+2 rows) · `catalog.ts` `PERMISSION_KEYS` (+2) with the
`AssertCatalogSize` bump + `0001_tenancy.ts` seed + `test/permissions/catalog.test.ts` ·
`test/enforcement/permission-matrix.test.ts` (new service methods) · `test/transport/routes.test.ts`
· `test/transport/openapi.test.ts` (+ regenerate root `openapi.json`) ·
`test/enforcement/cross-org.test.ts` + `cross-org-references.test.ts` · **`generated.ts` via
throwaway-MySQL codegen** (orchestrator's hand — a subagent worktree has no live DB; per CLAUDE.md).

#### Deliberate divergences and still-owed edges (flag, don't silently absorb)

- **The webhook endpoint does not use the global `Idempotency-Key` middleware.** Stripe/Square won't
  send our header; the idempotency anchor is the processor event/object id (`processor_events` +
  `external_refs`). This **diverges from the OCR inbound webhook** (which conformed via
  `withGlobalIdempotency`) — deliberate, because here the processor id _is_ the idempotency key
  ([D-85](#d-85)/F9).
- **Real Stripe/Square are proven only in a manual sandbox run**; the gate's coverage is the `fake`
  ([D-102](#d-102)). The `fake` must exercise a real signature-verify path, not a stub, or J5/F9 is
  untested.
- **Lean by decision:** chargeback recorded-and-coded at payout, full dispute lifecycle deferred
  ([D-84](#d-84)); multi-currency deferred (§13); embedded card fields out — hosted checkout only
  ([D-83](#d-83)).

---

## Financial reporting — cash basis, cash flow, projection

The reporting layer M2 deferred, now **majority-critical**: most customers file cash-basis while still
using accrual documents operationally (session finding), so cash-basis reporting is the majority's
daily P&L, not a toggle. Three reports on one "trace ledger events to cash timing" engine. Criteria
**K**; tickets OB-154…OB-161.

The load-bearing piece is the **cash-basis transform** ([D-87](#d-87)), built with ledger-kernel rigor
because the stakes are "gets them in trouble." The common document→payment case is deterministic
(re-recognise at payment date, proportional for partials, exclude unpaid); the risk concentrates in a
small set of edges — accrual adjusting JEs (counted only to the extent they touch cash) and
prepayments/unallocated receipts — which are **flagged and routed to review** ([Q](#q), the agent
queue), never silently guessed. Every report is unmistakably **basis-labeled**.

### Definition of done

An org sets its default basis. P&L and the cash-flow reports render on that basis, labeled. The
cash-basis transform re-recognises each accrual document at its settling payment date, proportionally
for partials, excludes the unpaid, and counts a journal only to the extent it touches cash — flagging
the ambiguous. A **Statement of Cash Flows** (indirect) — the missing third statement — reconciles net
income to cash movement. A **cash-flow projection** forecasts forward from AR/AP due dates and
recurring commitments.

| #   | Acceptance criterion                                                                                        | Verified by    |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| K1  | Reports render on the org's basis, **unmistakably labeled**; basis is a per-report override of the default  | OB-156         |
| K2  | Cash basis re-recognises a document at its **payment date**, **proportional** for partials, excludes unpaid | OB-154, OB-160 |
| K3  | A journal counts on cash basis **only to the extent it touches cash**; the rest is flagged                  | OB-154, OB-155 |
| K4  | Accrual adjusting JEs and prepayments/unallocated receipts are **flagged for review**, not guessed          | OB-155         |
| K5  | The **Statement of Cash Flows** (indirect) reconciles net income to the change in cash                      | OB-157, OB-160 |
| K6  | The **cash-flow projection** forecasts from AR/AP due dates + recurring commitments                         | OB-158         |
| K7  | The transform is **property- and mutation-tested** to ledger-kernel standard                                | OB-160         |

### Ticket board

| ID         | Title                                                   | Size | Depends on |
| ---------- | ------------------------------------------------------- | ---- | ---------- |
| **OB-154** | Cash-basis transform engine                             | L    | M3         |
| **OB-155** | Ambiguous-edge flagging → review/agent queue            | M    | 154, Q     |
| **OB-156** | Org default basis + report basis labeling               | M    | 154        |
| **OB-157** | Statement of Cash Flows (indirect)                      | L    | M2         |
| **OB-158** | Cash-flow projection                                    | L    | M3, INV    |
| **OB-159** | `/v1` + report viewers                                  | M    | 154–158    |
| **OB-160** | Property/mutation suite                                 | L    | 154, 157   |
| **OB-161** | E2E: cash-basis P&L + cash flow across partial payments | M    | 159        |

**Critical path:** 154 → 156 → 157 → 160 → 161. OB-154 (the transform) is the load-bearing change and
gets the mutation testing the posting kernel got.

---

## Fixed assets & recurring journals

Depreciation and amortisation, plus the recurring-journal machinery they ride on — both on the OB-127
scheduler and the draft-vs-auto-approve pattern ([D-76](#d-76)). Criteria **L**; tickets OB-162…OB-169.

**BUILT — gate-green (2,566 tests / 235 files), commits `7b37503…6166d53`.** All 8 tickets (OB-162…169,
criteria L1–L6) shipped via orchestrated fan-out — foundation (`0014_fixed_assets` schema + in-place
`org_accounting_settings` depreciation columns + 4 permission keys, catalog 56→60) → two parallel service
streams (recurring-journal GL templates + sweep; fixed-asset register → pure schedule compute →
depreciation sweep → disposal) → `/v1` routes + OpenAPI/client → two parallel web screens → property suite

- E2E, each wave integrated through `yarn check`. What's in: `recurring_journal_templates`(+`_lines`),
  `fixed_assets`, `fixed_asset_schedule` (all mutable); a **pure** `computeDepreciationSchedule` (straight-line
- declining-balance, final-period true-up so **Σ = cost − salvage**, L6) posted by a daily depreciation
  sweep idempotent on `posted_journal_id` (L3); recurring GL templates posted (or drafted, D-76) each period
  by their own sweep, both under `runAsAutomation` with source `'depreciation'`/`'disposal'`/`'recurring'`
  (free VARCHAR, no ALTER); full disposal ([D-116](#d-116)) recognising gain/loss vs proceeds and voiding the
  remaining schedule; per-asset account nominations defaulting from new org settings ([D-115](#d-115), no
  contra flag — an ordinary asset/credit account); the `/recurring-journals` and `/fixed-assets` screens; and
  the DB property/concurrency suite proving the sum invariant across the bigint/string round-trip and both
  sweeps' once-per-period guards **under real contention** (parked transaction, observed not-settled). Five
  forks settled up front ([D-113](#d-113)…[D-117](#d-117)): depreciation as a precomputed schedule table (not
  a fixed template), SL+DB methods, per-asset accounts defaulted from org settings, full-only disposal, and
  two config key-pairs with no SoD. Integration caught **two real seam issues the isolated streams couldn't**:
  a schedule-row id the fixed-asset stream assumed was `BIGINT AUTO_INCREMENT` but the authoritative schema
  made a `BINARY(16)` UUID, and the disposal contract needing proceeds + gain/loss account seams the original
  `{date, proceedsMinor}` couldn't express. **Deliberate scope edges, flagged:** recurring GL is fixed-amount
  lines only ([D-90](#d-90)); methods SL+DB only; full disposal only; no mid-life re-forecast once a period
  has posted (method/life change is disposal + re-register); the E2E is authored `yarn check`-clean but run by
  `yarn e2e`, not the gate ([D-26](#d-26)), and asserts materialisation as `run-due-work → 200 + runDate` (the
  in-process queue resolves the enqueue before the job settles). **M is now built too (see [Procure-to-pay](#procure-to-pay--pre-sale--pos-estimates-expenses)); next: N, P — [Release plan](#release-plan--post-m4-sequencing) phase 6.**

### Definition of done

An org registers an asset (cost, method, life, in-service date); the system computes the schedule and
posts monthly depreciation/amortisation journals — auto-approved by default, draft on request, system-
actor provenance ([D-89](#d-89)). Disposal posts the gain/loss. Independently, a **recurring GL entry**
([D-90](#d-90)) — a scheduled fixed-or-formula journal — covers prepaid amortisation, accruals and
deferred-revenue recognition on the same scheduler.

| #   | Acceptance criterion                                                                          | Verified by    |
| --- | --------------------------------------------------------------------------------------------- | -------------- |
| L1  | A recurring GL template posts its journal each period; auto-approve default, draft on request | OB-162, OB-168 |
| L2  | A registered asset computes a depreciation/amortisation schedule (straight-line, declining)   | OB-164, OB-168 |
| L3  | Scheduled periods post depreciation via a recurring journal, once per period (idempotent)     | OB-165, OB-168 |
| L4  | Disposal posts the gain/loss and stops the schedule                                           | OB-166         |
| L5  | Every automated post carries system-actor provenance (spec §6)                                | OB-162, OB-165 |
| L6  | Schedule totals equal cost less residual; property-tested                                     | OB-168         |

### Ticket board

| ID         | Title                                                   | Size | Depends on |
| ---------- | ------------------------------------------------------- | ---- | ---------- |
| **OB-162** | Recurring GL entry (scheduled journal template)         | M    | OB-127     |
| **OB-163** | Fixed-asset register + schema                           | M    | —          |
| **OB-164** | Depreciation/amortisation schedule computation          | L    | 163        |
| **OB-165** | Scheduled posting of depreciation via recurring journal | M    | 162, 164   |
| **OB-166** | Disposal (gain/loss)                                    | M    | 164        |
| **OB-167** | `/v1` + screens                                         | L    | 162–166    |
| **OB-168** | Property suite (schedule sums; recurring idempotency)   | M    | 165        |
| **OB-169** | E2E                                                     | M    | 167        |

**Critical path:** 162 → 164 → 165 → 168 → 169.

### L execution — dev-ready, parallelised

The prose above is criteria + tickets; this is the seam-pinned build plan (the PAY/CA/PB "decide
before you fan out" discipline). L is **greenfield** (no fixed-asset/depreciation code — grep-confirmed)
and **reuse-heavy**: the OB-127 scheduler, `runAsAutomation`, the recurring-invoice engine,
`postJournal`'s free-form `source`, `org_accounting_settings`' nomination pattern, and the chart's
existing contra-account support all carry it.

#### Seams that already exist — reuse verbatim

| Need                                    | Reuse (symbol @ path)                                                                                                                                                                                          | How L uses it                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduler enrolment                     | `registerDailyTask(queue)` + `queue.subscribe` @ `modules/scheduling` (`tick.ts`); wired in `entrypoints/{worker,api}.ts`                                                                                      | Each new sweep (recurring-journal, depreciation) calls `registerDailyTask` — that single call makes `run-due-work` fan to it. Wire both into `worker.ts`+`api.ts` beside recurring/dunning/poll.             |
| System-actor post (D-89)                | `runAsAutomation(orgId, actorId, ctx=>…)` @ `modules/scheduling/automation.ts:45`                                                                                                                              | Runs under Owner role; sets `actorType:'automation'`, `actorId=<template/schedule id>`, and **leaves `invocationMode` unset** (agent-only per `chk_journals_invocation_mode`, `0002_ledger.ts:391`).         |
| Due-sweep + once-per-period idempotency | recurring engine @ `modules/invoicing/recurring/engine.ts` (`selectDueTemplates(systemDb(), runDate)` → per-row `runAsAutomation` → `materializeCycle`: `FOR UPDATE` reload + `last_run === dispatched cycle`) | The template for both L sweeps. Depreciation's idempotency key is the schedule row's `posted_journal_id IS NULL` under `FOR UPDATE` — one journal per row.                                                   |
| Draft vs auto-post (D-76)               | `materialization_mode ∈ {draft,approved}` @ `0008_recurring_dunning`; engine `createInvoice` then conditionally `approveInvoice`                                                                               | Recurring GL mirrors it: `posted` → `postJournal` directly; `draft` → a `journal_drafts` row (M2) for a human to post.                                                                                       |
| The journal post                        | `postJournal(input, ctx)` @ `modules/ledger/posting.service.ts:115`; `source` a free `VARCHAR(32)` (`0002_ledger.ts:370`)                                                                                      | Depreciation posts `source:'depreciation'`, disposal `'disposal'`, recurring GL `'recurring'` — **no ENUM ALTER, no shared-types change** (≤32 chars). Server-internal call, like `payments.service.ts:153`. |
| Account nomination                      | `updateControlAccounts`/`resolveControlAccount` @ `modules/settings/control-accounts.ts` (gated `orgs.write`/`orgs.read`; required-type + active check, re-checked at use)                                     | New `org_accounting_settings` columns for org-default depreciation-expense (→`expense`) and accumulated-depreciation (→`asset`) accounts, following the `discount_*` in-place precedent (D-15).              |
| Contra-asset                            | chart `type`/`normal_balance` independent (`0002_ledger.ts:86`, no CHECK)                                                                                                                                      | Accumulated depreciation is an ordinary account `type:'asset'`,`normalBalance:'credit'` — no contra flag; reports flip off `type` not `normal_balance`, so it renders correctly.                             |
| Disposal                                | `postJournal` (fresh), NOT `reverseJournal`                                                                                                                                                                    | Disposal is a new journal recognizing gain/loss vs proceeds; it never touches the acquisition journal.                                                                                                       |

#### Forks settled ([D-113](#d-113)…[D-117](#d-117))

- **[D-113](#d-113) — depreciation is a precomputed schedule table posted by its own scheduled job, not a
  fixed recurring template.** Declining-balance amounts vary per period, so a fixed-line template cannot
  express them. Registration computes a `fixed_asset_schedule` (one row per period); a depreciation sweep
  posts the earliest unposted row whose `period_date ≤ runDate`, idempotent on `posted_journal_id`.
  Recurring GL entries and depreciation are **two distinct due-work sources on the one scheduler**.
- **[D-114](#d-114) — methods: straight-line + declining-balance, with salvage.** SL = `(cost − salvage)/life`
  per period; DB = `rate × book value`, floored at salvage, with the **final period truing up so
  Σ = cost − salvage** (L6). Units-of-production deferred.
- **[D-115](#d-115) — per-asset account nominations, defaulted from org settings.** Each asset names its cost,
  accumulated-depreciation, and depreciation-expense accounts, defaulted from the new
  `org_accounting_settings` columns when set. Accumulated depreciation is an ordinary asset/credit account —
  the chart already allows it, so no contra flag.
- **[D-116](#d-116) — disposal is full-only, a fresh journal.** One journal (`source:'disposal'`) removes
  remaining cost + accumulated-to-date and recognizes gain/loss vs proceeds, flips the asset to `disposed`,
  and stops the schedule (unposted future rows voided). Partial disposal and impairment deferred.
- **[D-117](#d-117) — two new key pairs, no SoD.** `recurring_journals.read/write` and `fixed_assets.read/write`
  gate the two config surfaces; writes seeded owner+bookkeeper, reads reach the read-only roles via `%.read`.
  Automated posts run through `postJournal` under the automation's Owner role. Catalog 56→60. No owner-only
  split — unlike PB there is no separation-of-duties story here.

#### Schema — migration `0014_fixed_assets` (next free prefix)

New tenant tables, all **mutable** (settings/plans, not ledger facts — the immutable record is the
`journals` each posts):

- **`recurring_journal_templates`**: `id`, `org_id`, `name`, `memo`, `materialization_mode ENUM('draft','posted')`,
  `frequency ENUM('weekly','monthly','quarterly','yearly')`, `interval_count`, `next_run_date DATE`,
  `last_run_date DATE NULL`, `end_date DATE NULL`, `is_active`, author, timestamps; `KEY (org_id, is_active, next_run_date)`.
- **`recurring_journal_template_lines`**: `id`, `org_id`, `template_id` (CASCADE), `line_number`, `account_id`,
  `side ENUM('debit','credit')`, `amount_minor BIGINT`, `contact_id BINARY(16) NULL`, `description NULL`. Fixed
  amounts posted verbatim; the service asserts debits = credits before a template can activate.
- **`fixed_assets`**: `id`, `org_id`, `name`, `description NULL`, `asset_account_id`,
  `accumulated_depreciation_account_id`, `depreciation_expense_account_id` (composite FKs to `accounts`),
  `acquisition_cost_minor BIGINT`, `salvage_value_minor BIGINT`, `method ENUM('straight_line','declining_balance')`,
  `useful_life_months INT UNSIGNED`, `declining_rate_ppm INT UNSIGNED NULL`, `in_service_date DATE`,
  `status ENUM('active','disposed')`, `disposed_date DATE NULL`, `disposal_journal_id BINARY(16) NULL`, author, timestamps.
- **`fixed_asset_schedule`**: `id`, `org_id`, `fixed_asset_id` (CASCADE), `period_index INT`, `period_date DATE`,
  `depreciation_amount_minor BIGINT`, `posted_journal_id BINARY(16) NULL`; `KEY (org_id, posted_journal_id, period_date)`
  (the due index). `posted_journal_id` set = that period is done (idempotency).
- **In-place adds ([D-15](#d-15))**: `org_accounting_settings.depreciation_expense_account_id` /
  `.accumulated_depreciation_account_id` (`0005_subledger`) — nullable, composite FK, the `discount_*` precedent.
- Registries: `TENANT_TABLES` +4 · `MUTABLE_TABLES` +4 · `grants.test`/`tenant-scope` tripwires · codegen
  `generated.ts` (throwaway MySQL; `bigint` overrides for the four `*_minor` columns).
- **Permissions ([D-117](#d-117))**: `recurring_journals.read/write` + `fixed_assets.read/write` →
  `AssertCatalogSize<56>`→`<60>`; seed in `0001_tenancy` (writes owner+bookkeeper; reads via `%.read`);
  update catalog/resolution/permission-matrix/harness tripwires.

#### Contract-first seams (pin before fan-out)

- **Wire contracts** (`shared-types`): `recurringJournalTemplateSchema` (+ balanced lines), create/update;
  `fixedAssetSchema` + create/update; `fixedAssetScheduleSchema`; `disposeFixedAssetRequestSchema`
  (`{ date, proceedsMinor }`). No `.meta({ id })` until OB-167 wires routes (A10).
- **Two scheduled sweeps** each follow the recurring `job.ts`/`engine.ts` shape: a queue-name constant +
  `type Payload = DailyTaskPayload`, a `registerXxxJob(queue, deps)` doing `registerDailyTask` + `subscribe`,
  a `systemDb()` due-sweep, and a per-row `runAsAutomation` with a `FOR UPDATE` idempotency guard. Wire both
  into `entrypoints/worker.ts` + `entrypoints/api.ts`.
- **Schedule computation is pure** (OB-164): a deterministic `(cost, salvage, method, life, rate, inServiceDate)
→ readonly ScheduleRow[]` with `Σ amount === cost − salvage` — unit/property-tested standalone before any DB,
  the way the recurring `advance()` date math is.

#### Waves

| Wave                         | Tickets                                                                                                                                                                                                                                        | Deliverable                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **0 — Foundation** (orch)    | `0014` schema + `org_accounting_settings` in-place columns + 4 permission keys + registries + codegen · OB-162/163 wire contracts                                                                                                              | Owns codegen + the `0005` in-place edit + role reseed.                             |
| **1 — Services** (A ∥ B ∥ C) | **A** OB-162 recurring GL templates + sweep (reuse recurring engine) · **B** OB-163 register → OB-164 pure schedule compute → OB-165 depreciation sweep (spine) · **C** OB-166 disposal                                                        | OB-164's pure computation is the property anchor; OB-165 is the idempotency risk.  |
| **2 — Transport + screens**  | OB-167 `/v1` routes + Recurring-journals screen + Fixed-asset register/schedule/disposal screen                                                                                                                                                | New keys → permission-matrix + routes.test + cross-org move; openapi/client regen. |
| **3 — Verification**         | OB-168 property suite (Σ schedule = cost − salvage, both methods; recurring + depreciation once-per-period idempotency via `openAppConnection` re-run) · OB-169 E2E (register → auto-post a period → recurring GL posts → dispose → gain/loss) |                                                                                    |

**Critical path:** `0014` → OB-164 → OB-165 → OB-168 → OB-169. OB-162 is independent of the asset spine;
OB-166 pins against B's schema and integrates after it.

#### Tripwire / registry checklist

`db/tenant-tables.ts` (+4) · `0999_app_grants` `MUTABLE_TABLES` (+4) + `grants.test.ts` · `catalog.ts`
`PERMISSION_KEYS` (+4) `AssertCatalogSize<56>`→`<60>` + `0001_tenancy` seed + `catalog.test.ts` (56→60) +
`resolution.test.ts` (owner 56→60, bookkeeper +2, read_only/approver +2 via `%.read`) ·
**`permission-matrix.test.ts`** (4 new `GRANTED_TO` + OPERATIONS rows) · `harness.test.ts` (migration list +
catalog count) · route-table + openapi + web client + cross-org A7/B11 for the new id-taking routes ·
`generated.ts` via throwaway codegen.

#### Deliberate scope edges (flagged)

- **Recurring GL = fixed-amount lines only** ([D-90](#d-90)); a formula/percent-of-balance template is deferred
  — depreciation's varying amount is exactly why it is a schedule table, not a recurring template (D-113).
- **Methods SL + DB only** (D-114); units-of-production deferred.
- **Full disposal only** (D-116); partial disposal, impairment, and revaluation deferred.
- **No mid-life re-forecast in v1** — a schedule is recomputed on edit only while no period has posted; once
  posting has begun, a method/life change is a disposal + re-register (a true prospective re-forecast is a follow-up).
- Scheduler is **non-durable across restart** (single in-process clock, [D-49](#d-49)) — idempotency is what
  makes a missed or duplicated tick safe, exactly as for recurring invoices.

---

## Procure-to-pay & pre-sale — POs, estimates, expenses

**Built — gate-green (2,627 tests / 244 files), four commits `3726b85…0d8fb04`.** All ten tickets
(OB-170…179) shipped via orchestrated fan-out — trunk (schema `0015` + shared-types + permission
catalog) → four parallel services (expenses ‖ purchase-orders ‖ estimates ‖ send) → transport + the
A7/B11 enforcement wiring → three screens ‖ property suites → E2E — each wave integrated through
`yarn check`. What's in: `is_employee` as a third contact boolean ([D-91](#d-91)); `purchase_orders`/
`estimates` as non-posting pre-documents ([D-92](#d-92)) with their own `document_sequences` series,
that **convert-once** into a draft bill/invoice via the existing `createBill`/`createInvoice`; an
employee expense modelled as an `ap_documents` bill against an employee contact (the settled fork —
`requireEmployee` swaps in for `requireVendor`, the whole posting path is reused, and Pay Bills settles
it unchanged); a **lean send** (email + append-only `predocument_deliveries`, hosted page + PDF
deferred); seven permission keys (catalog 60→67) with `expenses.approve` a real SoD gate; 22 `/v1`
routes; and three web screens (`/purchase-orders`, `/estimates`, `/expenses`). Integration caught two
real issues the isolated authors couldn't: subagent-authored SQL comments used **raw backticks inside
the `sql` template literals**, closing the template early (four migrations); and `send.service.ts` gated on a
**computed** permission key the permission-matrix scanner is blind to (moved to literals in the public
wrappers). The E2E was executed (not just authored) against a throwaway migrated stack. **Deliberate
lean-v1 deferrals, all flagged:** PO/estimate hosted page + PDF ([D-M5](#where-things-stand) — reuse
INV's delivery stack); PO/estimate line **dimension tags** (D-M7 — a converted draft can have them
added before approval); no per-line tax-rate picker in the screens (`taxMode` hardcoded `'exclusive'`;
the full bill/invoice editor remains for taxed lines); an expense-bill also appears in the **Bills**
list (it is a bill) and shares the `'bill'` document-number series (so an expense reads as bill #N,
not a fresh #1 — confirmed by the E2E). **Receipt capture for reimbursements is a scoped follow-up**
(see [the follow-up note](#follow-up--receipt-capture-for-employee-expense-reimbursements-future) — the
bill-capture pipeline is vendor-only today and would branch to `createExpense`). **Next: N, P —
[Release plan](#release-plan--post-m4-sequencing) phase 6.**

The operational documents that sit **before** a bill or invoice: purchase orders (→ bill), estimates
(→ invoice), and employee expenses (→ reimbursement). Criteria **M**; tickets OB-170…OB-179.

Two shaping decisions: **POs and estimates are non-posting pre-documents** that carry lines and convert
into the posting document ([D-92](#d-92)) — they are operational, not ledger events, until converted;
and **employees are a new contact type** (`is_employee` beside `is_customer`/`is_vendor`,
[D-91](#d-91)) so an expense has an owner and a reimbursement a payee.

### Definition of done

A PO is raised, approved, sent, and converted to a bill carrying its lines. An estimate is sent to a
customer and converted to an invoice on acceptance. Neither posts a journal until it converts. An
employee submits expenses; approval creates a payable/reimbursement that Pay Bills settles.

| #   | Acceptance criterion                                                                       | Verified by    |
| --- | ------------------------------------------------------------------------------------------ | -------------- |
| M1  | A PO carries lines and **posts no journal**; converting it creates a bill with those lines | OB-171, OB-178 |
| M2  | An estimate posts no journal; converting it creates an invoice with those lines            | OB-172, OB-178 |
| M3  | Conversion is **once** — a converted pre-document cannot convert again (idempotent)        | OB-178         |
| M4  | **Employees** are a contact type; an expense names one, a reimbursement pays one           | OB-170, OB-174 |
| M5  | An approved expense creates a payable Pay Bills can settle                                 | OB-174         |
| M6  | POs and estimates carry their own numbering, distinct from bills/invoices                  | OB-171, OB-172 |
| M7  | Cross-org 404 holds for every new resource                                                 | OB-177         |
| M8  | Send/approve/convert are permission-gated                                                  | OB-177         |

### Ticket board

| ID         | Title                                                       | Size | Depends on |
| ---------- | ----------------------------------------------------------- | ---- | ---------- |
| **OB-170** | Employees as a contact type (`is_employee`) + schema        | M    | —          |
| **OB-171** | Purchase orders (non-posting) + convert-to-bill             | L    | M3         |
| **OB-172** | Estimates/quotes (non-posting) + convert-to-invoice         | L    | M3         |
| **OB-173** | PO approval + send (reuses hosted-page/email)               | M    | 171, INV   |
| **OB-174** | Employee expenses + reimbursement                           | L    | 170        |
| **OB-175** | `/v1` surface                                               | M    | 170–174    |
| **OB-176** | Screens                                                     | L    | 175        |
| **OB-177** | Enforcement/permissions matrix                              | M    | 175        |
| **OB-178** | Property (convert carries lines; no double-convert)         | M    | 171, 172   |
| **OB-179** | E2E: PO → bill, estimate → invoice, expense → reimbursement | M    | 176        |

**Critical path:** 170 → 171/172 → 174 → 176 → 179.

---

## Budgets

Budget figures by account (and dimension) per period, and budget-vs-actual reporting. **No ledger
effect** — a budget is a parallel plane compared against actuals ([D-94](#d-94)). Criteria **N**;
tickets OB-180…OB-184.

**N (Budgets) is now BUILT — gate-green (`yarn check`, 2,645 tests / 247 files).** All five tickets
(OB-180…184) shipped via orchestrated fan-out — Wave 0 trunk (`0016_budgets` schema + shared-types +
the `budgets.read`/`budgets.write` pair, catalog 67→69 + codegen against a throwaway migrated MySQL)
→ Wave 1 (budgets service ‖ budget-vs-actual report service, two authors) → Wave 2 (routes +
enforcement wiring: permission-matrix, cross-org A7/B11, OpenAPI, route-table, per-role counts) →
Wave 3 (Budgets entry screen ‖ Budget-vs-actual report view ‖ property suite) → Wave 4 (E2E), each
integrated through `yarn check`. The forks settled at scoping were built as decided — [D-N1](#d-n1)
(a budget row is `(account, period, optional dimension-value)` with a generated `dimension_slice`
column enforcing single-slot uniqueness), [D-N2](#d-n2) (P&L accounts only; balance-sheet budgeting
deferred), [D-N3](#d-n3) (basis-agnostic budget, basis-aware report; cash + slicing refused via the
P&L's own guard), [D-N4](#d-n4) (a single `periodId`, resolved to a date range), [D-N5](#d-n5)
("import" is the batch upsert, no server CSV parser), [D-N6](#d-n6) (`reports.read` for the report,
a new `budgets.read`/`budgets.write` pair for entry). **The property suite earned its keep** and
forced one new decision, [D-N7](#d-n7): it caught that a per-slice budget on a dimension value with
_zero_ ledger activity vanished from a grouped report (the actuals core emits a bucket only for
values with movement, so `project()` had no group to hang it on) while the ungrouped total still
counted it — a real B6 violation. Fixed by synthesising a zero-actuals group for every value a
budget names on the grouped axis; the property then holds with its generator workaround removed.
**Deliberate v1 edges, flagged:** balance-sheet budgeting is out (D-N2); a YTD / period-range
variant is a follow-up (D-N4, the report takes one period); cash basis combined with a dimension
filter or `groupBy` is refused, not supported (D-N3); and the E2E (`budgets.spec.ts`) is authored
`yarn check`-clean and stack-runnable but not run by the gate (which is `yarn e2e`), like every other
milestone narrative. The budget-vs-actual report view has no in-tab basis control — it reads basis
from the shared report filter state (set on another report tab), the same shape `cash-flow-projection`
takes; extending `controls.tsx` with a period-plus-basis toolbar is a UI follow-up.

### Definition of done

An org enters (or imports) budget amounts by account/dimension/period; a budget-vs-actual report
compares them to ledger actuals with variance, on the org's basis.

| #   | Acceptance criterion                                                         | Verified by    |
| --- | ---------------------------------------------------------------------------- | -------------- |
| N1  | Budget amounts are entered by account/dimension/period; **no journal posts** | OB-180, OB-181 |
| N2  | Budget-vs-actual compares budget to ledger actuals with variance             | OB-182         |
| N3  | The report honours the org's reporting basis and dimension filters           | OB-182         |
| N4  | Cross-org 404 and permission-gating hold                                     | OB-184         |

### Ticket board

| ID         | Title                                    | Size | Depends on |
| ---------- | ---------------------------------------- | ---- | ---------- |
| **OB-180** | Budget schema (account/dimension/period) | M    | —          |
| **OB-181** | Budget service (enter/import)            | M    | 180        |
| **OB-182** | Budget-vs-actual report                  | M    | 181, K     |
| **OB-183** | `/v1` + screen                           | M    | 182        |
| **OB-184** | Tests + E2E                              | S    | 183        |

**Critical path:** 180 → 181 → 182 → 184.

### N execution — built

Budgets sat almost entirely on **existing seams** — the actuals aggregation (K/OB-041), the periods
model, accounts, and dimensions. The only genuinely new things were a `budgets` table and a thin
service; the report is a projection of `getAccountBalances`. The forks below were settled so the
build could start cold, and were built as decided (with the one build-time addition, D-N7).

**Forks settled and built as D-N1…D-N6; D-N7 was forced by the property suite during the build:**

- <a id="d-n1"></a>**D-N1 — a budget row is `(account, period, optional dimension-value)` → an amount.** Table `budgets`
  keyed by `(org_id, account_id, period_id, dimension_value_id?)`. A NULL dimension is the
  **account-total** budget for the period; a non-null is a **per-slice** budget (B6 "slices +
  unassigned = whole", the same shape the ledger's dimension grouping already takes). No ledger
  effect (D-94). MySQL treats NULLs as distinct in a UNIQUE index, so uniqueness of the account-total
  row is DB-enforced with a **generated stored column** `dimension_slice BINARY(16) AS
(COALESCE(dimension_value_id, 0x{16 zero bytes})) STORED`, `UNIQUE (org_id, account_id, period_id,
dimension_slice)`. (Alternative if the team dislikes a generated column: enforce single-slot in the
  service under a `FOR UPDATE` read — but the generated column is the honest DB-level answer.) The
  service is **upsert** (`setBudget` replaces the matching slot).
- <a id="d-n2"></a>**D-N2 — v1 budgets are P&L only (revenue + expense accounts).** Movement of a P&L account over a
  period is that period's P&L contribution — an unambiguous budget target. Balance-sheet budgeting is
  deferred (flag it). The service validates the account exists + is active + `type IN
('revenue','expense')` via the `assertAccountsPostable`/`selectPostableAccounts` pattern
  (`ledger/posting.service.ts:402`, `posting.repository.ts:102`).
- <a id="d-n3"></a>**D-N3 — a budget is basis-agnostic; the report is basis-aware.** A budget is one number; the report
  compares it to actuals resolved on the org's basis. `resolveBasis(ctx, requestBasis)` (copy
  `profit-and-loss.service.ts:163`, reading `org_accounting_settings.default_reporting_basis`), then
  `getAccountBalances(query, ctx, { basis })`. Variance = `budget − actual` using the P&L sign
  convention `statementAmount(type, movement)` (`profit-and-loss.service.ts:269`). **Cash-basis + a
  dimension `groupBy` is unsupported** (the cash-basis path forbids slicing and returns
  `groupValueId: null` — `assertCashBasisSupported`, P&L service :182), so a dimension-grouped
  budget-vs-actual is **accrual-only** in v1 — the report reuses that same guard. Flag.
- <a id="d-n4"></a>**D-N4 — v1 report takes a single `periodId`.** Resolve it to `{startDate,endDate}` via `getPeriod`
  (`periods.service.ts:192`) and pass as `from`/`to` (the aggregation only speaks calendar dates — no
  report takes a `period_id`). Sum the budget rows for that period. A YTD / period-range variant is a
  follow-up.
- <a id="d-n5"></a>**D-N5 — "import" is the batch write, not a CSV parser.** The budget write endpoint accepts an
  **array** of `{ accountId, periodId, dimensionValueId?, amount }` and upserts each — that is the
  import primitive. A CSV/paste UI is a screen-side follow-up on top of it; no server CSV parser in v1.
- <a id="d-n6"></a>**D-N6 — reuse `reports.read`; add a `budgets.read`/`budgets.write` pair for the entry surface.**
  The budget-vs-actual **report** gates on `reports.read` (every report does; the service self-checks,
  the route only `requireOrgScope`). Entering/importing budgets is a distinct capability →
  `budgets.read`/`budgets.write` (catalog 67 → **69**). `budgets.write` to owner + bookkeeper;
  `budgets.read` reaches read_only/approver via `%.read` automatically. Not to ap_only/ar_only.
- <a id="d-n7"></a>**D-N7 — a grouped report synthesises a group for every budgeted value, not only the ones with
  actuals (built-time addition).** `getAccountBalances` emits a dimension-value bucket only for a
  value with non-zero movement in the window (the unassigned bucket alone is dense), so the first
  cut of `budget-vs-actual.service.ts` — which iterated the actuals groups — silently dropped a
  per-slice budget entered against a value that had **no** ledger activity yet (a department
  budgeted before its first transaction), while the ungrouped total still counted it. That is B6
  being false, and the property suite caught it. The report now takes the **union** of the actuals
  buckets and every value a budget names on the grouped axis, synthesising a zero-actuals group
  (the dense chart, every balance zeroed) for each budget-only value, ordered value-code with
  unassigned last exactly as the core would have. A build refinement to D-N4 belongs here too: the
  period is resolved by reading `fiscal_periods` directly through `orgScope`, **not** via `getPeriod`
  — a report must not require `periods.read`, and the direct read is the same A7 404 for a cross-org
  period.

**Schema — `0016_budgets` (author against `0015_procure_to_pay` + `0002_ledger`):** one MUTABLE table
`budgets`: `id` BIN(16) PK · `org_id` NN · `account_id` NN · `period_id` NN · `dimension_id` NULL ·
`dimension_value_id` NULL · `dimension_slice` BIN(16) generated-stored (above) · `amount_minor` BIGINT
NN (no default) · `created_by_user_id` NN · `created_at`/`updated_at`. FKs: org CASCADE;
`(org_id, account_id)`→accounts RESTRICT; `(org_id, period_id)`→fiscal_periods RESTRICT;
`(org_id, dimension_id, dimension_value_id)`→dimension_values`(org_id, dimension_id, id)` RESTRICT
(the 3-col axis-locked FK every line-dimension table uses); author→users RESTRICT. CHECK
`chk_budgets_dimension_pairing ((dimension_id IS NULL) = (dimension_value_id IS NULL))`. Keys:
`uq_budgets_org_id (org_id,id)`, `uq_budgets_slot (org_id, account_id, period_id, dimension_slice)`,
`idx_budgets_org_period (org_id, period_id)`.

**Tripwire checklist (all confirmed current; the M checklist one milestone on):** register in
`db/migrations/index.ts` (before `0999`); add `budgets` to `TENANT_TABLES` (`db/tenant-tables.ts`,
sorted — compile-enforced) and to `MUTABLE_TABLES` (`0999_app_grants.ts`); add `'0016_budgets'` to the
`harness.test.ts` migration list and `budgets` to the `tenant-scope.test.ts` sorted literal
(`grants.test.ts` parses the migration — no edit); `codegen.mjs` override `'budgets.amount_minor':
'bigint'` (and confirm the generated `dimension_slice` column is typed `Generated<Buffer>` and omitted
from inserts — the one codegen wrinkle to verify on a throwaway migrated DB). Permissions: append
`budgets.read`/`budgets.write` to `catalog.ts` and bump `AssertCatalogSize<67>`→`<69>`; seed both in
`0001_tenancy.ts` + add `budgets.write` to owner/bookkeeper (owner auto; bookkeeper via catch-all —
do NOT exclude); bump `catalog.test.ts` (67→69) and `harness.test.ts` (67→69); add `GRANTED_TO` +
`OPERATIONS` rows in `permission-matrix.test.ts` and A7 SURFACES + B11 reference rows in the cross-org
suites for the new resource-id routes.

**Shared-types + service + report:**

- `shared-types/src/budgets/`: `budgetSchema` (`.meta({id:'Budget'})`), `setBudgetsRequestSchema`
  (the batch upsert — array of entries), `listBudgetsQuerySchema` (by period/account), and
  `budgetVsActualSchema` (`.meta({id:'BudgetVsActual'})`: grouped like `ProfitAndLoss` — per account
  `{ code, name, type, budget, actual, variance, variancePercent }`, section totals, echoed `basis`)
  - its querystring (`{ periodId, basis?, dimensions?, groupBy? }`, dimensions as url-encoded JSON like
    P&L). Put budget response schemas here; querystrings carry no `id`.
- `modules/budgets/`: `budgets.repository.ts` (upsert into the slot, list, delete) + `budgets.service.ts`
  (`setBudgets` batch upsert with account/period/dimension validation, `listBudgets`, `deleteBudget` —
  all `budgets.write`/`budgets.read`). `modules/reports/budget-vs-actual.service.ts`
  (`getBudgetVsActual` — `reports.read`; resolveBasis → getAccountBalances → join budget rows → variance).
- Transport: `routes/budgets.ts` (`setBudgets` POST `/v1/budgets` batch, `listBudgets` GET,
  `deleteBudget` DELETE `/v1/budgets/{budgetId}`) + a `getBudgetVsActual` GET
  `/v1/reports/budget-vs-actual` added to `routes/reports.ts`. Orchestrator regens `openapi.json` + web
  client.
- Web: a **Budgets** entry screen (grid: accounts × the period's amount, with a dimension selector;
  save = one `setBudgets` batch) under `budgets.read`, and a **Budget vs actual** report view reusing
  `screens/reports/statement.tsx` `StatementSection` + `filters.ts` encoders (add a period picker).

**Wave plan** (mirrors M): Wave 0 trunk = `0016` + shared-types + the two permission keys + codegen +
gate. Wave 1 = budgets service ‖ budget-vs-actual report service (2 authors). Wave 2 = routes +
enforcement wiring (matrix/cross-org/openapi). Wave 3 = 2 screens ‖ property test (variance arithmetic;
slices+unassigned=whole vs the account total). Wave 4 = E2E (enter a budget → post actuals → the report
shows the exact variance, cents-exact, on both bases). Each wave gated through `yarn check`.

**Codegen note:** pre-release a DB cannot take `0016` incrementally (it sorts before applied `0999`),
so run `yarn codegen` against a **throwaway** MySQL migrated fresh with the full set — start a
`mysql:8.4` container mounting `docker/mysql-init` on a spare port, `yarn migrate`, `yarn codegen`,
tear it down (the M build's proven procedure — the persistent `openbooks-mysql-1` on 13307 is already
migrated and will refuse an out-of-order migration).

---

## Bill capture (OCR)

**Built — gate-green.** Snap or forward a bill/receipt, extract it, and **propose a draft bill/expense**
for review. Rides the StorageProvider (built in Invoicing), the worker, and the propose-then-post
pattern ([D-95](#d-95)). Criteria **O**; tickets OB-185…OB-191, all done. The "proposal" is a
`document_captures` staging row, not a new proposal machine — the draft `ap_documents` bill it becomes
(at human review) is the uncommitted container, and `approveBill` is the post. `DocumentExtractionProvider`
(deterministic self-host now, `anthropic` deferred) and `InboundMailProvider` (`dev` webhook now,
`ses-inbound` deferred) ship as config-selected seams; real hosted MX/receipt-rule receiving and a live
LLM adapter are the credential-gated follow-ups. Reuses `bills.read`/`bills.write`. See the top-of-file
"Where things stand" for the build note.

### Definition of done

A document arrives (upload or a per-org email-in address), is stored, and a `DocumentExtractionProvider`
(LLM-capable) extracts vendor/date/amount/tax/lines into a **draft** bill or expense — vendor matched
to a contact, duplicates guarded by the existing `duplicate_vendor_reference` rule. A human reviews and
posts; the original stays **attached** to the bill.

| #   | Acceptance criterion                                                      | Verified by |
| --- | ------------------------------------------------------------------------- | ----------- |
| O1  | A captured document is stored and extracted into a **draft** bill/expense | OB-187      |
| O2  | Capture channels: **upload** and a **per-org email-in** address           | OB-186      |
| O3  | Extraction **proposes**, never posts — a human commits ([D-43](#d-43))    | OB-187      |
| O4  | Vendor is matched to a contact; a **duplicate** capture is flagged        | OB-187      |
| O5  | The original document is **attached** to the posted bill                  | OB-188      |
| O6  | The extraction provider is swappable (interface + LLM adapter)            | OB-185      |

### Ticket board

| ID         | Title                                                              | Size | Depends on   |
| ---------- | ------------------------------------------------------------------ | ---- | ------------ |
| **OB-185** | `DocumentExtractionProvider` interface + LLM adapter + config      | L    | —            |
| **OB-186** | Capture channels: upload + per-org email-in                        | M    | INV(storage) |
| **OB-187** | Extraction → draft bill/expense proposal (vendor match, dup guard) | L    | 185, 186     |
| **OB-188** | Transaction attachments (original on the bill)                     | M    | INV(storage) |
| **OB-189** | `/v1` + review screen                                              | M    | 187          |
| **OB-190** | Tests                                                              | M    | 187          |
| **OB-191** | E2E: forward a bill → draft → review → post                        | M    | 189          |

**Critical path:** 185 → 187 → 189 → 191.

---

## Accountant access & period close

Accountants as a **granted user type** (not a firm tier, [D-96](#d-96)), plus the workflow that hangs
off their access: period close, adjusting entries, statement packages, and a surfaced audit trail.
Criteria **P**; tickets OB-192…OB-199.

**Status — BUILT, gate-green (`yarn check`, 2,689 tests / 252 files).** All eight tickets shipped via
orchestrated fan-out — trunk (schema `0017_accountant_close` + catalog + the `accountant` role seed +
pinned wire contracts) → parallel services (period-close workflow, statement package, audit report) →
transport + web → tripwires + E2E. What's in: the seeded **`accountant`** system role (UUID `…0007`,
a **pre-baked permission bundle**, not a special user type — every capability is a plain permission key
under the generic `requirePermission`), assigned through the existing invite flow; the **advisory**
close workflow (`GET …/close-checklist` computes unposted-drafts / unreconciled-lines / prior-period
checks, and `closePeriod`/`reopenPeriod` recompute + record the snapshot and an optional note to the
append-only `period_close_events`, [D-97](#d-97)); **adjusting/reclassifying** entries flagged on
`journals.source` (no new column, no kernel change — an `entryType` rides the **draft** flow, since the
manual-JE UI posts through drafts, and `postDraft` maps it to `source`); the branded **statement
package** (`POST /v1/statement-packages` renders P&L/BS/cash-flow to one pdfmake PDF, stored behind the
StorageProvider, `statement_packages` append-only, [D-98](#d-98)'s P5); and the **audit report**
(`GET /v1/reports/audit`, a keyset timeline unifying journal provenance + close events, one new catalog
key `audit.read`, 69→70). Web: close checklist + sign-off dialog on the periods settings, a Statement
Packages screen, an Audit tab in Reports, and the Entry-type toggle on the JE editor. E2E
`accountant-and-close.spec.ts` (authored, `yarn check`-clean, not gate-run — the gate is `yarn e2e`).
One owner decision recorded during the build: the accountant ships as a **pre-baked bundle**; a
**custom role builder** (admin-composed per-org roles over the catalog) is the deferred follow-up
(the schema's `roles.org_id` path already reserves it) — see the follow-up under the ticket board.

### Definition of done

An org owner grants an external user the seeded **`accountant`** role — broad read, adjusting/reclass
JEs, run and close periods, statement packages, audit trail — revocable, scoped to that org, reusing
the existing invite/membership flow. A **period-close workflow** ([D-97](#d-97)) runs a checklist,
locks the period, and records sign-off. Adjusting entries are flagged as such. The actor provenance
already on every journal is surfaced as a **who-changed-what** audit report ([D-98](#d-98)).

| #   | Acceptance criterion                                                             | Verified by    |
| --- | -------------------------------------------------------------------------------- | -------------- |
| P1  | An owner grants/revokes the `accountant` role via the existing invite flow       | OB-192         |
| P2  | The role holds read + adjusting JEs + period close + statements + audit; not ops | OB-192, OB-198 |
| P3  | A close workflow runs a checklist, **locks** the period, records **sign-off**    | OB-193         |
| P4  | Adjusting/reclassifying entries are **flagged** as such                          | OB-194         |
| P5  | A statement package renders a branded P&L/BS/cash-flow bundle to PDF             | OB-195         |
| P6  | An audit report surfaces existing actor provenance (who changed what, when)      | OB-196         |
| P7  | Access stays org-scoped — an accountant sees only granted orgs (tenancy holds)   | OB-198         |

### Ticket board

| ID         | Title                                                   | Size | Depends on  |
| ---------- | ------------------------------------------------------- | ---- | ----------- |
| **OB-192** | `accountant` role (seed + permissions) + grant/revoke   | M    | M2          |
| **OB-193** | Period-close workflow (checklist, lock, sign-off)       | L    | M1(periods) |
| **OB-194** | Adjusting/reclassifying entries (flagged)               | M    | M2          |
| **OB-195** | Statement packages (branded P&L/BS/cash-flow → PDF)     | M    | INV, K      |
| **OB-196** | Audit-trail report (surface provenance)                 | M    | M1          |
| **OB-197** | `/v1` + screens                                         | L    | 192–196     |
| **OB-198** | Enforcement/permission matrix                           | M    | 197         |
| **OB-199** | E2E: grant accountant → adjust → close → statement pack | M    | 197         |

**Critical path:** 192 → 193 → 195 → 199.

**Follow-up — a custom role builder (deferred, decided during P build).** The
`accountant` role ships as a **pre-baked bundle** (a 7th seeded system role, an admin
assigns it through the existing invite flow), because v1 has no way for an admin to
compose a role from the permission catalog. The reserved path already exists in the
schema — `roles.org_id` is non-null for a per-org custom role (`uq_roles_org_code`,
`0001_tenancy`), and the whole enforcement stack is already generic
`requirePermission(ctx, key)` with no role-specific code — so what is missing is only
the service + screen that let an admin create a per-org role and tick the exact keys
(and assign it via the existing membership flow). Until it lands, the seeded bundles
are the only assignable roles; every P capability is a plain permission key
(`periods.close`/`reopen`, `journals.post` + the `source:'adjusting'` flag,
`reports.read`, `audit.read`) that a custom-role builder would let an admin mix freely.
Owner request: an accountant should be a regular user whose permissions an admin sets,
which the pre-baked bundle approximates and a role builder would deliver fully.

---

## Automations (M6) — agent work queue, MCP-only

Realises the **M6** milestone as a **polled agent work queue driven by user-composed automations**. An
automation = a **trigger** + **actions**; one action type is an **agent task** that **enqueues a work
item** (prompt + context). OpenBooks holds **no model credentials and makes no inference call**
([D-100](#d-100)): the org's own agent authenticates via the M5 OAuth AS, **polls and leases** queued
items over MCP, runs inference on its own infrastructure, and **submits a structured proposal** back
through MCP. Proposals land in the M5 `agents.review` queue and a **human commits them — nothing
auto-posts** ([D-60](#d-60)/[D-99](#d-99)). The work queue is the substrate; producers across the app
enqueue items. Criteria **Q**; tickets OB-200…OB-210.

<a id="q"></a>

### Definition of done

An org connects its own agent as an MCP client over the M5 OAuth AS ([D-100](#d-100)) — **OpenBooks
stores no model config or credentials and never calls a model**. A user builds an automation: a trigger
(manual / scheduled / event) and actions — the v1 catalog is the **`annotate`** deterministic action
and the **agent-task** action ([D-119](#d-119)), which compose in order. Producers enqueue work items
(an ambiguous cash-basis JE, a captured bill, an uncategorised transaction) with a prompt that explains
the work. The org's agent **polls and leases** a queued item over MCP, runs inference on its own
infrastructure, and **submits a structured proposal** through MCP; the proposal lands in the M5
agent-review queue (OB-105) and a human approves/edits/posts. **Nothing auto-posts to the ledger**;
every proposal carries provenance (the submitting MCP client, the agent-attested model/prompt, and
when); a lease that expires without a submission **re-queues the item and flags it — never silently
dropped**; and the MCP surface **never returns a transport-broken shape** ([D-118](#d-118)).

| #   | Acceptance criterion                                                                                       | Verified by    |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| Q1  | An automation is a **trigger + actions** the user composes and owns                                        | OB-202, OB-208 |
| Q2  | Triggers cover **manual, scheduled (OB-127), and event** (the M5 bus)                                      | OB-205         |
| Q3  | An **agent-task** action **enqueues a work item** (prompt + context) — no in-process inference             | OB-203         |
| Q4  | Agent proposals **never post** to the ledger; a human commits them (OB-105)                                | OB-203, OB-209 |
| Q5  | Producers enqueue work items with a prompt + context (from events or rules)                                | OB-204         |
| Q6  | Every proposal carries **provenance**: submitting MCP client + agent-attested model/prompt/when            | OB-203, OB-209 |
| Q7  | A **lease expiry or failed submission** re-queues the item and flags it — never silently dropped           | OB-201, OB-209 |
| Q8  | OpenBooks holds **no model config or credentials** and makes **no inference call**                         | OB-201, OB-209 |
| Q9  | The **`annotate`** (deterministic) and **agent-task** actions **compose**, in order, in one automation     | OB-202, OB-210 |
| Q10 | Work items are **leased** so two agents never process the same item                                        | OB-201, OB-209 |
| Q11 | MCP **never returns a transport-broken shape**: errors ride HTTP 200 + typed `data.code` ([D-118](#d-118)) | OB-201, OB-209 |

### Ticket board

| ID         | Title                                                                                                                                               | Size | Depends on |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| **OB-200** | Work-queue schema (items, prompt, context, status, **lease/expiry**) + grants                                                                       | M    | —          |
| **OB-201** | MCP work-queue tools: **`poll`/lease + `submitProposal`** + hardened error envelopes ([D-118](#d-118))                                              | M    | 200, M5    |
| **OB-202** | Automation engine: trigger + ordered-actions model + the trivial **`annotate`** action ([D-119](#d-119))                                            | L    | 200        |
| **OB-203** | Agent-task action: **enqueue work item** (no model SDK, no secrets)                                                                                 | L    | 200, 202   |
| **OB-204** | Producers: enqueue from events (bus) + rules                                                                                                        | M    | 200, M5    |
| **OB-205** | Triggers: manual / scheduled (OB-127) / event                                                                                                       | M    | 202        |
| **OB-206** | Submitted proposal → agent-review queue (OB-105) integration                                                                                        | M    | 201, M5    |
| **OB-207** | `/v1` surface (automation CRUD + queue admin)                                                                                                       | M    | 202–206    |
| **OB-208** | Screens: automation builder + review queue                                                                                                          | L    | 207        |
| **OB-209** | Property/enforcement (never auto-posts; **single-grant lease**; idempotent; provenance; **MCP error shape**)                                        | L    | 207        |
| **OB-210** | E2E: an OCR-classify automation composes **[annotate, agent-task]** → item enqueues → **MCP agent polls/leases → submits proposal** → review → post | M    | 208, O     |

**Critical path:** 200 → 201 → 203 → 206 → 210. OB-201 (the poll/lease + submit MCP tools, with
transport-safe error envelopes) and OB-206 (the never-posts review gate) are the load-bearing pieces —
the MCP seam and the human-commit guarantee.

### Q execution — dev-ready, parallelised

Seam-pinned from four exploration passes. The reuse story is strong: **there is no proposals table —
the `agents.review` queue is a permission wrapper over `journal_drafts`, so a "proposal" _is_ a draft**
(`modules/agents/review.service.ts`, `modules/drafts/drafts.service.ts`). Q adds the queue + engine and
reuses everything downstream of the draft.

**The design in one paragraph.** A producer (an event-feed match or a manual/scheduled firing) runs an
automation's ordered actions under `runAsAutomation` (`modules/scheduling/automation.ts:45`): `annotate`
appends a note, `agent-task` inserts a `work_items` row (prompt + context, `status='queued'`). The org's
agent authenticates over the M5 OAuth AS, calls the MCP tool `work_queue.poll` (leases the next queued
item `FOR UPDATE`, `status='leased'`, lease token + expiry), runs inference on its own infra, and calls
`work_queue.submitProposal(leaseToken, draft, model?)` — which lands a `journal_drafts` row via the
existing `createDraft` (attributed to the agent's OAuth granting user, exactly as `journal.propose`
does), stamps the work item with `proposed_draft_id` + provenance, and sets `status='proposed'`. The
draft shows in the existing `agents.review` queue; a human `approveProposal` → `postDraft` posts it. An
expired lease re-queues the item and increments `attempts` (flagged past a threshold). Nothing in Q
calls `postJournal` — the only ledger write is the human's approve.

**Schema — `0018_automations` (three tables).** Composite-key tenancy (`(org_id, id)` uniques + FKs),
`BINARY(16)` plain-byte UUIDs, `DATETIME(3)` instants.

- `automations` — **MUTABLE, TENANT** config: `id, org_id, name, is_active, trigger_type
ENUM('manual','scheduled','event'), trigger_config JSON, actions JSON (ordered
`[{type:'annotate'|'agent_task', …}]`), last_fired_run_date DATE NULL (the scheduled-trigger
idempotency guard, cf. `recurring_invoice_templates.last_run_date`), created_by_user_id, created_at,
updated_at`.
- `work_items` — **MUTABLE, TENANT** queue with a status lifecycle + `FOR UPDATE` lease (so it is
  mutable, like `bank_statement_imports`/`pending_payment_intents`): `id, org_id, automation_id NULL,
run_token BINARY(16) NULL, source_kind, source_ref NULL, prompt, context JSON, status
ENUM('queued','leased','proposed','failed','cancelled') DEFAULT 'queued', lease_token BINARY(16) NULL,
leased_by NULL, leased_at NULL, lease_expires_at NULL, attempts INT UNSIGNED DEFAULT 0, flagged
TINYINT DEFAULT 0, proposed_draft_id BINARY(16) NULL (soft ref — a draft is deleted on post, so no
FK), agent_model NULL, submitted_by_client NULL, submitted_at NULL, last_error NULL, created_at,
updated_at`. Index `(org_id, status, created_at)` for FIFO poll.
- `automation_annotations` — **APPEND_ONLY, TENANT** (the `annotate` output): `id, org_id,
automation_id, run_token BINARY(16), note VARCHAR(512), created_at`. `run_token` ties a single firing's
  annotation to the `work_item` it composed with — the E2E asserts one firing yields both.

**codegen overrides** (`scripts/codegen.mjs`): only `automations.last_fired_run_date: 'string | null'`
(the one DATE). No money/BIGINT-counter columns → no other override. Codegen must still run to add the
three table interfaces to `generated.ts`.

**Permissions — reuse the reserved `workflows.*` triad; add nothing (catalog stays 70).** M1 already
seeded `workflows.read`/`workflows.write`/`workflows.activate` (`catalog.ts:94-96`, `0001_tenancy.ts:327`)
as catalog-only, "enforcement arrives with the named milestone" — that milestone is Q. The role bundles
are **already correct**: owner=read/write/activate, bookkeeper=read/write (activate excluded at
`0001_tenancy.ts:429`), read-roles/approver/accountant=read (via `%.read`). So Q enforces them and edits
no seed, no catalog size, no count assertion. The compose-vs-activate split is a real SoD, free from the
reserved `activate` gate: `workflows.write` = compose/edit an automation (created **inactive**);
`workflows.activate` (owner-only) = enable/disable `is_active` **and** manual "run now" (causing a firing
is the privileged act); `workflows.read` = list/get automations + work items, and the agent's `poll`
(the lease is the consumer read-claim — the coarse-key-covers-a-mechanical-write choice
`runDueWorkNow`=`invoices.write` already makes); `submitProposal` gates `journals.post` (reused, like
`journal.propose`). The **only** permission-layer change is moving the three keys from `LATENT_GRANTS`
→ `GRANTED_TO` in `permission-matrix.test.ts` and adding their `OPERATIONS` rows.

**MCP surface (OB-201) + host hardening (D-118).** Two new tools in `modules/mcp/tools.ts`
(`McpToolDefinition`, handler opens with `requirePermission`): `work_queue.poll` (execute-mode, leases;
**empty queue = 200 with an empty result, not 404**) and `work_queue.submit_proposal` (execute-mode; a
stale/expired lease returns a typed `data.code:'lease_expired'`/`'lease_invalid'`, HTTP 200). _As built,
its once-only guarantee is the lease-token row lock, not `withGlobalIdempotency` — the MCP host threads no
`Idempotency-Key` onto a `tools/call`, so the ambient key that mechanism reads is always null. A
`SELECT … WHERE lease_token = ? FOR UPDATE` + status check serialises concurrent submits on one lease and,
once accepted, the item leaves `'leased'`, so a **redelivery is refused (`lease_invalid`) rather than
replayed** — safe (never double-lands a draft), but not replay-idempotent. Threading a real idempotency
key through the MCP host, or keeping the lease token to replay the existing proposal, is the flagged
follow-up._ Provenance (`leased_by`/`submitted_by_client`) is recorded from `ctx.actorId` — the API-key
row id or the OAuth granting-user id, the closest the request context carries to an MCP client id. Host change: `toJsonRpcErrorResponse`/`host.ts:353` stop
propagating `wire.status` — **valid JSON-RPC envelope ⇒ constant HTTP 200**, failure in the `error`
object with a typed `data.code`; the `host.ts:351-352` logging split keys off `wire.status` not the
outgoing status; F5/F6 assertions in `platform-security.test.ts` (`:367`→200, `:467`→200) flip.

**Routes (`/v1`, hand-written Fastify `registerAutomationsRoutes`):** `POST /v1/automations` (write),
`GET /v1/automations` (read), `GET/PATCH /v1/automations/{id}` (read/write), `POST
/v1/automations/{id}/run` (manual trigger, write), `GET /v1/work-items` + `GET /v1/work-items/{id}`
(read), `POST /v1/work-items/{id}/cancel` (write). poll/submit are MCP-only, not `/v1`.

**Triggers/producers** (reuse the recurring-invoice template exactly — `registerDailyTask` +
`selectDue…(systemDb())` → per-row `runAsAutomation` → `FOR UPDATE` reload + dispatched-cycle guard):
manual = the run route; scheduled = a daily sweep over `automations` where `trigger_type='scheduled'`
guarded by `last_fired_run_date`; event = a `change_feed_cursors` subscriber (`subscriber='automations'`)
reading `readChangeFeed`/`event_log` on the tick, matching `trigger_type='event'` by event name, cursor
position the idempotency guard. The `registerEventRelay` seam stays as-is.

**Wave plan** (subagents author in worktrees against these contracts; the orchestrator owns foundation,
codegen, integration, and the gate):

| Wave                 | Stream          | Scope                                                                                                                                                                                                         | Touches                                                                                                                       |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **F (orchestrator)** | Foundation      | `0018` migration + `index.ts` registry; MUTABLE/APPEND/TENANT entries; **no permission-key changes** (reuse reserved `workflows.*`); shared-types `automations` domain (Zod → OpenAPI component ids); codegen | `db/migrations/0018*`, `index.ts`, `0999_app_grants.ts`, `tenant-tables.ts`, `shared-types/src/automations/*`, `generated.ts` |
| **1**                | A — MCP         | poll + submitProposal tools; host D-118 hardening; flip F5/F6                                                                                                                                                 | `modules/mcp/*`, `test/enforcement/platform-security.test.ts`                                                                 |
| **1**                | B — Backend     | engine (annotate + agent-task actions), service/repository, triggers, producers, `/v1` routes                                                                                                                 | `modules/automations/*`, `transport/routes/automations.ts` + `work-items.ts` + `index.ts`                                     |
| **2**                | C — Web         | automation builder + review-queue screens (recurring-invoices pattern)                                                                                                                                        | `web/src/screens/automations*`, `App.tsx`, `shell/nav.ts`                                                                     |
| **2**                | D — Verify      | `schema/q.test.ts`, `v1-q.test.ts`, property suites (single-grant lease contention; never-auto-posts; provenance; MCP-error matrix); tripwire updates                                                         | `test/**`                                                                                                                     |
| **3 (orchestrator)** | E2E + tripwires | `packages/e2e/tests/automations.spec.ts`; finalise permission-matrix/routes/openapi/cross-org tripwires; `yarn check`                                                                                         | `packages/e2e/*`, pinned tripwires                                                                                            |

**Pinned tripwire checklist (orchestrator finalises):** `grants.test.ts` (append-only literal +
partition), `tenant-scope.test.ts` (TENANT_TABLES literal), `harness.test.ts` (migration-name literal;
**permission count stays 70, roles stay seven**), `permission-matrix.test.ts` (move `workflows.*` from
`LATENT_GRANTS`→`GRANTED_TO` + `OPERATIONS` rows), `routes.test.ts` (operationId literal set),
`openapi.test.ts` (regenerate committed `openapi.json`, refs resolve), `cross-org.test.ts` (SURFACES rows
for `{id}` routes), `cross-org-references.test.ts` (REFERENCES for body/query ids), + new
`schema/q.test.ts`. **No `permissions/catalog.test.ts` change** (catalog unchanged at 70).

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
`0999_app_grants` allowlist for exactly that reason.

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

**Correction, found by building it (OB-043): there are two derived lines, not one.** B3 as
originally stated — `assets = liabilities + equity + current-year earnings` — holds only
for an org in its **first** fiscal year. With no closing journal anywhere, a prior year's
income is still sitting in the revenue and expense accounts, so a sheet carrying only the
current year's earnings is out of balance by exactly last year's profit. The identity that
holds for an org of any age is

```
assets = liabilities + equity + priorYearEarnings + currentYearEarnings
```

where `priorYearEarnings` is the revenue/expense `opening` — everything strictly before the
fiscal-year start — and `currentYearEarnings` is their `movement` within it. Neither is an
account. An org's own retained-earnings account is an ordinary equity account, counted once
in `equity` and never derived.

This also sharpens which line the future close must learn about. `currentYearEarnings` is
already safe, because it is scoped to a single fiscal year. It is `priorYearEarnings` whose
`from` bound has to become "since the last closed year end" rather than "since inception",
or a closed year is counted both in retained earnings and here. The constraint is recorded
at the top of `balance-sheet.service.ts` under a heading saying to read it before building
the close.

One measurement worth keeping: forcing the fiscal year to January **did not fail the
balance assertion**. A wrong year boundary moves money between the two derived lines
without changing their sum, so the sheet still foots. It was caught only by checking each
line against the trial balance at both ends of the year — which is why B2 is asserted per
row and not only in total.

<a id="d-21"></a>
**D-21 — Keyset pagination, not offset.** Offset pagination assumes the rows behind you do
not move. In an append-only ledger they do — entries arrive while a user pages through the
general ledger, and with `OFFSET` that shifts the window, so a row is skipped or shown
twice with nothing in the response indicating it happened. Keyset over a total ordering has
no such failure: `(entry_date, sequence_number)` for journals and the GL, `(created_at, id)`
elsewhere.

One extension, found by OB-044: those two columns are total over _journals_ and **not** over
a general ledger's rows, because one journal can post to the same account twice — an
allocation — and its two lines compare equal under both. The line-level read therefore keys
on `(entry_date, sequence_number, journal_lines.id)`. The third column is legitimate for the
same reason the first two are: `journal_lines.id` is `AUTO_INCREMENT` and the app user holds
no `UPDATE` on the table, so it cannot move under a cursor. The sequence number exists in part to make that ordering total (`entry_date`
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

<a id="d-33"></a>
**D-33 — The QuickBooks walkthrough is dropped; ACH Pro connectivity is not a v1
objective.** Spec §14 recommends walking ACH Pro's existing QBO integration before Phase 2
and Phase 4 endpoint design is frozen, on the argument that you own both ends and can fix
a mismatch on either side. That argument only pays if ACH Pro is a consumer v1 commits to
serving, and it is not. Designing AR/AP endpoints around one integrator's current shapes
would be fitting a public API to a private client — the same mistake in kind as
`plugin-api` being designed against a single consumer, which the roadmap already treats as
a known risk.

What declining it costs, stated rather than waved past: the walkthrough would have
surfaced how vendor and bill sync, payment recording, status writeback, and entity
correlation actually behave in a system that has run against real books. Those are M3's
hardest shapes, and M3 will now design them from the accounting model alone. That is the
right basis, but it is a _less informed_ one, and if ACH Pro integration is later wanted,
whatever mismatch exists will have to be absorbed on the ACH Pro side or in an adapter
rather than by having chosen differently here.

The reversible half is worth noting: nothing in M3 needs to be built _against_ QBO to be
compatible with it later. `external_refs` and the change feed are already M5's job (spec
§4), and they are the seam an integration would use. Dropping the walkthrough removes an
input to M3's design, not an option from M5's.

<a id="d-34"></a>
**D-34 — A subledger holds no balance.** An invoice does not carry what is outstanding on
it. The amount outstanding is its total minus the allocations applied to it, computed on
read, exactly as the trial balance is computed from journal lines rather than from a cache
(spec §2.1, §2.6).

This is not a performance choice deferred; it is the property C2 asserts. The moment an
invoice carries its own balance, there are two answers to "what does this customer owe" —
the subledger's and the ledger's — and they can disagree without anything being obviously
broken. Spec §11 names subledger agreement as an invariant precisely because that
divergence is the classic failure of accounting systems, and it is unfalsifiable when the
subledger is the thing being asked.

The cost is real and accepted: an aging report is an aggregation over documents and
allocations rather than a column read, and it will need indexes designed for it the way
`idx_jld_org_dimension_value` was (D-18). If it ever binds, the answer is a materialized
projection that is _rebuilt from_ the ledger and asserted against it — never a balance the
application maintains incrementally.

<a id="d-35"></a>
**D-35 — Tax is a per-org rate list, one rate per line, with the invoice declaring
inclusive or exclusive.** A rate is a named percentage posting to a nominated liability
account. A line carries at most one. An invoice states whether its unit prices already
include tax, and C5 asserts that both entry modes of the same economic invoice post
_identical_ journals — which is the only statement that makes the inclusive path
trustworthy, since it is the one where the arithmetic can silently lose a cent.

Rounding is where tax models go wrong, so it has one documented application point, as
money already does (D-13): tax is computed per line, rounded once per line, and the
invoice total is the sum of rounded lines — never the rounded sum, which disagrees with
what the customer can verify by adding up the page.

**C5's precondition, found by building the arithmetic rather than by reasoning about it.**
The criterion is true, but not unconditionally, and the boundary belongs here because a
test written without it would either fail or be quietly weakened until it passed.

Extraction and addition are exact in one direction only. Gross 7 at 50% extracts to net 5
and tax 2; adding 50% to a net of 5 gives tax 3. Both are correct roundings of different
rationals — the pair does not commute at that granularity, and no rounding rule fixes it,
because an inclusive unit price is itself whole cents (D-13).

With a fractional quantity the two modes therefore round different rationals. Divergence is
bounded at 2 cents when the inclusive unit price is exactly representable, and **grows with
the quantity** — roughly q/2 — when it is not. So C5 is asserted over entries whose line
extension is exact, which is every invoice a person actually types. The general case is not
a defect to be fixed but a fact about representing tax-inclusive prices in whole cents, and
it is written down so nobody spends a day proving it again.

Compound rates, multi-component rates (GST+PST), and jurisdiction rules are out. They are
correct for Canada and much of the US, and they are a subsystem rather than a feature —
scoping them into AR/AP would make M3 a tax milestone with invoicing attached.

<a id="d-36"></a>
**D-36 — Documents are numbered by a gapless per-org sequence, plus an optional free-text
reference.** The same mechanism and the same reasoning as [D-14](#d-14): the number is
what a customer, an auditor, and a bank statement cite, and a gap is indistinguishable
from a deleted document — which is precisely what an append-only system must never be
ambiguous about. Allocated from a counter row taken `FOR UPDATE` inside the transaction,
not `AUTO_INCREMENT`, which leaves gaps on rollback.

The sequence is **per org and per document type**: invoices, credit notes, bills and
vendor credits each count separately, because they are separate series to the people who
read them.

The free-text reference is a different field for a different job, and both are needed. On
an invoice it holds the customer's purchase-order number. On a **bill it holds the
vendor's own invoice number**, which is the number that matters on an AP document — we did
not issue it, and our sequence number is only our internal handle.

<a id="d-37"></a>
**D-37 — A payment is an amount received, and allocation is a separate fact.** A payment
records money moving; allocations record which documents it settles. Nothing requires them
to be equal at the moment the payment is recorded, and an unallocated remainder is a
**credit balance on the contact**, applicable later.

This models what actually happens: a deposit arrives before anyone has decided what it
settles, a customer rounds up, or one transfer pays three invoices. Requiring a payment to
fully apply would make all three unrecordable, and the workaround people reach for — a
suspense journal posted by hand — is exactly the un-auditable move the subledger exists to
replace.

Over-allocating a _document_ is refused (C3): allocations against one invoice may not
exceed it. Over-_paying_ is fine and lands as credit. The asymmetry is the point.

<a id="d-38"></a>
**D-38 — An invoice's lifecycle is draft → approved → (part-paid → paid), with void
alongside.** Only the approved transition posts a journal, and it is the one irreversible
step: before it, the document is editable and discardable exactly as a journal draft is
(D-16, D-19); after it, the ledger has been told.

Part-paid and paid are **derived from allocations, not stored** — they are D-34 applied to
status. A stored status is a second source of truth that drifts the first time an
allocation is voided.

Void is a reversal, never a deletion (D-16): the document remains, its journal is reversed
by a new journal, and both are visible. A voided invoice that vanished would make the
gapless sequence a lie.

<a id="d-39"></a>
**D-39 — A credit note is a document, not a negative invoice.** It has its own sequence,
posts its own journal, and allocates against invoices through the same mechanism payments
use — so "what is outstanding" has one definition regardless of what reduced it.

Modelling it as an invoice with negative lines would be less code and worse books: aging
would need to special-case the sign, a credit note could accidentally be paid, and the
document a customer receives would be an invoice claiming they owe minus two hundred.

<a id="d-40"></a>
**D-40 — Aging is computed as at a date, from documents and allocations, and reconciles to
the control account.** Buckets are current / 1–30 / 31–60 / 61–90 / 90+ days past due,
measured from the due date rather than the issue date, because that is what "overdue"
means to the person chasing it.

C8 is the criterion that makes it worth anything: the buckets must sum to the AR control
account's balance at that date. An aging report that does not tie to the ledger is a list
of hopes. Note this requires aging to be computed **as at** a historical date — using
today's allocations against a past date's documents would produce a report that cannot be
reproduced tomorrow, which is the same failure D-32 accepted deliberately for sliced
reports and must not accept here.

<a id="d-41"></a>
**D-41 — File import only; the feed interface ships without a hosted adapter.** CSV and
OFX/QFX, uploaded by the user. This is [D-07](#d-07) applied honestly rather than
inverted: the rule is that adapters ship with their first consumer, and M4 _is_ the first
consumer — so `BankFeedProvider` gains a real file-based implementation, and the hosted
aggregator adapter still has none.

A live feed is a different milestone wearing M4's clothes: OAuth to a third party,
custody of credentials that read a customer's bank, webhook delivery and replay,
per-institution quirks, feed outages that look like missing transactions, and a paid
dependency in the critical path. None of that is banking logic, and all of it would be
built before a single statement line had ever been matched.

File import also has a property a feed does not: the user can see the file. When a line is
wrong, there is an artifact to compare against, which is worth a great deal while the
matching pipeline is new.

<a id="d-42"></a>
**D-42 — A statement line is what the bank said, and is never modified.** Append-only, in
the grants allowlist sense — the app may insert and read, not update. Everything the
matching pipeline decides lives in rows that _reference_ a line, never in the line itself.

This is the same argument as journals (spec §2.2) applied to a different record. A
statement line that could be edited stops being evidence: the reason to keep it is that it
independently corroborates the ledger, and a corroborating record you can rewrite
corroborates nothing.

Re-import must therefore be idempotent rather than destructive (E1). The dedupe key is a
fingerprint over the fields the bank actually supplies — date, amount, description, and
the bank's own id where there is one — because statements overlap at their edges as a
matter of course, and a user re-uploading last month's file to catch a straggler must not
double the month.

The hard case, stated so nobody has to rediscover it: two genuinely distinct transactions
can be identical in every supplied field — two £4.50 coffees at the same shop on the same
day, from a bank that provides no transaction id. The fingerprint must include an
occurrence index within the file so the second one survives, and re-importing the same
file must still collapse to two rather than four.

<a id="d-43"></a>
**D-43 — Matching proposes; a human posts.** The pipeline ranks candidates and explains
why; it never writes to the ledger on its own. Accepting is the write, and it carries the
actor provenance every posting carries (spec §6).

This is not timidity about automation. It is that a bank statement is the one input a
bookkeeping system takes from outside itself, and an auto-poster's mistakes land in an
append-only ledger where the correction is a reversing entry — so a matcher confident
enough to post is a matcher that manufactures journal pairs when it is wrong. Confidence
belongs in the ordering of proposals, not in the decision to write.

The corollary is that a proposal is cheap and disposable. Nothing depends on a proposal
being right, only on it being ranked well, which is what lets the ranking be improved
later without a migration.

<a id="d-44"></a>
**D-44 — Bank rules are a deterministic lookup, not an engine.** Match on description,
amount and direction; set an account, a contact, and dimension tags. Same input, same
proposal, every time.

M6 owns the workflow engine, and the temptation is to make bank rules its first consumer
so the action catalog gets designed once. That pulls M6's hardest open decision forward
into a milestone that does not need it — and the two are not actually the same shape: a
bank rule answers "what is this line", which is classification, while a workflow answers
"what should happen next", which is orchestration.

**A rule change never restates a posted entry** (E8). Rules act on proposals only. If they
reached backwards, editing a rule would silently rewrite last quarter's coding, which is
the property [D-16](#d-16) refuses for transactions arriving through a side door.

<a id="d-45"></a>
**D-45 — Reconciliation is a session, and its lock is independent of the period close.** A
session names a bank account, an end date, and the statement's closing balance. Lines are
cleared into it until the computed book balance equals that figure; finalising records the
assertion. Reopening is permission-gated and recorded, which is the flow
[D-08](#d-08) said spec Phase 3 was describing when it declined to build it for fiscal
periods in M1.

The independence matters and is easy to get wrong. A bank reconciliation and a period
close are different assertions on different cadences — one says "the bank agreed with us",
the other says "we are done changing this month". Coupling them means a single bank
account's unreconciled straggler can freeze the whole ledger, or worse, that closing a
period silently asserts a reconciliation nobody performed.

<a id="d-46"></a>
**D-46 — A bank account is a ledger account plus import metadata.** Not a second balance,
not a second source of truth — the same rule [D-34](#d-34) applies to invoices. The
"balance" a user sees is the ledger account's balance; the statement's closing balance is
a _claim_ from outside that reconciliation exists to test against it. Storing both as
peers is how a banking module ends up disagreeing with its own general ledger.

<a id="d-47"></a>
**D-47 — M4 forces the queue decision and the worker's restart policy.** Both have been
carried since M1 as "interface only", and banking is where they stop being deferrable:
parsing a 5,000-line statement and ranking proposals against an open subledger is the
first work that does not belong in a request.

Two consequences already recorded. Known gap 7: the worker's Compose restart policy is
`on-failure`, correct while the worker returns immediately, and an outage the moment it
blocks on a queue — it becomes `unless-stopped`. And the open decision "Redis vs
in-process queue for self-host" must be answered, because a self-hosted single-container
install should not require Redis to import a CSV.

Both are now answered — the queue by [D-49](#d-49), and the restart policy with it, since
the policy only becomes wrong at the moment the worker starts blocking.

<a id="d-48"></a>

**D-48 — A match proposal carries a rank, not a score.** No confidence figure is persisted,
and none is exposed on the wire. Proposals are ordered; that ordering is the entire output.

[D-43](#d-43) puts confidence in the ordering of proposals and never in the decision to
write. A stored score does not violate that on the day it is added — it violates it about
six months later, because a score column is precisely the field an auto-accept threshold
gets built on, and at that point E3 is guarded by convention rather than by the schema. The
cheapest moment to not have that column is before OB-079 exists.

It also protects the property D-43 names as the point of proposals being disposable: the
ranking can be improved without a migration. A persisted score is a stored artifact of one
particular ranking, and stored artifacts acquire consumers.

The cost is real and accepted — tuning the ranking against real statements means
instrumenting a run rather than querying a column.

<a id="d-49"></a>

**D-49 — An in-process queue, the hosted broker (SQS) behind the interface.** The in-process
implementation ships as the first consumer of the queue interface; the hosted adapter has
none yet, exactly as [D-41](#d-41) left the hosted feed adapter. The open decision was
recorded as "Redis vs in-process", but the `QueueConfig` union already resolved the hosted
half to `sqs` — the terraform topology is AWS end to end (SQS, S3, Secrets Manager, SES),
so a Redis dependency would be a second broker nothing else needs. The decision here is the
half that was still open: **in-process for self-host**. Redis is retired from the record.

This is [D-07](#d-07)'s rule applied for the third time, and the constraint driving it is
the one D-47 stated: a self-hosted single-container install should not require a broker to
import a CSV. Requiring one would make the smallest deployment pay for the largest one's
problem.

The limits are worth stating rather than discovering. An in-process queue does not survive
a worker restart and does not span instances, so a hosted multi-instance deployment needs
the SQS adapter before it runs more than one worker. That is a present constraint, not a
deferred one: it means an interrupted 5,000-line import is re-run rather than resumed, and
E1's idempotent re-import is what makes re-running it safe. The dedupe property therefore
carries more weight than it appears to — it is also the crash-recovery story.

**The worker's restart policy changes with the queue, not before it.** `docker-compose.yml`
still reads `on-failure`, and its comment is still correct: while the worker registers no
jobs and returns immediately, `unless-stopped` restarts a _successful_ exit in a tight loop
that reads as a broken stack. It becomes `unless-stopped` in the same ticket that makes the
worker block. Changing it earlier trades a cosmetic problem for a real one.

<a id="d-50"></a>

**D-50 — Finalisation asserts the _cleared_ balance equals the statement, not the book
balance.** This settles the E5-vs-D-45 ambiguity the contracts left open. A reconciliation
compares what the bank has actually processed against what the bank says it processed, so
finalising asserts `clearedBalance === statementClosingBalance` and refuses otherwise (E5).
Uncleared items — a cheque written but not yet presented, a deposit in transit — are
**reconciling differences shown alongside, never blockers**: `unclearedAmount = bookBalance − clearedBalance`
is displayed and explains the gap between the ledger and the bank, which is the whole point
of a reconciliation rather than a failure of one.

Read literally, E5's "book balance = statement balance" would freeze a reconciliation
whenever a payment is in flight, which is not how bank reconciliation works and would make
month-end impossible in the ordinary case. The contracts already modelled `clearedBalance`
beside `bookBalance` in anticipation; D-50 says which one finalisation refuses on. This is
also standard practice — it is what a bookkeeper does by hand and what QuickBooks does.

<a id="d-51"></a>

**D-51 — A session freezes its membership at finalisation.** When a session finalises, the
clearings it counted are stamped with its id (`bank_line_clearings.reconciliation_session_id`,
already nullable for exactly this), snapshotting what the assertion covered. The alternative
— recomputing membership by date range on every read — leaves a finalised assertion
falsifiable: a clearing entered afterward with an in-range date would silently change what
the session claimed, and OB-075 flagged this as a real risk.

The reasoning is [D-42](#d-42)'s applied to an assertion rather than a line: a record whose
meaning can be rewritten after the fact records nothing. Reopening a session (E6) is the
sanctioned way to change what it covers, and it is permission-gated and logged in
`reconciliation_session_events` — an unstamp-and-restamp with a name and a timestamp on it,
not a silent drift. Freezing costs one membership write at finalisation and buys an
assertion that stays true.

<a id="d-52"></a>

**D-52 — With the in-process queue, the API consumes the jobs it enqueues.** OB-090's E2E
found the async import did not drain in the shipped api/worker topology, and the fix settles a
topology [D-49] left implicit. The in-process adapter does not cross a process boundary — a job
`startImport` enqueues runs in the process that enqueued it, which is the API. But the API
registered no handler and the `worker` role is a separate process with its own empty in-memory
queue, so a request enqueued to a queue nobody consumed. **The API now registers the import
handler when the queue is `in-process`** — the single-container self-host D-49 describes, where
one process does everything and needs no broker. The `worker` role exists for the `sqs` adapter,
where it long-polls the broker and the API registers nothing; exactly one process consumes,
chosen by the provider.

Two consequences the E2E also forced, both fixed in infrastructure rather than in the import:

- **A detached job must not inherit the enqueuer's transaction.** `startImport` enqueues inside
  `withIdempotency`'s transaction, and `AsyncLocalStorage` propagates through the queue's
  `setTimeout`, so the job ran with a transaction that had since committed and every write threw
  "Transaction is already committed". The in-process queue now runs every handler through
  `runDetached`, which clears the ambient transaction — the "re-scope outside any transaction"
  `transaction-scope.ts`'s header already prescribed for a background job, now enforced by the
  queue for all jobs rather than trusted to each.
- **A detached job can outrun the commit that created its row.** Running on a fresh connection,
  the handler can read before the request's `COMMIT` lands and miss a row that is about to
  exist. It now waits for the row, bounded (~250 ms), so a genuinely absent import still resolves
  to a skip promptly. Under `sqs` the message is sent after the commit, so the wait is a no-op
  there and correct here.

The lesson is the one D-26 states: these are seam defects, invisible to every layer's own tests,
and the browser narrative is what a milestone builds to catch them.

<a id="d-53"></a>

**D-53 — OAuth is a full authorization server (code + PKCE), not a narrower grant.** README commits
to third parties integrating "as OAuth clients with scoped, revocable access — not with a shared
admin credential", and the self-host promise ([D-05](#d-05), one image) forbids the easy escape of
delegating to a hosted identity provider: a self-hosted OpenBooks cannot depend on someone else's
login. So OpenBooks runs the authorization server itself, and the shape is OAuth 2.1 —
authorization-code with **PKCE mandatory**, implicit and resource-owner-password grants refused
because both hand a third party more than a code exchange does. Clients are registered by an org
admin under `integrations.write`; public dynamic registration (RFC 7591) is an anti-abuse surface of
its own and is out. The server authorizes API access only — it is not an OpenID Connect identity
provider, because "log in with OpenBooks" is a distinct security surface with distinct failure
modes, and nothing in v1 needs it.

**Flag for the human.** Running an authorization server is the highest-consequence code in the
project — a scope-confusion or PKCE-downgrade bug is a cross-tenant data breach, not a wrong report.
The decision to build rather than buy is close to forced by self-host, but the human should confirm
the risk appetite and whether M5 carries a dedicated external security review of OB-098 before it is
enabled in the hosted environment.

<a id="d-54"></a>

**D-54 — An OAuth scope is a permission key, and a token never exceeds its granting user.** The two
transports that already exist key authorization on `PermissionKey` — `RouteDefinition.permission`
and `McpToolDefinition.permission` — and `requirePermission` is the single service-layer gate
([D-25](#d-25), spec §5). A second authorization vocabulary for OAuth would be precisely the side
door M1 spent itself preventing, so there is no second vocabulary: **the scope catalog is the
permission catalog.** A consent grants a subset of the 48 keys; at each request the token's
effective permissions are the granted scopes **intersected with the granting user's current role in
that org**, recomputed the way `resolveSessionIdentity` already recomputes a session's org and role
rather than trusting a stored hint. The consequence that makes it right: revoking a user's role
narrows every token they authorized, with no token touched — a delegated credential can never
outlive or out-scope the person behind it, which is F2. A scope naming a key outside the catalog is
refused at grant time, not at first use.

<a id="d-55"></a>

**D-55 — API keys are first-party and role-bound; OAuth is third-party and user-delegated.** The
`api_keys` table has carried `role_id` — "its own role, not the issuer's" — since `0001`, which
already encodes the boundary: a key authenticates as an org and a role with **no user behind it**
(`actorType` automation), for the operator's own scripts and server-to-server jobs. An OAuth token
always represents a **person** authorizing a third-party client, and carries their identity and the
intersected scope of [D-54](#d-54). Both plug the same identity seam and produce a `ResolvedIdentity`
the rest of the system cannot distinguish from a session by shape — only by the actor provenance it
stamps onto the journal (spec §6). Both are opaque `key_prefix` + SHA-256 hash with instant
`revoked_at`; neither is a bearer JWT, for the reason in [D-61](#d-61). The rule in one line: a key
is never a person, a token is always one.

<a id="d-56"></a>

**D-56 — Events go through a transactional outbox, at-least-once, ordered per org.** The
`events.ts` header fixes three constraints: `publish` is called only after the originating
transaction commits ("a late event is better than a phantom one"); `eventId` and `occurredAt` are
assigned in one place, not by publishers; and the ledger is append-only. A direct post-commit
`publish()` satisfies none of them under a crash — the process can commit the journal and die before
publishing, losing an event that provably happened. So the state change and an `event_log` row are
written in the **same tenant transaction**: an event exists if and only if its change committed
(F7). A relay in the `worker` reads unpublished rows, assigns the host-side identity and a **per-org
monotonic position** — the [D-14](#d-14) counter pattern, taken `FOR UPDATE`, because the append-only
`event_log` cannot itself be locked for a read any more than `journals` can — and delivers
at-least-once, so **subscribers must be idempotent.** The `event_log` is append-only, in the grant
sense, beside `reconciliation_session_events`.

**Flag for the human.** Ordering is total **per org**, not globally: a global order would serialize
every tenant's writes through one counter, which contradicts the tenant isolation the whole schema
is built on. This is the right default, but it means a cross-tenant consumer sees per-org streams it
must merge, not one global stream — worth confirming against how the first real integrator expects
to consume it.

<a id="d-57"></a>

**D-57 — The change feed is a projection of the event log, not a second store.** The `events.ts`
header states it directly — "the M5 change feed replays from these same records" — and
[D-34](#d-34)/[D-46](#d-46) already refuse a second source of truth for anything the ledger holds.
So the feed is a resumable, tenant-scoped **keyset read over the append-only `event_log`**
([D-21](#d-21)), keyed on the per-org position from [D-56](#d-56), where the consumer holds the
cursor. Replay is therefore just re-reading from an earlier position; there is no denormalized feed
table that could drift from the log. This also settles the SSE-vs-polling open decision (spec §14,
carried from M4) as **pull, for now**: a durable cursor gives resumability that a dropped SSE stream
does not, and push delivery — SSE or webhooks — is a later optimization over the same log rather
than a different mechanism.

**Flag for the human.** Retention on the `event_log` bounds how far back an integrator can resync
(the spec §14 "event log retention policy" item, due at M5). Too short and a consumer offline over a
long weekend loses events permanently; too long and the log grows unbounded. This is an
operational/product number, not an engineering one — **the human sets it**, and OB-101's contract
documents the window a consumer can rely on.

<a id="d-58"></a>

**D-58 — `external_refs` is a unique correlation map that makes create idempotent by external
identity.** [D-33](#d-33) named it, with the change feed, as the seam an integration uses, and spec
§4 puts entity correlation here. The mapping is `(org_id, system, external_id) → (entity_type,
entity_id)`, unique on `(org_id, system, external_id)` **and** on `(org_id, system, entity_type,
entity_id)` — one external id names one entity and one entity has one external id per system, so
correlation resolves both directions without ambiguity. A create carrying a known external ref
returns the existing entity rather than duplicating: this is [D-04](#d-04)'s idempotency lifted from
a one-shot, per-request key to a **durable external identity**, which is what an importer that runs
weekly needs and an `Idempotency-Key` cannot give it. The map is mutable — a ref can be re-pointed
when two records are merged upstream — but never silently; an append-only ref history is out of M5,
and M7's QuickBooks import is the first bulk consumer.

<a id="d-59"></a>

**D-59 — MCP is a transport on the `api` role, not a fourth process.** `PROCESS_ROLES` is
`api|worker|migrate` and the one-image-three-roles commitment is an M1 architecture invariant; README
says the MCP server runs "over the same service layer as the REST API". So the MCP tools mount
**in-process in the `api` role** over streamable HTTP behind the same ALB, wired from a
`McpToolDefinition[]` the way routes are wired from `RouteDefinition[]`, with no new entrypoint and
no new task definition. The auth module's cookie and identity helpers were deliberately built to
return values rather than touch a Fastify `reply` for exactly this — the header names the MCP surface
as the reason. Authorization is not per-transport (spec §5): a tool reuses `requirePermission` with
its declared `permission`, so the MCP surface can refuse nothing the REST surface allows and allow
nothing it refuses.

<a id="d-60"></a>

**D-60 — An agent write is a proposal, never a direct posting.** [D-30](#d-30) deferred the
"may draft vs may post" distinction to "the agent review path in M5, when the code has a meaning and
a role to grant it to" — and the code, `agents.review`, has been seeded and latent since M1. This is
where it means something. `mcp.ts` already carries the machinery: `supportsProposeOnly`,
`requiresConfirm`, a `propose` execution mode, and a `McpToolOutcome` that is either `executed` or
`proposed`. A tool that would post to the ledger is `supportsProposeOnly` and, in `propose` mode,
lands a **draft** — M2's `journal_drafts` ([D-19](#d-19)) or an M3 document in its draft state — that
a human holding `agents.review` turns into a posting. The agent never holds an auto-posting grant.
This is [D-43](#d-43)'s "matching proposes, a human posts" generalized from the bank statement to
every agent action, and it needs no mutable ledger because the draft state already exists.

**Flag for the human.** This makes propose-only a **hard rule** for agent ledger writes, with no
trusted-client bypass. That is the conservative reading of [D-16](#d-16)/[D-43](#d-43) and almost
certainly right for v1, but if a future high-trust automation should post directly, that is a
product decision to take deliberately — not a config flag to leave open — and it is not in M5.

<a id="d-61"></a>

**D-61 — Credential revocation is instant and logged; tokens are opaque, not JWT.** Spec §14 lists
"security-event logging for revoked credentials" as due at M5, and [D-03](#d-03) already chose
server-side sessions over stateless cookies so that revocation is immediate. The same reasoning
governs OAuth tokens and API keys: they are opaque `key_prefix` + SHA-256 hash with a DB lookup, so
`revoked_at` takes effect on the **next request** with no blocklist to propagate. A bearer JWT would
be the tempting alternative — stateless validation, no lookup — but a JWT cannot be revoked before
it expires without exactly the server-side blocklist that reintroduces the lookup, at which point it
is a slower opaque token that also leaks its claims to anyone who reads it. Every issuance, consent,
and revocation writes an **append-only** `security_events` row, beside the other append-only
evidence tables.

**Flag for the human.** Some MCP and OAuth client libraries expect JWTs and self-validate. Opaque
tokens are the right call for instant revocation and consistency with [D-03](#d-03), but if a target
integrator's toolchain assumes JWT introspection, confirm the opaque choice against it before
OB-098 — it is cheaper to know now than to add a JWT path later.

<a id="d-62"></a>

**D-62 — M5 enforces latent permission codes rather than growing the catalog.** The catalog is a
closed 48-key union pinned by `AssertCatalogSize<48>`, and it already seeds the codes M5 needs —
`agents.review`, `integrations.read`, `integrations.write`, `api_keys.read`, `api_keys.write` —
catalog-only and unenforced, the same "seed now, enforce on arrival" pattern M1 gap 6 described and
banking's `LATENT_GRANTS` used. So M5 mostly **wires enforcement to codes that already exist**: OAuth
client and connected-app management under `integrations.*`, API keys under `api_keys.*`, the change
feed under `integrations.read`, the agent review queue under `agents.review`, and each MCP tool under
its operation's own existing code. A new key is added only if a genuinely new resource needs one, and
if so it moves the `48` assertion and its seed together — never one without the other, which is the
drift `test/permissions/catalog.test.ts` fails on.

<a id="d-63"></a>

**D-63 — Pay Bills is a batch orchestrator over one payment per vendor, fanned out server-side.** A
payment carries a single `contactId` and allocations refuse to cross contacts, so a batch of bills
across many vendors resolves to one payment per vendor — which is also one cheque per vendor, the
right real-world unit. The fan-out is a **server-side** `payBills` operation, not a client loop: a
client that dies mid-loop leaves some vendors paid and others not, the orphan state the payment model
works to avoid. Each resulting payment is its own transaction and its own journal; the batch is a
grouping, not one atomic ledger event.

<a id="d-64"></a>

**D-64 — The queued-but-unpaid state is a separate `pending_payment`, not a draft `Payment`.** A
`Payment` is money that moved: `journalId` is never null, there is no draft state (D-37/D-38), and
`outstanding` ties the subledger to the control account precisely because every payment posted a
journal. Giving `Payment` a nullable journal and a `pending` status would spend that invariant and
every reader that assumes it. Instead the pending state is a distinct, **mutable** entity that posts
no journal and materialises into a real `Payment` on issue. The pencil/ink split the codebase already
draws between allocations and the ledger, applied one level out to the intent to pay.

<a id="d-65"></a>

**D-65 — Issuing posts the journal; queuing does not.** Cash does not move when a cheque is queued —
it moves when the cheque is cut or the ACH is sent — so the bank-credit journal posts at **issue**,
not at queue time. "I already sent this cheque" issues immediately (queue and issue in one gesture);
"I need to print / send" issues later. More correct than QuickBooks, which drops cash at pay-bills
time. It also draws the separation-of-duties line exactly: queue-building touches no ledger and needs
no `journals.post`, so a clerk owns it; issue posts and needs the permission, so a controller owns
it. This is the clean answer OB-093 was waiting for.

<a id="d-66"></a>

**D-66 — Settlement discounts post to a user-selected account, as a real journal line.** An
early-payment discount is real P&L and cannot be expressed by the mutable allocation layer, which by
definition posts no journal. So issue posts a discount line — debit payables, **credit an account the
user chooses**, defaulted from an org setting and overridable per line — bringing the bill to `paid`
honestly. Rejected: auto-generating a vendor credit under the hood, which reaches `paid` through the
existing journal path but litters the vendor's ledger with system-created credit documents and their
numbers. **Generalised by [D-79](#d-79)** into payment terms across AP and AR (simple and rich),
suggested at pay time.

<a id="d-67"></a>

**D-67 — Rails are issue-time adapters over one shared issue core; the rail identifier reuses
`reference`.** Cheque, ACH, and wire differ only in the tail of issue — the identifier and artifact
they produce (cheque number from the account's register + a printable cheque; ACH trace + NACHA
entry; wire confirmation). The shared core (journal, allocations, `paid`) is rail-agnostic. The
identifier lands in the existing free-text `Payment.reference`, which D-36 already describes as "the
cheque number, whatever identifies this movement" — no new column on the posted payment. Rail is
defaulted at creation and reassignable in the queue, so the queue can be routed as a treasury step.
Consequence scoped as a dependency: ACH/wire require vendor bank details, new sensitive data on
`contacts`.

<a id="d-68"></a>

**D-68 — Double payment is prevented by a computed `committed` overlay, not a stored reservation.**
Because a pending payment posts no journal, it cannot reduce `outstanding` (which must stay
posted-only to tie to the control account), and the ledger's C3 over-allocation guard only fires at
issue — after the duplicate cheque is already cut, and even then over-_paying_ is allowed, so it lands
as unwanted credit rather than a stop. So the guard lives at the operational layer: a second computed
figure `committed = Σ open pending intents on a bill`, with `available_to_pay = outstanding −
committed`. `outstanding` is untouched and never sees `committed`; reports never see it either.
Enforced soft at queue-build and hard at issue under the allocation code's existing `FOR UPDATE` lock,
with C3 as the last-ditch backstop. Cancelling a pending payment frees the bill automatically — the
figure is read, not reserved, so there is nothing to release.

<a id="d-69"></a>

**D-69 — The reporting-snapshot layer is a separate, append-only-enabled prerequisite for scale.**
Per-document settlement (outstanding, `committed`, status) is a bounded, index-served slice and scales
to millions of documents untouched. What does not scale is the whole-history statement aggregate:
`selectAccountBalances` sums `journal_lines` from the beginning of time on every report, and aging
does an unbounded outer scan of every in-range document. The fix is **not** a denormalised balance on
the mutable spine — the thing the "no cache, one source of truth" docstrings rightly forbid — but a
**close-driven period snapshot** that memoises an _immutable_ prefix: because closed-period journal
lines can never change, the snapshot cannot go stale, and a report becomes snapshot-at-last-close plus
the bounded open tail. Append-only makes this uniquely safe; most ledgers bolt integrity onto a
mutable store to get it. Orthogonal to Pay Bills correctness, tracked as **OB-119**.

<a id="d-70"></a>

**D-70 — Org branding is a general, reusable record, not an invoice setting.** Because it is wanted
"for other things in the future," it is modelled as an org-level branding record — identity block,
logo, a brand colour, a footer — that feeds the invoice PDF and the outbound email now, and the
customer page, statements and other documents later. One record per org for v1 (multi-brand is a
later extension). It is **structured data, not a freeform template**, which is what makes a
server-side renderer safe: no template-injection surface, deterministic output. Mutable, but each
sent invoice freezes the branding into its retained artifact ([D-72](#d-72)), so a later rebrand does
not rewrite what a customer already received.

<a id="d-71"></a>

**D-71 — Invoice PDFs are rendered by a server-side library, not headless Chromium.** A JS PDF
library is deterministic and dependency-light and keeps the image slim; a bundled Chromium is a large,
moving dependency in a deliberately-slim runtime. The branding is passed as typed inputs and the money
as the already-string-formatted wire values, so there is no float and no HTML to sanitise. Revisit
Chromium only if a design demands CSS the library cannot express.

<a id="d-72"></a>

**D-72 — "Sent" is a delivery fact, not a ledger status.** The draft/approved/part_paid/paid/void
status is derived from journals and allocations; whether an invoice was delivered is orthogonal — an
approved invoice can be unsent, sent, or sent three times. So delivery is its own `invoice_deliveries`
record (recipient, sent-at, retained artifact key, provider message id), never a value folded into the
computed status. Only an **approved** invoice — one with a number — is sendable. The rendered PDF is
retained as the artifact of what was sent, immutable to later branding edits.

<a id="d-73"></a>

**D-73 — Invoicing is the first `StorageProvider` consumer and builds its adapters.** The interface
and env-driven selection have existed since M1, but no adapter was written — [D-07](#d-07)'s "adapters
ship with their first consumer," and storage had none. The org logo and the retained invoice PDFs are
that first consumer, so this initiative writes the `local` and `s3` adapters and the
`storageProvider()` accessor, with org-scoped keys. The same rule email followed at M2.

<a id="d-74"></a>

**D-74 — v1 delivery is an emailed link to a hosted, token-gated invoice page — no attachment.** An
earlier plan attached the PDF, which would have grown the `EmailProvider` contract (attachments +
SES `Content.Raw`/MIME); it was dropped before any build. Instead the existing HTML email carries a
**link to a hosted invoice page** with a **Download PDF** action. Two reasons this is better, not
just smaller: it needs no provider-contract change, and the hosted page is the exact surface the
parked Stripe/Square pay-link ([D-78](#d-78)) later lands on — delivery and payment share a seam
rather than being bolted together. The page is **the one sanctioned unauthenticated read**: a
high-entropy capability token per delivery is the whole authorization, read-only, no session, and the
PDF is served gated by the same token. A full logged-in portal stays out of scope; this is a single
invoice reached by a capability link.

<a id="d-75"></a>

**D-75 — The scheduler is net-new: a single-worker in-process daily tick.** The worker blocks on the
queue and runs only what is enqueued; there is no cron, interval or delayed-job runner. Reminders and
recurring both need "each day, find what is due and act," so a time-driven runner is built here — a
tick alongside `blockUntilShutdown` that enqueues onto the existing `QueueProvider`. It is
**non-durable across a restart** in v1, which is acceptable on the single-instance deployment; a
durable, multi-instance scheduler additionally needs the still-unimplemented `sqs` adapter
([D-49](#d-49)), and is deferred with it.

<a id="d-76"></a>

**D-76 — Recurring templates auto-approve by default, with a per-template `draft|approved` setting.**
This is the one place the system posts to the ledger with no human in the loop, and it is deliberate:
subscriptions and rent are the common case, and forcing a human to approve an identical invoice every
month is the friction the feature exists to remove. Auto-approve posts the journal and takes the
number through the same `approveInvoice` path a human uses, unattended, via a **system/automation
actor** so provenance still lands on the journal (spec §6, the non-human actor seam M5 established).
The `draft` mode is the escape hatch for templates a human wants to review; it is permission-gated
either way.

<a id="d-77"></a>

**D-77 — Full dunning: an org-configurable escalating policy, not just fixed reminders.** A reminder
is a single message; dunning is the orchestrated sequence. The policy is ordered stages — each an
offset from the due date, a template, a tone, and an optional late fee — that the scheduler walks each
overdue invoice through. Each stage sends **at most once** per invoice, enforced by an append-only
`dunning_sends` log, and the whole sequence is **suppressed** the moment the invoice is paid, voided
or disputed. A late fee, where a stage carries one, posts as the punitive twin of the settlement
discount ([D-66](#d-66)): a real journal line, not a status.

<a id="d-78"></a>

**D-78 — Stripe/Square inbound payment is a separate, parked initiative.** Accepting a payment online
is the AR mirror of the AP disbursement rails — a processor adapter over the "record received payment

- allocate" core, with the processor fee posting as the receiving-side twin of [D-66](#d-66), made
  idempotent against at-least-once webhooks by M5's `external_refs`, and carrying non-human actor
  provenance. It needs an inbound-webhook surface (distinct from M5's deferred _outbound_ push,
  [D-57](#d-57)) and vendor/customer payment details. The invoicing initiative deliberately leaves it
  out, providing only the two seams it will reuse: the hosted invoice page ([D-74](#d-74)) as the
  pay-link surface and `external_refs` as the idempotency key.

<a id="d-79"></a>

**D-79 — Payment terms generalise the discount primitive across AP and AR (extends [D-66](#d-66)).**
The manual, one-sided settlement discount of D-66 becomes a **payment term**: net days plus an
_optional_ early-pay discount (percent + window). A term computes the due date and, when it carries a
discount, the allowed amount and its deadline. **Simple** (net only) and **rich** (with a discount)
are both supported, as is an ad-hoc manual discount with no term. A term is a default on the
customer/vendor, overridable per document. On AR you _offer_ terms; on AP you _take_ them. The
discount is **suggested at pay/apply time and confirmed by a human** — never auto-posted, consistent
with [D-43](#d-43) — and posts a real journal line to a user-selected discount-given/received account.
Processor fees ([D-84](#d-84)) reuse this same primitive on the receiving side.

<a id="d-80"></a>

**D-80 — A bank statement line clears against multiple entries.** Today a clear settles exactly one
target. It becomes an **array** of entries — `allocate_document` × N (several invoices/bills),
`post_entry` × N (several GL accounts), and a discount line — summing to the line, with the difference
logic generalised. This one change delivers **lockbox** (one deposit across many customers' invoices)
and **subsumes OB-094** (split-coding, one line across several accounts) as the same mechanism. Each
entry posts exactly as a single-target clear does today; the set still balances to the line (E4) and
undo reverses it as a unit. Still propose-then-post ([D-43](#d-43)) — a multi-entry clear is one
accepted keystroke, not an auto-poster.

<a id="d-81"></a>

**D-81 — Cash application extends the match workbench, it does not add a new batch grid.** The M4
bank-match screen already ranks the open invoice a deposit pays and settles it; extended to
multi-entry ([D-80](#d-80)) with a discount suggestion ([D-79](#d-79)), it is the AR/AP application
surface, and the money-in screen remains for receipts not in the feed. A separate "receive payments"
batch grid would be a second surface doing what the workbench already does; remittance-advice file
ingestion is a later addition to the same ranking, not a new screen.

<a id="d-82"></a>

**D-82 — A payment processor is a clearing account, not a bank.** Stripe/Square do not pay per
transaction; they batch charges minus fees minus refunds into a periodic net **payout**. So a charge
clears AR into the processor's **clearing account** immediately (the invoice is paid), the payout
moves the accumulated balance from clearing to the real bank, and the bank feed reconciles the single
payout against the clearing account. "Invoice paid" (at charge) and "cash in bank" (at payout) are
deliberately decoupled — different accounts, different dates — and the books reconcile because
clearing nets to zero against the payout. Modelling the processor as the bank instead would leave the
payout unreconcilable and the fees muddled.

<a id="d-83"></a>

**D-83 — Hosted checkout only; OpenBooks never touches card data.** The pay-link redirects to the
processor's own checkout; the customer enters card details there, not on an OpenBooks page. This keeps
the system in PCI **SAQ-A** scope, stores no card data, and puts the org's processor keys in the
secrets provider — never entered into or echoed by the application. Embedded card fields (Stripe
Elements) would add control and PCI scope; deferred indefinitely. The checkout session carries the
invoice id in metadata, so the resulting payment has **certain** identity and auto-allocation is not a
guess — the one place auto-application is legitimate, unlike the inferred bank-feed match.

<a id="d-84"></a>

**D-84 — Per-charge fees; refunds as opposite payments; lean chargebacks.** The processor fee posts
**at charge time**, per charge, through the discount/fee primitive ([D-79](#d-79)) — cleaner per-
invoice P&L than deferring fees to payout, with the adapter normalising processors that only report
fees at payout. A **refund** is a payment in the opposite direction linked to the original charge (the
processor often retains its fee, so a refund rarely fully reverses). A **chargeback** is recorded and
coded when it hits the payout; the full dispute lifecycle (opened/evidence/won/lost) is deferred.

<a id="d-85"></a>

**D-85 — Processor webhooks: signed, `external_refs`-idempotent, with a polling backstop.** The
inbound webhook endpoint verifies the processor's signature and dedupes through M5's `external_refs`
keyed on the processor object id, so an at-least-once redelivery collapses to one payment (F9). Because
webhooks are also missed and reordered, a **scheduled poll** (on the OB-127 scheduler) backstops them
and reconciles the clearing account against the processor's own reported balance — the
subledger-agreement discipline OB-088 gave bank reconciliation, one level further out. This inbound
surface is distinct from M5's deferred _outbound_ push ([D-57](#d-57)).

<a id="d-86"></a>

**D-86 — One `PaymentProcessorProvider` abstraction, Stripe and Square adapters.** A new [D-07](#d-07)
provider — the AR inbound-rail mirror of the AP disbursement rails ([D-67](#d-67)) — behind which each
processor's divergent webhook and checkout schemas are normalised to internal events
(charge/fee/refund/dispute/payout). Square is the second implementation that proves the abstraction,
as M5's real consumers proved the platform contracts. The core cash path stays processor-agnostic.

<a id="d-87"></a>

**D-87 — Cash basis is a report transformation on an accrual-capable ledger, not a second ledger.**
Cash and accrual are recognition timing on the same double-entry events; accrual records are a strict
superset from which cash is derivable, so the ledger stays accrual-capable and everyone keeps the
operational documents ([D-88](#d-88) confirms most cash-basis businesses use invoices/bills anyway).
The transform re-recognises each accrual document at its settling payment date, **proportionally** for
partials, excludes the unpaid, and counts a journal **only to the extent it touches cash**. It is
majority-critical (most customers file cash) so it is built and property/mutation-tested to
ledger-kernel standard; the ambiguous edges (accrual adjusting JEs, prepayments/unallocated receipts)
are **flagged for review** ([D-99](#d-99)), never silently guessed, and every report is basis-labeled.
Supersedes [D-22](#d-22)'s accrual-only stance.

<a id="d-88"></a>

**D-88 — Operational documents are basis-agnostic; the Statement of Cash Flows is the missing third
statement.** Invoices and bills are operational units (get paid, organise payables, aging, dunning),
used by cash- and accrual-basis businesses alike — which is why the ledger keeps them and why Pay
Bills/Invoicing/Cash application serve everyone. The reporting pack adds the two reports M2 never had:
a **Statement of Cash Flows** (indirect, reconciling net income to the change in cash) and a **forward
cash-flow projection** from AR/AP due dates and recurring commitments.

<a id="d-89"></a>

**D-89 — Depreciation and amortisation post as scheduled journals from an asset register.** An asset
carries cost/method/life/in-service date; the register computes the schedule and the OB-127 scheduler
posts each period's depreciation as a journal — auto-approved by default with a draft option
([D-76](#d-76)), via a system actor so provenance lands. Disposal posts the gain/loss and stops the
schedule. Depreciation is thus a specialised recurring GL entry ([D-90](#d-90)).

<a id="d-90"></a>

**D-90 — Recurring GL entries are scheduled journal templates.** A fixed or formula-driven journal the
scheduler posts each period — prepaid amortisation, accruals, deferred-revenue recognition — distinct
from recurring invoices (which are AR documents). Same scheduler and draft-vs-auto-approve pattern as
recurring invoices and depreciation.

<a id="d-91"></a>

**D-91 — Employees are a contact type.** `is_employee` beside `is_customer`/`is_vendor` on the single
`contacts` table, so an expense has an owner and a reimbursement a payee without a parallel entity. The
same composite-key tenancy and contact machinery apply.

<a id="d-92"></a>

**D-92 — POs and estimates are non-posting pre-documents that convert.** A purchase order and an
estimate carry lines and their own numbering but **post no journal** — they are operational (approve,
send, track), not ledger events. Converting a PO creates a bill, an estimate an invoice, carrying the
lines; conversion is once (idempotent). This keeps the ledger's "a journal is an economic event" line
clean while giving procurement and pre-sale their documents.

<a id="d-93"></a>

**D-93 — Employee expenses create a payable that Pay Bills settles.** An approved expense (owned by an
employee contact, [D-91](#d-91)) becomes a payable/reimbursement that flows through the existing Pay
Bills path — no separate disbursement mechanism. Mileage and per-diem detail are later.

<a id="d-94"></a>

**D-94 — Budgets are a parallel plane with no ledger effect.** Budget amounts by account/dimension/
period are stored and compared against ledger actuals in a budget-vs-actual report; they post no
journal and touch no balance. The report honours the org's reporting basis and dimension filters.

<a id="d-95"></a>

**D-95 — OCR/bill capture proposes a draft; a human posts.** A captured document (upload or a per-org
email-in address) is stored (the Invoicing StorageProvider) and a swappable `DocumentExtractionProvider`
(LLM-capable, given the stack) extracts it into a **draft** bill/expense — vendor matched to a contact,
duplicates caught by the existing `duplicate_vendor_reference` guard, the original attached. Extraction
**proposes**, a human commits ([D-43](#d-43)); the non-determinism of extraction makes that gate
non-negotiable. It is a producer for the agent queue ([D-99](#d-99)).

<a id="d-96"></a>

**D-96 — An accountant is a granted user type, not a firm tier.** An org owner grants an external user
the seeded **`accountant`** role through the existing invite/membership flow — broad read, adjusting/
reclass JEs, run and close periods, statement packages, audit trail; not operational document entry —
revocable and org-scoped. Multi-client is just membership in several orgs with org-switch; a firm
entity above orgs is deferred. Keeps the strict composite-key isolation intact.

<a id="d-97"></a>

**D-97 — Period close is a workflow over the existing period lock.** A checklist per period, then lock
(the M1 period lock) and a recorded sign-off — the accountant activity the period lock was always for,
now with the process around it. Reopen stays the audited, permission-gated path.

<a id="d-98"></a>

**D-98 — Adjusting entries are flagged; the audit trail is surfaced, not built.** Adjusting/reclassifying
journals are ordinary journals marked as such for the accountant's review. Every journal already carries
actor provenance (spec §6); the audit report **surfaces** it as who-changed-what — a read over data that
already exists, not new capture.

<a id="d-99"></a>

**D-99 — M6 is an agent work queue driven by user-composed automations; agents propose, humans post.**
The Automations milestone is realised as a **work queue** (items carrying a prompt + context, enqueued
by producers across the app) plus an **automation engine** where an automation is a trigger (manual/
scheduled/event) and actions, one action type being an **agent task** that runs the org's model over a
work item into a **structured proposal**. Proposals land in the M5 review queue (OB-105) and **never
post to the ledger** ([D-60](#d-60)); deterministic and agent-task actions compose. This is user-driven
(nothing runs unless the user built the automation) and the safety mechanism for risky judgments like
[D-87](#d-87)'s cash-basis edges.

<a id="d-100"></a>

**D-100 — MCP-only: the org's own agent polls the queue; OpenBooks holds no model credentials.**
_(Supersedes the earlier "bring-your-own-model through the secrets provider" reading — reversed on the
owner's requirement that OpenBooks have **no direct AI integration except MCP**.)_ OpenBooks orchestrates
the work queue, the automation engine, and the prompts, but **never stores model config or credentials
and never makes an inference call**. The org's own agent authenticates as an MCP client via the M5 OAuth
AS (OB-098), **polls and leases** queued work items over MCP, runs inference on its own infrastructure,
and **submits a structured proposal** back through MCP; the proposal lands in the M5 `agents.review`
queue (OB-105) and a human commits it. Consequences: OB-201 is the **poll/lease + submit MCP tools**,
not a secrets-provider config; Q depends on the M5 MCP host + `agents.review` queue, **not** the OB-143a
secrets seam; and no AI-vendor SDK enters the codebase. **Provenance is agent-attested** — OpenBooks
records the submitting MCP client (OAuth `client_id`/API key) and timestamp, plus whatever model/prompt
the agent self-reports; it cannot independently vouch for the model, because it never called one.
**Recovery is time-based, not credential-based:** a lease that expires without a submission re-queues the
item and increments an attempt counter, flagging it for a human past a threshold — never silently
dropped.

<a id="d-101"></a>

**D-101 — Processor secrets get a real write seam; self-host adapter real, hosted throws.** The
read-only `SecretsProvider.get` gains a write op (`put`), a self-host adapter ships real (env/local,
encrypted-at-rest under an app key from `src/config/`, the `SESSION_SECRET` shape), and the hosted
`aws-secrets-manager` adapter throws until built — the `deterministic`/`anthropic` idiom. This is the
**first write path for a secret anywhere in the codebase**: the interface at
`packages/plugin-api/src/providers.ts:24` has `get` only and zero call sites. [D-83](#d-83) (processor
keys) needs this seam. _(An earlier note here also cited D-100 / initiative Q as a consumer; Q went
MCP-only ([D-100](#d-100)) and holds no model credentials, so it no longer uses this seam.)_ A key is
handed straight from the connect screen to the
seam and **never entered into or echoed by the application**.

<a id="d-102"></a>

**D-102 — The gate runs a `fake` processor; Stripe/Square are proven in a manual sandbox.** A `fake`
`PaymentProcessorProvider` selector value deterministically mints a checkout link, emits normalised
charge/fee/refund/payout events, and verifies a test-signed webhook, so OB-152/OB-153 run
hermetically (real MySQL, no external network — spec §11). The real `stripe`/`square` adapters are
built and unit-covered but network-exercised only in a manual sandbox run — the
`deterministic`-vs-`anthropic` bargain (initiative O) one initiative further out.

<a id="d-103"></a>

**D-103 — A processor is a plain GL clearing account plus a `processor_connections` row, not a
`bank_accounts` row.** The org **nominates existing** clearing and processor-fee-expense ledger
accounts ([D-23](#d-23): register, don't invent); a `processor_connections` table carries the ledger
links, the processor kind, the secret references, and the backstop cursor. A payout lands on the
**real** bank as a statement line and reconciles via the existing `link_entry` clear
(`clearBankStatementLine`) against the payout journal (debit bank, credit clearing) — no new match
machinery and no overloading of `bank_accounts` (whose `feed_source` is file-import, a different
thing from an accumulator reconciled by polling). The daily backstop reconciles the clearing account
two independent ways — its ledger `bookBalance` against the processor's reported balance — the OB-088
discipline one level out ([D-85](#d-85)).

<a id="d-104"></a>

**D-104 — PAY's fee is a self-contained fee line, not the full [D-79](#d-79) primitive.** The
per-charge fee posts as an ordinary journal line in the clearing journal (`source: 'clearing'`) to
the nominated fee-expense account, **auto-posted at charge by the system actor** (`runAsAutomation`) —
no human-confirm step, because the checkout metadata gives **certain** identity ([D-83](#d-83)),
unlike a bank-feed guess. The full D-79 payment-terms feature (net-days, early-pay discount windows,
human-confirmed suggestion) stays in Cash application; **PAY does not block on it**. If CA later
generalises the fee/discount-account nomination, PAY's nomination folds into that primitive.

<a id="d-105"></a>

**D-105 — Multi-entry clearing is a parent `bank_line_clearings` + a child `bank_line_clearing_entries`.**
[D-80](#d-80) turns a line's clear into N entries. Rather than N sibling rows (which would break every
"one clearing per line" assumption, the undo unit, and the reconciliation stamp), `bank_line_clearings`
**stays one-per-line** as the parent — it keeps `statement_line_id`, the `reconciliation_session_id`
stamp (the D-51 freeze), the running total and difference, and remains the undo unit — and a new
`bank_line_clearing_entries` child holds the N rows (each `entry_type` `allocate_document`/`post_entry`/
`discount`, its `cleared_journal_id`/`payment_id`/`account_id`/`target`, and a signed `amount_minor`).
`stampMembership` and every `reconciliation_session_id`-keyed balance read stay on the parent, unchanged
(`reconciliation.repository.ts:676` et al.). The E4 invariant generalises from
`cleared + difference === line.amount` to `Σ(entry amounts) + difference === line.amount`. The singular
target columns move off the parent onto the child; `uq_blc_journal` moves to the child (still one line
per journal, now per-entry).

<a id="d-106"></a>

**D-106 — An early-pay discount is a discount-kind allocation plus a real journal line.** A confirmed
discount must both post a journal (debit discount-given / credit AR control — the mirror on AP) **and**
bring the document's `outstanding` to zero. Since `outstanding = total − Σ(allocation amounts)`
(`allocations.repository.ts`, never stored — D-34), a bare discount journal would leave a residual. So
the discount is modelled as a **settlement whose funding source is the discount account, not cash**: it
writes an allocation row of the discount amount (a third `AllocationSource` kind `'discount'` alongside
`'payment'`/`'credit_document'`, `allocate.ts:63`) so `outstanding → 0`, and posts the discount journal
to the nominated account. Symmetric with how a payment settles, greppable, and it keeps the outstanding
formula untouched. Never auto-posted ([D-43](#d-43)); the human accepts the suggested entry.

<a id="d-107"></a>

**D-107 — Payment terms + discount-account nominations reuse `orgs.read`/`orgs.write`; no new catalog
keys.** Terms CRUD and the `discount_given_account_id`/`discount_received_account_id` nominations (which
live in `org_accounting_settings` alongside the control accounts) are settings-like, and the analogous
control-accounts surface already gates on `orgs.read`/`orgs.write` (there is no `settings.*` key);
OCR and PAY likewise added routes reusing existing keys where they could. The multi-entry clear reuses
`banking.match` (the clearing service already gates on it). So CA adds **no** permission key, no
`AssertCatalogSize` bump, and no `0001_tenancy` re-seed — only the route-table/OpenAPI/cross-org
coverage tripwires move for the new routes.

<a id="d-108"></a>

**D-108 — CA builds the shared AP+AR terms primitive and the AR-side suggestion; the Pay-Bills side
defers to PB.** Pay Bills (initiative G, OB-109…119) is **scoped, not built** — there is no AP
disbursement surface for [I5](#cash-application)'s "and in Pay Bills" to plug into. So CA builds the
payment-terms primitive as shared AP+AR data (not wasted — PB consumes it), and surfaces the confirmed
discount in the two AR paths that exist today: the **bank-match workbench** (D-80 multi-entry) and the
**manual money-in** receipt path (D-81's "the money-in screen remains for receipts not in the feed").
The Pay-Bills-side suggestion lands with PB. I5 is therefore partially deferred by construction, flagged.

<a id="d-109"></a>

**D-109 — PB gets dedicated queue/issue permission keys for a real separation of duties.** [D-65](#d-65)
wants a clerk who builds the queue but cannot post, and a controller who issues. [OB-093](#follow-up-tickets--phase-0-cleared-the-m3-debt)
deliberately gave `ap_only` **both** `payments_made.write` and `journals.post`, so reusing those keys
would let one `ap_only` user queue **and** issue — collapsing the split. So PB adds
`pending_payments.read`/`pending_payments.write` (queue) and **`disbursements.issue`** (issue). The
queue keys are seeded to `ap_only` (the clerk builds the queue); `disbursements.issue` is seeded to
**owner only**, so `ap_only` can build but not release — a genuine v1 separation, not merely an
architectural one. Issue still transitively needs `payments_made.write`/`journals.post` (it calls
`recordPayment`), so `disbursements.issue` is the distinguishing gate. Catalog 53 → 56; the six role
seeds in `0001_tenancy` and the permission-matrix/catalog/grants tripwires move. This departs from
CA's reuse ([D-107](#d-107)) on purpose: the separation of duties **is** the feature here.

<a id="d-110"></a>

**D-110 — Rails are classification tags for external handoff, not behavioural adapters (refines
[D-67](#d-67)).** A `rail` (`cheque` | `ach` | `wire`) tags a pending payment and the issued payment
purely to classify **how the movement will be executed** — for filtering, reporting, and querying by
another system that actually performs the ACH/wire. OpenBooks runs **no NACHA generation and no wire
logic**: those are third-party integrations, and the app's job is to record the payment, tag its rail,
and expose it. A list-by-rail read surface lets an external system pull, say, all `ach` disbursements
to process. The rail identifier the external system returns (ACH trace, wire confirmation) lands on the
existing free-text `Payment.reference` ([D-36](#d-36)), user- or integration-supplied — not generated.

<a id="d-111"></a>

**D-111 — Cheque is the only internally-supported rail, behind a swappable output abstraction.** A
cheque is the one rail with in-app mechanics: at issue it draws its number from a per-bank-account
cheque-number register (a `document_sequences`-style gapless counter keyed `(org_id, bank_account_id)`,
taken `FOR UPDATE`). Even the printing sits behind a `ChequeOutput` seam — a default implementation
renders a cheque + stub PDF through the existing invoice renderer + `StorageProvider`, and a company
that feeds cheques to an external printer/system swaps the implementation (the `StorageProvider`/
extraction-provider idiom). No NACHA file, no wire artifact ships ([D-110](#d-110)); ACH/wire produce
no in-app artifact at all.

<a id="d-112"></a>

**D-112 — PB reuses CA's discount primitive and completes the deferred AP-side suggestion.** The
settlement discount ([D-66](#d-66), generalised by [D-79](#d-79)/[D-106](#d-106)) is not rebuilt: issue
posts it through CA's shape — debit the payables control, **credit the nominated
`discount_received_account_id`**, and write a `discount`-kind allocation so the bill reaches `paid` and
`outstanding` nets to zero — extracted into a shared `postSettlementDiscount(side, …)` helper that both
the bank-match `discount` clearing entry and PB issue call, so the AR and AP discount paths cannot
drift. The Pay Bills window surfaces `suggestDiscount` for `bill` targets (the service is already
AP-capable), finishing the [D-108](#d-108) deferral.

<a id="d-113"></a>

**D-113 — Depreciation is a precomputed schedule table posted by its own scheduled job, not a fixed
recurring-journal template (initiative L).** A recurring GL template ([D-90](#d-90)) posts fixed lines
each period; a declining-balance depreciation amount changes every period, so it cannot be a fixed
template. Registering an asset computes a `fixed_asset_schedule` — one row per period, each with its
planned `depreciation_amount_minor` — and a depreciation sweep posts the earliest unposted row whose
`period_date ≤ runDate`, idempotent on `posted_journal_id`. Recurring GL entries and depreciation are
therefore two **distinct due-work sources on the one OB-127 scheduler**, both riding `runAsAutomation`
and the recurring-invoice engine's `FOR UPDATE`-reload-plus-guard idempotency pattern, not one mechanism.

<a id="d-114"></a>

**D-114 — Depreciation methods are straight-line and declining-balance, with salvage.** Straight-line is
`(cost − salvage) / useful_life_months` per period; declining-balance is `rate × book value`, floored so
book value never drops below salvage, with the **final period truing up so `Σ amounts === cost − salvage`**
— the equality L6 property-tests. Units-of-production and sum-of-years'-digits are deferred: they need a
usage feed or add no method the target market asks for.

<a id="d-115"></a>

**D-115 — Per-asset account nominations, defaulted from org settings; accumulated depreciation is an
ordinary asset/credit account.** Each asset names its cost, accumulated-depreciation, and
depreciation-expense accounts, defaulted from two new `org_accounting_settings` columns
(`depreciation_expense_account_id` → `expense`, `accumulated_depreciation_account_id` → `asset`) when the
org has set them — the in-place `discount_*` precedent ([D-15](#d-15)), gated `orgs.write`. Accumulated
depreciation needs **no contra flag**: the chart's `type` and `normal_balance` are independent by design
(`0002_ledger`), so it is simply `type:'asset'`, `normalBalance:'credit'`, and the balance sheet — which
flips off `type`, never `normal_balance` — renders it correctly.

<a id="d-116"></a>

**D-116 — Disposal is full-only, a fresh journal.** Disposing an asset posts one new journal
(`source:'disposal'`) that removes the remaining cost and accumulated-depreciation-to-date and recognizes
the gain or loss against proceeds, flips the asset to `disposed`, and stops the schedule (unposted future
rows are voided). It never touches the acquisition journal, so `reverseJournal` is not involved. Partial
disposal, impairment, and revaluation are deferred.

<a id="d-117"></a>

**D-117 — L adds two config key-pairs, with no separation-of-duties split.** `recurring_journals.read`/
`.write` and `fixed_assets.read`/`.write` gate the two management surfaces (recurring templates and the
asset register); writes seed to owner + bookkeeper like every other configuration write, reads reach the
read-only roles through `%.read`. Catalog 56 → 60. Unlike PB ([D-109](#d-109)) there is no owner-only
release step — the automated posts run through `postJournal` under the automation's Owner role
([D-89](#d-89)), and managing the standing instructions is ordinary bookkeeping configuration.

<a id="d-118"></a>

**D-118 — MCP errors must never look like a broken connection; a failed call is a well-formed result,
not a dropped transport.** Real MCP clients (ChatGPT among them) treat a non-2xx HTTP response — and a
malformed or unexpected body — on the `/mcp` endpoint as _the tool/connection itself failing_, and drop
it from the session; a per-call refusal (`permission_denied`, `not_found`, `validation_failed`, a tool's
own business error) then reads as "OpenBooks disconnected," which is both wrong and unrecoverable without
a reconnect. So Q hardens the host (`modules/mcp/host.ts`) to the rule: **once the request is a
structurally valid JSON-RPC envelope, every outcome — success or failure — returns HTTP 200 with a
well-formed JSON-RPC body**, the failure carried in the `error` object (`code`, `message`, typed
`data.code` the client branches on), never as an HTTP status. This _changes today's behaviour_:
`toJsonRpcErrorResponse` currently propagates `wire.status` (403/404/**500**) to the HTTP layer
(`host.ts:353`), the exact shape that trips the client. Non-2xx stays reserved for **pre-dispatch,
transport-level** failures only — an unparseable envelope (`-32600`, the one existing 400) and the
auth/`onRequest` layer that runs before the handler (401/403 on a bad or missing bearer token, which is
genuinely "not connected"). Additional guarantees: an **unexpected/internal** throw is mapped to a
generic `internal` JSON-RPC error (no stack, no leaked message — F5 parity with REST) rather than a bare
500; the envelope always echoes the request `id`; and the property suite (OB-209) asserts, over the full
tool suite × {permission-denied, not-found, validation, internal, tool-business-error}, that the HTTP
status is 200 and the body parses as JSON-RPC with a branchable `data.code`. The work-queue tools
(`poll`, `submitProposal`) inherit this by construction — an empty queue is a **200 with an empty
result**, not a 404; a stale/expired lease on `submitProposal` is a typed `data.code` (e.g.
`lease_expired`) a client can act on, not a transport error. This is the transport-robustness half of
Q11. **Two existing sites move with this change** (found while scoping): the caught-error logging split
at `host.ts:351-352` keys off the outgoing HTTP status (`status >= 500`) and must instead key off
`wire.status`/`data.code`, since the outgoing status becomes a constant 200; and the F5/F6 MCP
assertions in `test/enforcement/platform-security.test.ts` currently assert `403` (`:367`, permission
refusal) and `400` (`:467`, the `execute`-refusal) — both flip to **200 with the same `data.code`**
(`permission_denied` / `validation_failed`), which is the assertion the hardening is meant to guarantee.
The nested `error.data.details.…` body shape (F5) is preserved; only the HTTP envelope status changes.

<a id="d-119"></a>

**D-119 — The v1 action catalog is two entries: `annotate` (deterministic) and `agent-task`; a generic
outbound action is deferred.** An automation runs an **ordered list of actions**; v1 ships exactly two
action types so composition (Q9) is real and testable without opening a new surface:

- **`agent-task`** — enqueues a work item (prompt + context) for the org's MCP agent to poll/lease and
  propose against ([D-100](#d-100)). The load-bearing action; it is the only one that reaches the AI
  seam, and it never posts.
- **`annotate`** — the trivial deterministic action: appends an **append-only note** (a short string,
  plus the automation id and run timestamp) to the automation-run record and/or the enqueued work item.
  It has **no external side effect, no egress, and needs no secret** — deliberately, so the deterministic
  half of "compose" costs nothing and can't fail in an interesting way. Its whole job is to prove that a
  deterministic action and an agent-task action run in one automation, in order, with both effects
  observable (the E2E and OB-209 assert `[annotate, agent-task]` produces the note _and_ the enqueued
  item).

**Deferred, deliberately: a generic outbound / webhook / HTTP action.** It is the obvious next
deterministic action, but it reintroduces exactly what Q was reshaped to remove — outbound egress plus
per-action secrets (auth headers, signed URLs) — so it earns its own scoping pass rather than riding in
on v1. The action model is an open enum keyed on an `action.type` discriminator, so adding it later is a
new case, not a reshape. The `outbound-http` / webhook action and the broader "workflow action catalog"
stay a post-Q follow-up.

## Status — Milestone 1

All 27 M1 tickets are built and committed on `develop`. The figures below are M1's at the
time it closed; the current whole-repo figures are in
[Where things stand](#where-things-stand). The gate — `yarn check` — passed at 667 tests
across 51 files against real MySQL 8.4 via testcontainers, roughly 28 seconds.

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

### Before scoping M3 — answered, kept for the reasoning

The QuickBooks walkthrough spec §14 recommended is **not being done** — see
[D-33](#d-33). What still holds is [D-16](#d-16): invoicing is where the deferred draft
state first bites, because an invoice has a lifecycle a journal does not. M2's OB-038
built that draft state for journals, so M3 inherits a pattern rather than inventing one —
but an invoice's states (draft, sent, part-paid, paid, void) are richer than a draft's two,
and the mapping is not free.

The other thing to settle before M3 is scoped is what a _subledger_ is in this system.
Spec §2.1 says no module holds financial state independently, so an invoice cannot carry
its own balance — the amount outstanding has to be derivable from the ledger plus the
payments applied to it. That is the decision M3 turns on, and nothing in M1 or M2 forced
it.

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

| Decision                                                                         | Needed by     |
| -------------------------------------------------------------------------------- | ------------- |
| ~~Redis vs. in-process queue for self-host Compose~~ — [D-49](#d-49): in-process | Settled in M4 |
| SSE vs. polling for live queue and reconciliation updates                        | M4–M5         |
| Event log retention policy — also bounds integrator resync depth                 | M5            |
| Security-event logging for revoked credentials                                   | M5            |
| Workflow action catalog                                                          | M6            |
| Recurring transaction and QuickBooks import staging schemas                      | M3, M7        |
| Hosted pricing/tiers and data portability principle                              | M7            |

Spec §14's recommendation to walk ACH Pro's QBO integration before M3 and M5 is
**declined** — [D-33](#d-33).
