# ===========================================================================
# THE TWO DATABASE USERS — hosted bootstrap
# ===========================================================================
#
# The RDS master user is neither `openbooks_app` nor `openbooks_migrator`. If the hosted
# database only ever had a master user, then spec §12's grant-level immutability and
# spec §11's "tested as the app user" would be true of Compose and false of production,
# and A6 would be theatre. This file exists so that is not the case.
#
# MECHANISM: a one-shot ECS Fargate task, in the private subnets, running a MySQL client
# image, that pipes infra/db-bootstrap/01-users-rds.sql then the shared
# infra/db-bootstrap/02-grants.sql into the instance as the master user, then asserts the
# resulting grants.
#
# WHY NOT TERRAFORM ITSELF: the mysql provider would have to reach a database in a
# private subnet from wherever Terraform runs. That means either making RDS publicly
# accessible, which contradicts the network design, or running Terraform from inside the
# VPC, which contradicts running it from CI. Neither is worth it to avoid one task.
#
# WHY NOT A LAMBDA: a Lambda is the tidier shape — it can be invoked by Terraform and
# reports success or failure in the apply. It needs a MySQL client in the deployment
# package, so either a vendored pure-Python driver or a container image Lambda. Both mean
# a build artifact under infra/ that has to be built, versioned and reviewed, to run
# roughly twenty lines of SQL. If DB bootstrap ever grows past this, a Lambda is the
# right migration target.
#
# WHY NOT THE OPENBOOKS IMAGE: it would honour spec §2.5 more literally, and it is the
# option to prefer if this is revisited. It was not chosen because `OPENBOOKS_ROLE` today
# accepts exactly api|worker|migrate (packages/server/src/config/role.ts) and adding a
# fourth role is application code, outside this ticket. Note the narrower reading: §2.5
# governs the application image, and a one-off DDL bootstrap is operational tooling, not
# the application. Recorded as a judgement call, not a certainty.
#
# TRADE-OFFS ACCEPTED, ALL OF THEM:
#   * A second image in the deploy path. Mitigated by pulling from the public ECR mirror
#     of the official image rather than Docker Hub (no rate limit, no credentials), but
#     the tag is mutable — pin var.db_bootstrap_image to a digest before first real use.
#   * Terraform registers the task definition and does NOT run it. Nothing in an apply
#     tells you the users exist. Running it is a documented step in the README's
#     bootstrap sequence, between `data` and `compute`.
#   * A local-exec provisioner could run it during apply. Deliberately not done: it would
#     make `plan` dishonest about what apply does, fail on any machine without the AWS
#     CLI, and leave Terraform owning an imperative action it cannot roll back.
#   * `ssl-mode=REQUIRED` encrypts but does not verify the server certificate — the
#     client image carries no RDS CA bundle. Acceptable for a task talking to a private
#     RDS endpoint inside the VPC over a security-group-restricted path; upgrade to
#     VERIFY_IDENTITY with the global RDS bundle if this ever runs from elsewhere.
#
# The task is idempotent (CREATE USER IF NOT EXISTS, unconditional ALTER USER, GRANT is
# additive) and is the correct response to both first provisioning and password rotation.

