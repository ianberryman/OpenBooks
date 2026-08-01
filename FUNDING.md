# Funding OpenBooks

OpenBooks is free, open-source software (AGPL-3.0). It is also run as a hosted service, and that
paid service is what funds the product's development. **Donations are for something narrower and
fully transparent: the free community infrastructure that benefits everyone — including people who
never pay us a cent.**

> **What your donation pays for — and what it doesn't.**
> Donations cover the *community* resources below. They do **not** subsidize the commercial hosted
> service (customers pay for that) or general development. Every donated dollar goes to keeping the
> free, shared resources running.

## How to give

- **Open Collective** — <!-- TODO: link --> our transparent budget. Every expense (the AWS bill, the
  domain, the email provider) is posted publicly, so you can see exactly where the money goes.
- **GitHub Sponsors** — <!-- TODO: link --> one-click recurring support via the **Sponsor** button on
  the repo.

Donations are **not tax-deductible** unless noted otherwise on the collective (which depends on the
fiscal host).

## What it costs to run the free community resources

These are the shared, free resources donations keep online. Some are **projected** — they don't exist
yet and only incur cost once stood up (noted below). We publish real figures on Open Collective as
they land.

| Resource | What it is | Rough monthly cost                   | Status                       |
| --- | --- |--------------------------------------|------------------------------|
| **Live demo instance** (AWS) | A public, resettable demo so anyone can try OpenBooks without installing it — app + database hosting | `$15/mo`                             | Projected (not yet stood up) |
| **Docs & marketing site** | Static site (docs, feature tour, the published API spec) on a CDN | `$5/mo` (low — static/CDN)           | Projected                    |
| **Transactional email** | Sending for the demo instance + project communication | `$12/mo`                             | Projected                    |
| **Domain & DNS** | The project domain(s) | `$12/yr`                             | —                            |
| **CI** | Running the full `yarn check` gate on contributions | `$0` (may be free on public runners) | See OB-230                   |
| **Backups / misc** | Demo data backups, incidental services | `$10/yr`                             | Projected                    |
| **Total** | | **`~$34`/mo**                        | **`~$406`/yr**               |

## Funding goals

Concrete goals let a donor see what their contribution unlocks:

- **`$1`/mo — keep the lights on:** domain, email, and the docs site.
- **`$3`/mo — the live demo:** funds the public AWS demo instance so anyone can try OpenBooks
  before installing.
- **`$5`/mo — headroom:** backups, a larger demo, and covering usage spikes.

## Prefer not to donate?

Other ways to support the project that cost nothing: **self-host it** and report what breaks, pick up
a [good first issue](https://github.com/OpenBooksAccounting/OpenBooks/issues?q=is%3Aissue+label%3A%22good+first+issue%22),
improve the docs, or tell someone who needs open-source accounting software.
