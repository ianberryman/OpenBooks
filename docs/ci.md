# CI — operator guide

The pipeline is one workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), plus
one composite action, [`.github/actions/setup`](../.github/actions/setup/action.yml). This file
is for whoever is setting the repository up. Why each gate exists is in the workflow's own
comments, next to the gate.

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
  dispatch ──────────────────────────┼─ test ────────── DB ─────┼──► publish-image
                                     ├─ parity ─────────────────┤     (develop +
                                     ├─ build ─────────── Docker┤      AWS configured)
                                     ├─ aws-preflight ──────────┘
                                     └─ terraform (advisory, blocks nothing)
```

Eight of the nine jobs start at once and share nothing; there is no `needs` between them.
`publish-image` is the only job with dependencies, and `terraform` is deliberately not one of
them (see [Terraform](#terraform)).

| Job             | Needs a database?               | Needs Docker? | Typical wall clock                 |
| --------------- | ------------------------------- | ------------- | ---------------------------------- |
| `static`        | no                              | no            | ~1m30s (≈70s install, ~12s checks) |
| `drift-spec`    | no                              | no            | ~1m20s (checks are ~2s)            |
| `drift-schema`  | **yes** — MySQL 8.4 via Compose | yes           | ~2m30s                             |
| `test`          | **yes** — testcontainers        | yes           | ~2m30s                             |
| `parity`        | no                              | no            | ~15s (no install at all)           |
| `build`         | no                              | yes           | ~5m (the image build dominates)    |
| `terraform`     | no                              | no            | ~1m30s (provider download)         |
| `aws-preflight` | no                              | no            | ~10s                               |
| `publish-image` | no                              | yes           | skipped today — see below          |

Critical path is `build`, so a green run is roughly **5–6 minutes** wall clock, against about
15 minutes of billed runner time across the nine jobs.

Those numbers are extrapolated from local measurements on an M-series Mac, not observed on a
GitHub runner — GitHub's runners are slower per core, and the two figures the estimates lean on
hardest are the `yarn install --immutable` (~70s cold cache, ~25s warm) and the Docker image
build. What was measured locally: static checks 11.4s total, both drift gates 2.1s,
`yarn test` 28.2s for 667 tests across 51 files, `yarn build` 1.2s warm, Compose MySQL to
healthy 5.8s, migrations 1.3s, codegen 1.2s, parity script 0.02s.

### Which jobs need the database, and how they get one

Two do, by different mechanisms, and the difference is not arbitrary.

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

Everything else is database-free and can be read as pure functions of the checkout.

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
yarn format:check && yarn lint && yarn lint:deps && yarn typecheck

# spec drift (both halves, in this order — reversed, a route change reports as client drift)
yarn drift

# tests, real MySQL via testcontainers
yarn test

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