locals {
  # The users file needs shell expansion for the two generated passwords, so it goes
  # through an unquoted heredoc. The grants file must not be touched by the shell at all
  # — it is byte-identical to the Compose copy and contains backtick-quoted identifiers,
  # which an unquoted heredoc would run as command substitution — so it goes through a
  # quoted heredoc. That asymmetry is the reason for two heredocs rather than one.
  bootstrap_users_sql  = file("${var.bootstrap_sql_dir}/01-users-rds.sql")
  bootstrap_grants_sql = file("${var.bootstrap_sql_dir}/02-grants.sql")

  bootstrap_script = <<-EOT
    set -eu
    umask 077

    # A defaults file rather than --password= or MYSQL_PWD: the former puts the master
    # password in this container's process arguments, the latter in its environment
    # where any child process inherits it.
    cnf="$(mktemp)"
    printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\nssl-mode=REQUIRED\n' \
      "$${DB_HOST}" "$${DB_PORT}" "$${DB_MASTER_USER}" "$${DB_MASTER_PASSWORD}" > "$${cnf}"
    trap 'rm -f "$${cnf}"' EXIT INT TERM

    echo "==> creating openbooks_migrator and openbooks_app"
    mysql --defaults-extra-file="$${cnf}" <<SQL_USERS
    ${local.bootstrap_users_sql}
    SQL_USERS

    echo "==> applying the shared grant split (infra/db-bootstrap/02-grants.sql)"
    mysql --defaults-extra-file="$${cnf}" <<'SQL_GRANTS'
    ${local.bootstrap_grants_sql}
    SQL_GRANTS

    # Assert the guarantee rather than assume the SQL above did what it reads like it
    # does. A bootstrap that silently left openbooks_app able to UPDATE journals is
    # exactly the failure this whole file exists to prevent, so it fails the task.
    echo "==> verifying grants for openbooks_app"
    grants="$(mysql --defaults-extra-file="$${cnf}" -N -B -e "SHOW GRANTS FOR 'openbooks_app'@'%'")"
    printf '%s\n' "$${grants}"

    # Only the database-level line. Table-level UPDATE/DELETE on legitimately mutable
    # tables is granted later by migrations (OB-011) and must not fail this check.
    if printf '%s\n' "$${grants}" | grep -F 'ON `openbooks`.*' | grep -Eq 'UPDATE|DELETE|ALL PRIVILEGES'; then
      echo "FAIL: openbooks_app holds database-level UPDATE/DELETE. Journals are mutable." >&2
      exit 1
    fi

    if printf '%s\n' "$${grants}" | grep -E 'ON `openbooks`\.`journal' | grep -Eq 'UPDATE|DELETE|ALL PRIVILEGES'; then
      echo "FAIL: openbooks_app holds UPDATE/DELETE on a journal table." >&2
      exit 1
    fi

    echo "OK: openbooks_app cannot UPDATE or DELETE journals at the grant level."
  EOT
}

resource "aws_cloudwatch_log_group" "bootstrap" {
  name              = local.bootstrap_log_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${var.name_prefix}-db-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.bootstrap_execution.arn
  # No task role at all. This container makes no AWS API calls — its secrets are injected
  # by the execution role before the process starts.

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name                   = "db-bootstrap"
      image                  = var.bootstrap_image
      essential              = true
      entryPoint             = ["/bin/sh", "-c"]
      command                = [local.bootstrap_script]
      readonlyRootFilesystem = false # mktemp writes the client defaults file

      environment = [
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DB_MASTER_USER", value = aws_db_instance.main.username },
      ]

      secrets = [
        {
          name      = "DB_MASTER_PASSWORD"
          valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::"
        },
        {
          name      = "MIGRATOR_PASSWORD"
          valueFrom = "${aws_secretsmanager_secret.migrator.arn}:password::"
        },
        {
          name      = "APP_PASSWORD"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:password::"
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.bootstrap.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "db-bootstrap"
        }
      }
    }
  ])
}

data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# Execution role — the only identity in the stack allowed to read the master password
# ---------------------------------------------------------------------------

resource "aws_iam_role" "bootstrap_execution" {
  name                 = "${var.name_prefix}-db-bootstrap-exec"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Without these, any ECS task in any account that guesses the role name could assume
    # it. Both conditions are cheap and both are load-bearing.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role_policy" "bootstrap_execution" {
  name   = "bootstrap-execution"
  role   = aws_iam_role.bootstrap_execution.id
  policy = data.aws_iam_policy_document.bootstrap_execution.json
}

data "aws_iam_policy_document" "bootstrap_execution" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.bootstrap.arn}:*"]
  }

  # Three named secret ARNs. The master credential is readable by this role and by
  # nothing else in the stack — not by the api tasks, not by the migrate task.
  statement {
    sid     = "ReadBootstrapSecrets"
    actions = ["secretsmanager:GetSecretValue"]

    resources = [
      aws_db_instance.main.master_user_secret[0].secret_arn,
      aws_secretsmanager_secret.app.arn,
      aws_secretsmanager_secret.migrator.arn,
    ]
  }

  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}
