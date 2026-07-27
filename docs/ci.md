# CI — operator guide

The pipeline is one workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), plus
one composite action, [`.github/actions/setup`](../.github/actions/setup/action.yml), plus one
script, [`.github/scripts/check-token-lint.sh`](../.github/scripts/check-token-lint.sh). This
file is for whoever is setting the repository up. Why each gate exists is in the workflow's own
comments, next to the gate.

OB-027 built this for M1. OB-056 extended it for M2: the web bundle and its component suite, the
B9 token gate, an e2e job for the B1 narrative, and `yarn build` inside the local gate.

GitHub Actions rather than the GitLab CI named in spec §3, per
[ROADMAP D-09](../ROADMAP.md#d-09): the repository is on GitHub, so a GitLab pipeline would be
unverifiable. Same stages.

---

## Nothing runs automatically

The workflow's only trigger is `workflow_dispatch`. It runs when a human starts it:

```bash
gh workflow run ci.yml --ref develop
```

or Actions → CI → Run workflow. There is no `push` trigger, no `pull_request` trigger, and no
schedule. The legacy `.github/workflows/main-ci.yml` from the previous codebase — which did run
on every push — is deleted rather than left in place, because leaving it would have defeated
this.

**To re-enable automatic runs:** uncomment the `push:` and `pull_request:` blocks at the top of
`ci.yml`. That is the whole change; the intended triggers are written out and commented rather
than omitted, and every job works unchanged under them. The one behaviour that shifts is
described under [Pushing the image](#pushing-the-image-to-ecr).

---

## The job graph

```
                                     ┌─ static ─────────────────┐
                                     ├─ drift-spec ─────────────┤
                                     ├─ drift-schema ── DB ─────┤
                                     ├─ test ────────── DB ─────┤
  dispatch ──────────────────────────┼─ web ────────────────────┼──► publish-image
                                     ├─ e2e ─────── DB + browser┤     (develop +
                                     ├─ parity ─────────────────┤      AWS configured)
                                     ├─ build ─────────── Docker┤
                                     ├─ aws-preflight ──────────┘
                                     └─ terraform (advisory, blocks nothing)
```

Ten of the eleven jobs start at once and share nothing; there is no `needs` between them.
`publish-image` is the only job with dependencies, and `terraform` is deliberately not one of
them (see [Terraform](#terraform)).

| Job             | Needs a database?               | Needs Docker? | Typical wall clock                 |
| --------------- | ------------------------------- | ------------- | ---------------------------------- |
| `static`        | no                              | no            | ~1m40s (≈70s install, ~20s checks) |
| `drift-spec`    | no                              | no            | ~1m20s (checks are ~3s)            |
| `drift-schema`  | **yes** — MySQL 8.4 via Compose | yes           | ~2m30s                             |
| `test`          | **yes** — testcontainers        | yes           | ~4m                                |
| `web`           | no                              | no            | ~1m20s (the two steps are ~5s)     |
| `e2e`           | **yes** — MySQL 8.4 via Compose | yes           | unmeasured — see below             |
| `parity`        | no                              | no            | ~15s (no install at all)           |
| `build`         | no                              | yes           | ~5m (the image build dominates)    |
| `terraform`     | no                              | no            | ~1m30s (provider download)         |
| `aws-preflight` | no                              | no            | ~10s                               |
| `publish-image` | no                              | yes           | skipped today — see below          |

Critical path is `build` or `e2e`, so a green run is roughly **5–7 minutes** wall clock, against
about 20 minutes of billed runner time across the eleven jobs.

Those numbers are extrapolated from local measurements on an M-series Mac, not observed on a
GitHub runner — GitHub's runners are slower per core, and the two figures the estimates lean on
hardest are the `yarn install --immutable` (~70s cold cache, ~25s warm) and the Docker image
build. Compose MySQL to healthy 5.8s, migrations 1.3s, codegen 1.2s, parity script 0.02s
(OB-027, unchanged).

Re-measured for OB-056, same machine, in job order:

| Command             | Time  | Notes                                                       |
| ------------------- | ----- | ----------------------------------------------------------- |
| `yarn format:check` | 5.3s  |                                                             |
| `yarn lint`         | 11.4s |                                                             |
| `yarn lint:tokens`  | 4.2s  | the B9 gate; ~0.6s of it is the binding assertion           |
| `yarn lint:deps`    | 1.1s  | 425 modules, 1697 dependencies                              |
| `yarn typecheck`    | 2.9s  |                                                             |
| `yarn drift`        | 2.9s  | both halves; `spec:check` alone is 1.2s                     |
| `yarn build`        | 1.6s  | server 0.13s (esbuild), web 0.26s (Vite) — the rest is Yarn |
| `yarn build:web`    | 1.2s  |                                                             |
| `yarn test:web`     | 3.7s  | 219 tests across 26 files, jsdom, no Docker                 |
| `yarn test`         | 115s  | 1,307 tests across 115 files                                |

The `yarn test` figure is the one that moved since OB-027, which recorded 28.2s for 667 tests
across 51 files. M2 roughly doubled the test count and the additions are the expensive kind —
fast-check property runs over the report engine, each generating and posting journals against
real MySQL. Read 115s as an upper bound rather than a clean measurement: it was taken on a
machine that was also running another working tree's containers. Either way `test` is no longer
a cheap job, and CI should be budgeted for that.

### Which jobs need the database, and how they get one

Three do, by different mechanisms, and the differences are not arbitrary.

- **`test`** uses testcontainers, which the suite owns end to end. `globalSetup` starts one
  MySQL container for the whole project (~4.5s) and passes connection parameters to test files
  via `provide`/`inject`; `fileParallelism: false` keeps files from interleaving writes.
  Spec §11 forbids SQLite and mocks, so this needs a Docker-enabled runner — `ubuntu-latest`
  has one. See [`packages/server/test/README.md`](../packages/server/test/README.md).
- **`drift-schema`** brings MySQL up with `docker compose up -d --wait mysql`. It cannot use a
  GitHub service container: the two database users and the grant split come from
  `docker/mysql-init/*.sql` mounted into `/docker-entrypoint-initdb.d`, and service containers
  start _before_ `actions/checkout`, so that directory would not exist and the init scripts
  would silently not run.
- **`e2e`** also uses Compose `mysql`, but CI never says so: `packages/e2e/playwright.config.ts`
  declares the stack as Playwright `webServer` entries, and `scripts/start-stack.mjs` is what
  runs `docker compose up -d --wait mysql`, applies migrations, and starts the API. See
  [End-to-end](#end-to-end-the-b1-narrative).

Everything else is database-free and can be read as pure functions of the checkout.

---

## The local gate, and where `yarn build` sits in it

`yarn check` is the gate, and as of OB-056 it runs:

```
format:check → lint → lint:tokens → lint:deps → typecheck → drift → build → test
```

Two of those are new.

**`build` was missing, and that was not cosmetic.** A defect in the token layer made Tailwind
emit `@media (width >= var(…))` for any source file containing the bare word `container`, which
the CSS minifier rejects. The build died — while `typecheck`, `lint` and the entire test suite
passed. The gate could not see a bundler or CSS-minifier failure at all, because it never ran a
bundler.

**Before `test`, not after**, on measured cost: `yarn build` is 1.6s and `yarn test` is ~115s.
A gate that reports the cheap failure first is a gate people keep running. It sits after
`typecheck` rather than before it for the opposite reason — the same broken import produces a
legible type error and an obscure bundler error, so the legible one should be reached first.

**`lint:tokens`** is [the B9 gate](#the-token-gate-b9). It overlaps `yarn lint` by design;
that section explains what it adds.

---

## The token gate (B9)

ROADMAP B9: _"No component names a raw colour, spacing, or radius — tokens only,
lint-enforced."_ [D-24](../ROADMAP.md#d-24) makes the token layer a build gate rather than a
convention, and says the rule is the same construction as `openbooks/no-float-money`.

`yarn lint` has always run `openbooks/no-raw-color`, so what does `yarn lint:tokens` add? B9 has
two halves and only one of them had a check:

1. **The rule reports correctly.** Proven by `packages/eslint-plugin/test/no-raw-color.test.ts`,
   inside `yarn test`.
2. **`eslint.config.js` still binds it to the web sources at severity `error`.** Nothing proved
   this. Delete that config block and the rule's own tests still pass, `yarn lint` still passes,
   and B9 quietly stops being held.

`.github/scripts/check-token-lint.sh` closes the second gap with `eslint --print-config` against
a component chosen by glob (not a hardcoded filename, and never a test file — the config relaxes
rules for those). It then runs the rule over `packages/web/**/*.{ts,tsx}`. That second half is a
subset of `yarn lint` and costs ~3s; it is duplicated so a raw colour fails under a step named
for the criterion instead of as one line in a repo-wide lint run.

In CI it is the **Token layer (B9)** step of `static`, next to the `no-float-money` enforcement
point it mirrors.

The script lives in `.github/scripts/` because OB-056 owned that directory and not
`infra/scripts/`. If a second repo-level check ever wants a home, `infra/scripts/` is the more
honest one and moving it is a one-line change to `lint:tokens`.

---

## End-to-end: the B1 narrative

[B1](../ROADMAP.md) is the one acceptance criterion that cannot be proven below the browser, and
[D-26](../ROADMAP.md#d-26) fixes how: one Playwright narrative against the real Compose stack,
not a suite.

The `e2e` job runs two root scripts and nothing else:

| Root script        | Delegates to                                     | Required?                        |
| ------------------ | ------------------------------------------------ | -------------------------------- |
| `yarn e2e`         | `yarn workspace @openbooks/e2e test:e2e`         | yes                              |
| `yarn e2e:install` | `yarn workspace @openbooks/e2e test:e2e:install` | no — Playwright browser download |

Those two delegations are the coupling between OB-056 and OB-055. If `packages/e2e` renames its
scripts, the root delegations are what must change; the workflow names only the root ones.

Nothing about the stack is CI's business. `packages/e2e/playwright.config.ts` declares both
servers as `webServer` entries, so `yarn e2e` on a laptop and the `e2e` job here are the same
thing — which is the property every other gate in this repo has.

**If `packages/e2e` is not on the ref** — a bisect, a branch cut before OB-055, a revert — the
job emits a `::notice` and stays green. **If it is present but the root `e2e` script is missing**,
the job fails loudly: that is an integration defect, not an absence, and a silent skip would drop
B1 out of CI without anything going red.

**This job has never been executed.** It is the only one in the file that has not. OB-055 was
still in flight in the working tree when OB-056 was written, and `yarn e2e` starts Compose and
drives a browser, which would have interfered with it. What _was_ run locally is the probe
script, in all four of its branches, against sandboxes. Its first real run is its first dispatch.

---

## Runner requirements

- **`ubuntu-latest`** for every job. Docker is present, which `test`, `drift-schema` and
  `build` all require.
- **Node 22.19.0**, read from `.nvmrc` by the composite setup action.
- **Yarn 4.17.1**, committed at `.yarn/releases/yarn-4.17.1.cjs`
  ([D-10](../ROADMAP.md#d-10)). CI never runs `corepack enable`, which needs write access to
  `/usr/local/bin` and network access to bootstrap. The `yarn` on the runner's PATH is Yarn 1
  and does not read `yarnPath` from `.yarnrc.yml`, so the committed release is invoked as
  `node "$YARN" …`; the setup action exports `$YARN`.
- **No self-hosted runner, no service containers, no registry credentials** are needed for any
  blocking job.

Dependencies install with `yarn install --immutable`, so a `yarn.lock` that disagrees with the
manifests fails the build instead of being rewritten. `enableScripts: false` in `.yarnrc.yml`
stays as it is — argon2 and esbuild resolve platform prebuilds at require time and need no
postinstall.

The Yarn global cache (`~/.yarn/berry/cache`) is cached on `yarn.lock`'s hash. `actions/setup-node`'s
own `cache: yarn` is not used, because it locates the cache by asking the `yarn` on PATH — Yarn 1 —
which names a directory this repository never writes to.

---

## Artifacts

`openapi.json` is uploaded on every run as **`openapi-spec`** (spec §12, acceptance A10). It is
uploaded even when the drift gate fails, because the committed-but-stale document is exactly
what you want to diff against what the routes now produce.

**`playwright-report`** is uploaded by `e2e` whenever that job ran, carrying
`packages/e2e/playwright-report` (the HTML report) and `packages/e2e/test-results` (traces and
screenshots — `playwright.config.ts` sets `trace: 'retain-on-failure'`). A green narrative leaves
no `test-results` directory at all, so the upload is `if-no-files-found: ignore`; a failed one is
thirty user actions deep and the trace viewer is the only practical way to see which broke.

Nothing else is published. In particular **no Terraform plan file is ever uploaded** —
`infra/terraform/README.md` flags that a saved plan leaks the RDS master password ARN and the
session secret. No `plan` runs at all today.

---

## Pushing the image to ECR

`publish-image` runs only when **both** conditions hold:

1. `github.ref == 'refs/heads/develop'`, and
2. `aws-preflight` found all three settings below.

Under the (currently commented-out) `push` trigger, condition 1 means "merged to `develop`",
which is what OB-027 specifies. Under `workflow_dispatch` it means somebody dispatched the run
with `develop` selected — the same branch condition, a human instead of a merge.

### What an operator must configure

| Kind                | Name             | Value                                                                              |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| Repository secret   | `AWS_ROLE_ARN`   | `arn:aws:iam::<account>:role/<role>` — an IAM role trusting GitHub's OIDC provider |
| Repository variable | `AWS_REGION`     | The region holding the ECR repository, e.g. `us-east-1`                            |
| Repository variable | `ECR_REPOSITORY` | Repository name, e.g. `openbooks/server`                                           |

`openbooks/server` is the default of `ecr_repository_name` in
`infra/terraform/variables.tf`; it is deliberately not environment-prefixed so an image can be
promoted between environments by digest.

`AWS_ROLE_ARN` is a **role**, not an access key: the job requests a short-lived OIDC token
(`id-token: write`, granted to that job alone) and exchanges it. No long-lived credential is
stored. That role has to be created by hand — `infra/terraform/README.md` lists it among the
things Terraform cannot create, because bootstrapping the identity that runs the pipeline with
the pipeline is circular. It needs `ecr:GetAuthorizationToken` plus push permissions on the one
repository, and its trust policy should be scoped to this repository and to
`ref:refs/heads/develop`.

### What happens with none of them set

That is the state of this repository today, and it is the expected state
([D-05](../ROADMAP.md#d-05) — nothing has ever been deployed). `aws-preflight` emits a
`::notice` naming what is missing, `publish-image` is **skipped** — grey, not red — and the run
is green. The job is written and reviewable; it has never run.

### Architecture

The pushed image is **`linux/arm64`**. The ECS task definitions in
`infra/terraform/modules/compute` are ARM64, and item 7 of `infra/terraform/README.md` names
the consequence: an amd64 image dies at startup with an exec-format error. On an amd64 runner
that means QEMU, and emulating a full install plus two bundlers is slow — budget 15–25 minutes
against 4–6 native. Switching that job's `runs-on` to `ubuntu-24.04-arm` removes both the QEMU
step and the penalty, where such runners are available to the repository's plan; it is left on
`ubuntu-latest` because that label always resolves.

The image is tagged with the commit SHA only. The repository is created
`image_tag_mutability = "IMMUTABLE"` and every task definition pins a tag, so a moving
`develop` tag would be rejected by the registry and would make "which code is running"
unanswerable.

`publish-image` pushes; it does not deploy. Registering a migrate task revision from the same
digest and running it to completion before the api service rolls (spec §12, acceptance A12) is
the deploy pipeline's job, and there is nothing to deploy to yet.

---

## Terraform

`terraform` is `continue-on-error: true` and is not in `publish-image`'s `needs`, so it reports
and blocks nothing. [D-05](../ROADMAP.md#d-05): the IaC is committed and reviewed but has never
been applied, and there are no credentials, so `plan` is not available — it needs credentials
for the first data source it evaluates. `fmt -check` plus `validate` is the ceiling.

The job runs `infra/scripts/tf-validate.sh`, which validates the two _roots_ and not the five
modules. That is correct, not a shortcut: a reusable module declares no provider
configuration, and `modules/edge` goes further and declares a `configuration_aliases` entry for
the us-east-1 provider CloudFront's ACM certificate requires. Validating it standalone fails
with "Provider configuration not present". `terraform validate` on a root validates every
module it composes, so the modules are covered.

Terraform's version comes from `terraform_version: '<2.0.0'`, which is the constraint in
`infra/terraform/versions.tf` verbatim rather than a pin in CI that could become a second
opinion.

**Make it blocking** by deleting the `continue-on-error: true` line, once credentials exist.

---

## Reproducing a job locally

Everything CI runs is a repo script. The whole static + drift + test set is `yarn check`.

```bash
# static
yarn format:check && yarn lint && yarn lint:tokens && yarn lint:deps && yarn typecheck

# spec drift (both halves, in this order — reversed, a route change reports as client drift)
yarn drift

# tests, real MySQL via testcontainers
yarn test

# web — the client bundle and the jsdom component suite, neither needs Docker
yarn build:web && yarn test:web

# e2e — brings up Compose, migrates, starts the API and Vite, drives a browser
yarn e2e:install   # once per machine
yarn e2e

# schema/codegen drift
docker compose up -d --wait mysql
OPENBOOKS_ROLE=migrate DATABASE_HOST=127.0.0.1 yarn migrate   # plus the rest of .env.example
DATABASE_HOST=127.0.0.1 yarn codegen
git diff --exit-code -- packages/server/src/db/generated.ts

# parity, and Terraform
bash infra/scripts/check-db-bootstrap-parity.sh
bash infra/scripts/tf-validate.sh
```

`drift-schema`'s environment block in `ci.yml` is the full, exact list `yarn migrate` needs —
it goes through the real config module, which requires a complete environment for the migrate
role by design. Note that `DATABASE_PASSWORD` and `DATABASE_MIGRATOR_PASSWORD` are not free
choices: they are literals in `docker/mysql-init/01-users.sql`, because MySQL's entrypoint does
not expand environment variables in `*.sql`.
