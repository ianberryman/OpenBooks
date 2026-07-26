# OpenBooks — hosted stack (Terraform)

Terraform for the topology in spec §3: **Route53 → CloudFront (static) / ALB → Fargate (api +
worker) → RDS MySQL**, plus ECR, SQS, S3, Secrets Manager and SES.

> ## This has never been applied
>
> Per [D-05](../../ROADMAP.md#d-05), M1 commits IaC that is written and reviewed but **not
> applied**. There is no OpenBooks AWS account. Nothing in this directory has created a
> resource, and `terraform plan` has never run against a real provider — `plan` requires
> credentials for the very first data source it evaluates, so "plan-clean" is not a claim
> that can honestly be made here.
>
> **What has actually been verified:** `terraform fmt -recursive -check` is clean, and
> `terraform init -backend=false && terraform validate` succeeds for both roots (which
> validates every module they compose). That proves the configuration is syntactically valid,
> that every reference resolves, and that no resource has an unknown argument or a
> type-mismatched one. It proves nothing about whether AWS will accept it.
>
> [What to expect to break on the first real apply](#what-to-expect-to-break-on-the-first-real-apply)
> is not a formality. Read it before running anything.

---

## Layout

```
infra/
  .gitignore                     re-includes modules/data (see the file; the root
                                 .gitignore's bare `data/` pattern excludes it)
  db-bootstrap/
    01-users-rds.sql             RDS-specific: creates both users, passwords via shell env
    02-grants.sql                SHARED BYTE-FOR-BYTE with docker/mysql-init/ — the grant split
  scripts/
    tf-validate.sh               fmt + validate, no credentials needed
    check-db-bootstrap-parity.sh fails if 02-grants.sql diverges between environments
  terraform/
    versions.tf                  required_version and pinned providers
    backend.tf                   partial S3 backend — no bucket name in tracked code
    providers.tf                 default region + the us-east-1 alias CloudFront requires
    variables.tf  locals.tf      inputs and derived names
    kms.tf  secrets.tf           the per-environment CMK; the session signing secret
    main.tf  outputs.tf          module composition; everything OB-027 needs to deploy
    .terraform.lock.hcl          COMMITTED — provider checksums
    env/
      hosted-prod.tfvars         durable settings
      hosted-prod.backend.hcl    state key + bucket placeholder
      staging.tfvars             cheap settings, identical topology
      staging.backend.hcl
    state-backend/               separate root, LOCAL state, applied once per account
    modules/
      network/                   VPC, subnets, NAT, flow logs, the three security groups
      data/                      RDS, parameter group, credentials, DB-user bootstrap task
      messaging/                 SQS + DLQ, attachments bucket, SES identity and DNS
      compute/                   ECR, ECS cluster, 3 task definitions, 2 services, autoscaling
      edge/                      ACM, ALB + listeners, CloudFront + OAC, Route53 records
```

**Two roots, five modules.** The five modules declare no provider configuration, which is
correct module hygiene and also means they are not independently validatable —
`modules/edge` goes further and declares a `configuration_aliases` entry for
`aws.us_east_1`, so validating it standalone fails with "Provider configuration not
present". That is correct behaviour, not a defect. `terraform validate` on the root validates
every module it composes, which is what `scripts/tf-validate.sh` relies on.

**One root, one state file per environment.** Not workspaces: workspaces share a backend
configuration and one careless `terraform workspace select` applies staging's plan to
production. Separate `-backend-config` files make the environment a property of `init`.

---

## Terraform version

`>= 1.9.0, < 2.0.0`. Developed and validated against **1.15.8**. The committed
`.terraform.lock.hcl` pins `hashicorp/aws` 6.56.0 and `hashicorp/random` 3.9.0 with
checksums; `terraform init` will honour it rather than re-resolving.

`env/*.backend.hcl` uses S3-native state locking (`use_lockfile = true`), which needs
Terraform >= 1.10. If you are pinned below that, drop the line and use the DynamoDB table
`state-backend/` also creates — both mechanisms are provisioned so either works.

---

## Bootstrap sequence

The order matters, and only the first three steps are one-time.

### 1. State backend (once per AWS account)

```bash
cd infra/terraform/state-backend
terraform init
terraform apply -var 'bucket_name=openbooks-tfstate-<something-globally-unique>'
terraform output -raw bucket
```

This root keeps its state locally and on purpose — it creates the bucket the other root needs,
so it cannot store state there itself. Its state is not committed (`.gitignore` excludes
`*.tfstate`); every resource in it carries `prevent_destroy`, and re-deriving it from code is
a two-minute apply if the local file is lost.

Put the bucket name into both `env/*.backend.hcl` files, replacing `REPLACE-ME-…`.

### 2. Network and data

```bash
cd infra/terraform
terraform init -backend-config=env/hosted-prod.backend.hcl
terraform apply -var-file=env/hosted-prod.tfvars -target=module.network -target=module.data
```

`-target` is used here and nowhere else. It exists because step 3 has to happen between the
database being created and the compute tier existing, and there is no way to express "run
this task now" inside a single apply.

Expect step 2 to take 10–20 minutes; the multi-AZ RDS instance dominates it.

### 3. The two database users — **do not skip this**

```bash
cd infra/terraform
CLUSTER=$(terraform output -raw ecs_cluster_name)          # after step 4 the first time; see note
FAMILY=$(terraform output -raw db_bootstrap_task_definition_family)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw app_security_group_id)

aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$FAMILY" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}"

# then wait, and read the log group /openbooks/<env>/db-bootstrap
```

> **Ordering wrinkle, stated because it is a real one.** The bootstrap task definition lives in
> `module.data`, but `aws ecs run-task` needs a _cluster_, which lives in `module.compute`. So
> on a truly clean account the practical order is: step 2, then apply `module.compute` (step 4) which brings up the cluster, then run this task, then let the services stabilise. The
> api service will be unhealthy in the gap, because `openbooks_app` does not exist yet. That
> is visible and self-correcting, but it is a gap, and the cleaner alternative — a dedicated
> minimal cluster in `module.data` purely to host this one task — was rejected as more
> permanent machinery than the problem deserves.

The task creates `openbooks_migrator` and `openbooks_app`, applies the shared grant split,
and then **asserts** that `openbooks_app` holds no database-level `UPDATE`/`DELETE` and none
on the journal tables. It exits non-zero if the guarantee does not hold. Re-run it after any
password rotation: rotating a secret does not change the MySQL user.

Read `modules/data/bootstrap.tf` before changing anything here. Its header documents why an
ECS task was chosen over Terraform's mysql provider, a Lambda, or the OpenBooks image itself,
and what each of those would have cost.

### 4. Everything else

```bash
terraform apply -var-file=env/hosted-prod.tfvars
```

### 5. Migrations, then deploy — every deploy, in this order

Spec §12 and acceptance criterion A12: migrations run as a **discrete pre-deploy job** that
must succeed before new API tasks go live, and never on container boot. OB-027 owns the
pipeline; the contract it implements is documented at the top of
`modules/compute/tasks.tf`, including the one ordering gap this design does not structurally
close (`run-task --overrides` cannot change a container image, so CI must register a migrate
revision from the same digest it is about to deploy).

### 6. Web bundle

```bash
aws s3 sync packages/web/dist "s3://$(terraform output -raw web_bucket)/" --delete
aws cloudfront create-invalidation \
  --distribution-id "$(terraform output -raw cloudfront_distribution_id)" --paths '/*'
```

---

## Checks

```bash
infra/scripts/tf-validate.sh                  # fmt -check + validate, both roots, no credentials
infra/scripts/check-db-bootstrap-parity.sh    # 02-grants.sql identical across environments
```

The parity check is the mechanical answer to the ROADMAP risk that "the dual-DB-user
requirement touches four environments … a mismatch makes A6 pass locally and mean nothing in
production." `infra/db-bootstrap/02-grants.sql` and `docker/mysql-init/02-grants.sql` are
compared with `cmp`, which is why that file has no placeholders and hardcodes the schema name
`openbooks`. While `docker/mysql-init/` does not exist yet (OB-004 owns it) the check warns
rather than fails — and says so loudly, because unchecked parity means A6 is unproven.

---

## The two database users

`openbooks_migrator` holds DDL. `openbooks_app` holds `SELECT`/`INSERT` and, critically, is
**never** granted `UPDATE` or `DELETE` at database level. The RDS master user is neither, is
generated and held by RDS in Secrets Manager, and is readable by exactly one IAM role in the
stack (the bootstrap task's execution role).

The mechanism deserves one paragraph here because it is the non-obvious part. MySQL privileges
are additive and a database-level grant **cannot** be revoked at table level: granting
`UPDATE ON openbooks.*` and then revoking `UPDATE ON openbooks.journals` leaves the
database-level privilege intact and the journal mutable — a `REVOKE` that appears to work and
does nothing. So `openbooks_app` gets `SELECT, INSERT` at database level and nothing more, and
migrations (OB-011) grant `UPDATE`/`DELETE` **per table** to the tables that are legitimately
mutable, never to `journals` or `journal_lines`. The privilege is absent rather than revoked.

The cost of that: every future migration introducing a mutable table must also grant
table-level `UPDATE`/`DELETE` on it. Forgetting fails loudly and safely — the write is denied
and its test fails — which is the correct direction for the failure to point.

---

## Where Terraform state holds secrets

It does, and there is no configuration that makes it stop.

- `random_password` for `openbooks_app`, `openbooks_migrator` and the session signing key all
  store their generated values in state in cleartext. A resource that generates a value must
  remember it to stay idempotent.
- Every `aws_secretsmanager_secret_version` stores its `secret_string` in state, including the
  assembled connection JSON.
- **The exception:** the RDS master password. `manage_master_user_password = true` hands
  generation to RDS, so state holds only an ARN. That is the reason to prefer it over
  `random_password` even though the ARN is unknowable until after create.

What follows:

- **The state bucket is as sensitive as the production database.** `state-backend/` gives it
  versioning, KMS encryption, a TLS-only and encryption-required bucket policy, and full
  public-access blocking. Grant access to it as you would grant production database access.
- `terraform show`, `terraform output -json` and saved plan files all leak these values. **CI
  must never publish a plan file as a build artifact** — a note for OB-027.
- The honest long-term fix is Secrets Manager native rotation, with Terraform managing only
  the secret container. That needs a rotation Lambda with VPC access to RDS, which is the same
  problem `modules/data/bootstrap.tf` solves and deliberately out of M1 scope. Recorded as
  follow-up, not as solved.

---

## IAM scoping

Two roles per task family, and no `Resource: "*"` except where the AWS API has no resource to
scope to. The three cases where it appears — `ecr:GetAuthorizationToken`, the four
`ssmmessages:*` actions, and the `kms:*` account-administration statement in the key policy —
each say so at the statement.

| Identity          | Can read                               | Notably cannot                            |
| ----------------- | -------------------------------------- | ----------------------------------------- |
| api/worker exec   | app DB secret, session secret          | the migrator secret, the master secret    |
| migrate exec      | migrator DB secret                     | the app secret, the master secret         |
| db-bootstrap exec | master + app + migrator secrets        | nothing else in the account               |
| api task          | S3 attachments, SES send, SQS **send** | receive or delete from any queue; the DLQ |
| worker task       | S3 attachments, SES send, SQS consume  | delete from the DLQ                       |
| migrate task      | nothing                                | any AWS API at all                        |

The API can enqueue but not consume; the worker can consume but not purge the DLQ; the
migrator — the one identity with DDL rights — has no AWS permissions whatsoever. SES sends are
conditioned on `ses:FromAddress`, so a compromised task cannot send as `billing@`.

`enable_execute_command` is the one switch that widens this (it adds `ssmmessages:*` to the
task roles, i.e. an interactive shell in a container holding live DB credentials). Off in
`hosted-prod.tfvars`, on in `staging.tfvars`.

---

## Deliberately NOT managed here

Each of these is a decision, not an omission.

- **The Route53 hosted zone.** Looked up with a data source, not created. Zone creation is
  entangled with registrar delegation, and a Terraform-managed zone that gets destroyed takes
  the delegation with it.
- **DNS records not related to this stack.** MX for inbound mail, verification TXT records for
  third parties. Note that the SES module _does_ publish `_dmarc.<root_domain>`, which will
  conflict on first apply if the zone already has one.
- **Leaving the SES sandbox.** A support request against the account. Until it is granted, the
  identity is correctly configured and cannot email a customer.
- **SNS topics and alarm actions.** The DLQ alarm exists with no action attached. Who gets
  paged is an on-call decision.
- **AWS accounts, Organizations, SSO, IAM users, CI's deploy role.** Bootstrapping the identity
  that runs Terraform cannot be done by Terraform. OB-027 will need an OIDC role for GitHub
  Actions; that belongs with the pipeline or in a separate account-level root.
- **The CI/CD pipeline itself.** OB-027.
- **WAF on the ALB or CloudFront.** Deferred, not dismissed. A WAF with untuned managed rule
  groups in front of an accounting API blocks legitimate requests, and there is no traffic to
  tune against.
- **Budgets and cost anomaly detection.** Account-level, not per-environment.
- **Container image contents.** OB-004's Dockerfile. This directory only says which tag runs.

---

## Cost notes

Order-of-magnitude, us-east-1, on-demand, ignoring data transfer and free tiers. Treat as
"what dominates", not as a quote.

**hosted-prod, roughly $260–320/month**

| Item                                   | ~$/mo | Note                                            |
| -------------------------------------- | ----: | ----------------------------------------------- |
| RDS `db.t4g.small` multi-AZ + 50GB gp3 |  ~100 | Multi-AZ is 2× the instance. Non-negotiable.    |
| NAT gateways ×2                        |   ~65 | Hourly only; data processing is on top.         |
| ALB                                    |   ~20 | Plus LCU charges.                               |
| Fargate: 2× api (0.5vCPU/1GB) ARM64    |   ~35 | ARM64 is ~20% under x86 per vCPU-hour.          |
| Fargate: 1× worker (0.25vCPU/0.5GB)    |    ~9 |                                                 |
| CloudWatch logs + Container Insights   |   ~15 | Enhanced Container Insights is the larger half. |
| KMS key + requests                     |    ~2 | One key, not one per service, for this reason.  |
| CloudFront, S3, SQS, Secrets, SES      |    ~5 | Effectively noise at M1 volumes.                |

**staging, roughly $75–95/month** — single NAT (−$33), single-AZ `db.t4g.micro` (−$75),
one Spot api task, no Performance Insights, no ALB access logs, 14-day log retention.

Levers, roughly in order of return: `single_nat_gateway = true`; drop RDS to single-AZ (do
**not** do this in prod); `worker_use_spot`; `containerInsights` back to `enabled` from
`enhanced`; shorter `log_retention_days`.

**When interface VPC endpoints start paying for themselves.** The S3 _gateway_ endpoint is
free and is provisioned — it takes ECR layer pulls and attachment traffic off NAT. Interface
endpoints for ECR API, Secrets Manager, SQS and CloudWatch Logs cost ~$7/month each per AZ
(~$56/month for four across two AZs), against NAT data processing at $0.045/GB. Below roughly
1.2 TB/month of AWS-bound egress, NAT is cheaper. Revisit if log volume or attachment traffic
grows; it would also let the app security group's egress rule be narrowed from `0.0.0.0/0` to
the endpoints, which is the other reason to want it.

---

## What to expect to break on the first real apply

Ordered by how confident I am it will bite. Nothing below is speculative hedging — each is a
specific place this configuration makes an assumption it could not check.

1. **`require_secure_transport` + `REQUIRE SSL` will refuse the app's connections.** The
   parameter group forces TLS and both users are created `REQUIRE SSL`, but nothing in
   `packages/server` configures a TLS connection yet — OB-003 owns the env schema and OB-008
   the mysql2 connection. Presents as every task failing health checks with an access-denied
   or handshake error. Fix in the application (mysql2 `ssl` options, RDS CA bundle); the
   escape hatch is `db_require_secure_transport = false` plus dropping `REQUIRE SSL` from
   `01-users-rds.sql`, which is a real security regression and should be temporary.
2. **Every container environment variable name is a guess.** OB-003's Zod schema does not
   exist. `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_SSL`, `QUEUE_PROVIDER`,
   `STORAGE_PROVIDER`, `EMAIL_PROVIDER`, `SQS_QUEUE_URL`, `S3_ATTACHMENTS_BUCKET`,
   `SES_CONFIGURATION_SET`, `EMAIL_FROM_ADDRESS`, `PUBLIC_API_URL`, `PUBLIC_APP_URL`,
   `SESSION_SECRET`, `LOG_LEVEL`, `OPENBOOKS_ENV` — all assumptions. Only `OPENBOOKS_ROLE` and
   `PORT` are grounded in committed code. The failure is loud (OB-003 fails fast naming what
   is missing) and the fix is confined to `modules/compute/tasks.tf`.
3. **`api_health_check_path = "/v1/health"` is a guess.** OB-022 owns the route. Wrong value
   means every deploy fails health checks and the circuit breaker rolls it back — loud, but
   confusing until you look at the target group.
4. **`root_domain` is `example.com` in both tfvars files.** The `aws_route53_zone` data source
   fails immediately. This is the first thing that will stop an apply, and deliberately so —
   better than a plausible-looking wrong domain.
5. **The state bucket name is `REPLACE-ME-…`.** `init` fails until it is set.
6. **`aws_ecs_cluster` `containerInsights = "enhanced"`** requires the account to have
   accepted the enhanced-observability pricing model. May need `"enabled"` instead.
7. **ARM64 everywhere.** The task definitions and the bootstrap task are `ARM64`. If CI builds
   `linux/amd64`, tasks die at startup with an exec-format error. `cpu_architecture` is one
   variable; the coupling to OB-027's build is the real risk.
8. **RDS `engine_version = "8.0.42"`** may not be an available version by the time this runs.
   AWS retires minor versions. It is pinned rather than floated because it must match Compose
   and testcontainers, so bumping it is a three-place change.
9. **The db-bootstrap task's public ECR image tag is mutable.** `public.ecr.aws/docker/library/mysql:8.4`
   should be pinned to a digest before anything real depends on it.
10. **SES DKIM record propagation vs. `behavior_on_mx_failure = "REJECT_MESSAGE"`.** Verification
    is asynchronous and the identity is unusable until DNS propagates. Sends fail until then.
11. **The `_dmarc` record may already exist** in the zone, which is a create conflict rather
    than a graceful merge.
12. **IAM eventual consistency.** A first apply that creates roles and immediately creates ECS
    services that assume them occasionally fails with a propagation error. Re-running the apply
    is normally the whole fix.
13. **KMS key policy vs. RDS.** The `AwsServiceUse` statement is written from the documented
    service principals for RDS, Secrets Manager, SQS and SES. If one of them needs a grant
    shape this policy does not allow, it presents as a create failure on the resource, not on
    the key.
14. **`prevent_destroy` on the RDS instance and both S3 buckets** means a genuine teardown
    requires editing tracked code. That is intentional and will still be annoying the first
    time it is wanted in staging.

There is no `terraform plan` output to check any of this against, because there is no account
to plan against. That is the honest state of this directory.
