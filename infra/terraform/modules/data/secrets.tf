# ---------------------------------------------------------------------------
# Application credentials
# ---------------------------------------------------------------------------
#
# WHERE TERRAFORM STATE HOLDS SECRETS — stated plainly because it does, and pretending
# otherwise is worse than the exposure.
#
#   * random_password.app / random_password.migrator keep their generated value in
#     state in cleartext. So does every aws_secretsmanager_secret_version below,
#     including the assembled connection JSON.
#   * The RDS master password is the exception: manage_master_user_password hands
#     generation to RDS, so state holds only the secret's ARN.
#
# There is no Terraform-side fix for the first point — a resource that generates a value
# must remember it to stay idempotent. What follows from it:
#
#   * The state bucket is as sensitive as the database. state-backend/ gives it
#     versioning, KMS encryption, a TLS-only bucket policy and full public-access
#     blocking, and access to it must be treated as production database access.
#   * `terraform show`, `terraform output -json` and plan files all leak these values.
#     CI must never publish a plan file as a build artifact (a note for OB-027).
#   * The honest long-term answer is native rotation: let Secrets Manager generate and
#     rotate both application passwords on a schedule and have Terraform manage only the
#     secret container. That needs a rotation Lambda with VPC access to RDS, which is
#     the same problem the db-bootstrap task solves and deliberately out of scope for
#     M1. Recorded as follow-up work, not as solved.
#
# ROTATION IS NOT SELF-APPLYING. Changing either keeper below generates a new password
# and updates the secret, but the MySQL user still has the old one until the
# db-bootstrap task is re-run (its ALTER USER is unconditional for exactly this
# reason). Rotate, re-run bootstrap, then restart the tasks — in that order.

resource "random_password" "app" {
  length  = 40
  special = true
  # No apostrophe and no backslash: these values are interpolated into a single-quoted
  # SQL string literal by 01-users-rds.sql, where either character would terminate or
  # escape the literal.
  override_special = "!#%^*()-_=+[]{}:?."

  keepers = {
    rotation = "1"
  }
}

resource "random_password" "migrator" {
  length           = 40
  special          = true
  override_special = "!#%^*()-_=+[]{}:?."

  keepers = {
    rotation = "1"
  }
}

# Two secrets rather than one, so the execution role of the api/worker tasks can be
# granted the app credential without also being able to read the credential that holds
# DDL rights. That separation is the whole point of having two users.
resource "aws_secretsmanager_secret" "app" {
  name        = "${var.name_prefix}/db/app"
  description = "openbooks_app — SELECT/INSERT only; cannot UPDATE or DELETE journals."
  kms_key_id  = var.kms_key_arn
  # Long enough to matter if a secret is deleted by accident, short enough that a
  # name can be reused within a sprint.
  recovery_window_in_days = 14
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    username = local.app_username
    password = random_password.app.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = local.db_name
    engine   = "mysql"
  })
}

resource "aws_secretsmanager_secret" "migrator" {
  name                    = "${var.name_prefix}/db/migrator"
  description             = "openbooks_migrator — DDL rights; used only by the migrate task."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 14
}

resource "aws_secretsmanager_secret_version" "migrator" {
  secret_id = aws_secretsmanager_secret.migrator.id

  secret_string = jsonencode({
    username = local.migrator_username
    password = random_password.migrator.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = local.db_name
    engine   = "mysql"
  })
}
