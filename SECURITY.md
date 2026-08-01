# Security Policy

OpenBooks is double-entry accounting software — it is designed to hold financial records, and we
treat security accordingly. This policy explains what is supported, how to report a vulnerability,
and what to expect in return.

> **Pre-release.** OpenBooks has not had a production-hardening pass and the schema is not frozen.
> Do not keep real books in it yet. A pre-production security review of the OAuth 2.1 authorization
> server is planned before the first stable release.

## Supported versions

Until a `1.0` release, only the latest `develop` (and the most recent tagged pre-release, once tags
exist) receive security fixes. Older commits and pinned pre-release builds are not supported —
upgrade to the latest before reporting.

| Version            | Supported |
| ------------------ | --------- |
| `develop` (latest) | ✅        |
| earlier commits    | ❌        |

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security vulnerability.**

Use one of these private channels:

1. **Preferred — GitHub private vulnerability reporting.** On the repository go to
   **Security → Advisories → Report a vulnerability**. This keeps the report private and threaded
   with the maintainers.
2. **Email** — a dedicated security contact address will be published here; until then, please use
   GitHub private reporting above.

Please include:

- the affected component and version/commit,
- the impact (what an attacker can do),
- reproduction steps or a proof of concept, and
- for anything touching the ledger, the **postings involved** — a symptom without the journal lines
  is rarely enough to reproduce an accounting bug.

## What to expect

This is a pre-release project maintained on a best-effort basis. We aim to:

- **acknowledge** your report within **5 business days**,
- share an assessment and a rough remediation timeline once triaged, and
- **credit** you in the advisory when a fix ships, unless you prefer to remain anonymous.

Please give us a reasonable opportunity to fix the issue before public disclosure; we will coordinate
a disclosure date with you.

## Scope

In scope: the OpenBooks application (API, web app, MCP surface), the two-database-user privilege
model, authentication and the OAuth 2.1 authorization server, tenant isolation, and the journal
immutability guarantees. Issue classes that matter most for a system like this:

- **Cross-tenant access** — any path that lets one organization read or write another's data. A
  cross-org read must be indistinguishable from a nonexistent one; a cross-org _write_ is critical.
- **Journal immutability** — any way to `UPDATE` or `DELETE` a posted journal. Immutability is
  enforced at the database-grant level and must stay that way.
- **Auth bypass** — authentication/authorization bypass, and token or session handling flaws.
- **Money correctness with a security consequence.**

## Out of scope / please don't

- Do not run automated scanners or load/DoS tests against any hosted OpenBooks instance you do not
  own.
- Do not test against other people's data or hosted instances — use your own local deployment.
- No social engineering, physical attacks, or attacks on our infrastructure or third-party services
  (Stripe, Square, etc.).

## Safe harbor

We consider security research conducted in good faith and in accordance with this policy to be
authorized. We will not pursue or support legal action against researchers who follow it, and we
will work with you to understand and resolve the issue quickly. If you are unsure whether an action
is authorized, ask first via a private channel.
