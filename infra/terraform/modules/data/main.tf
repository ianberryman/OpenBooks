locals {
  # Fixed product constant, not a variable. infra/db-bootstrap/02-grants.sql is shared
  # byte-for-byte with docker/mysql-init/ and enforced by cmp, so it cannot carry a
  # placeholder for the schema name. See that file's header.
  db_name = "openbooks"

  app_username       = "openbooks_app"
  migrator_username  = "openbooks_migrator"
  log_group_prefix   = "/openbooks/${var.environment}"
  bootstrap_log_name = "${local.log_group_prefix}/db-bootstrap"
}

resource "aws_db_subnet_group" "main" {
  name       = var.name_prefix
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_parameter_group" "main" {
  # name_prefix, not name: create_before_destroy needs the replacement to coexist with the
  # original, and a fixed name makes that a duplicate-name error instead.
  name_prefix = "${var.name_prefix}-mysql-"
  family      = var.parameter_group_family
  description = "${var.name_prefix} MySQL parameters"

  # PARITY-CRITICAL — these four must match Compose and testcontainers (OB-004, OB-014).
  # Character set, collation, time zone and sql_mode all change query results and
  # constraint behaviour, so a difference here means the invariant suite (OB-025) proves
  # something about a database that is not the one in production.
  parameter {
    name  = "character_set_server"
    value = "utf8mb4"
  }

  parameter {
    name  = "collation_server"
    value = "utf8mb4_0900_ai_ci"
  }

  parameter {
    name  = "time_zone"
    value = "UTC"
  }

  # STRICT_ALL_TABLES rather than MySQL 8's default STRICT_TRANS_TABLES: with InnoDB the
  # two behave identically, and naming the stricter one means an accidental
  # non-transactional table cannot start silently truncating.
  parameter {
    name  = "sql_mode"
    value = "STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"
  }

  # HOSTED-ONLY — no Compose equivalent expected or wanted.
  dynamic "parameter" {
    for_each = var.require_secure_transport ? [1] : []

    content {
      name  = "require_secure_transport"
      value = "1"
    }
  }

  # A6/A9 are about grant failures and lock races. When one of those tests fails against
  # the hosted database, the deadlock graph is the evidence, and it is not recoverable
  # after the fact.
  parameter {
    name  = "innodb_print_all_deadlocks"
    value = "1"
  }

  parameter {
    name  = "log_output"
    value = "FILE"
  }

  # DELIBERATELY NOT SET: transaction_isolation. MySQL's default REPEATABLE READ is what
  # OB-020's period-lock race (A9) is designed against, and changing the isolation level
  # from infrastructure would silently change the semantics of the ledger's only write
  # path. If READ COMMITTED is ever wanted it is OB-020's decision to make, in a
  # migration or a connection setting, not this file's.

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# The database
# ---------------------------------------------------------------------------

resource "aws_db_instance" "main" {
  identifier = var.name_prefix

  engine         = "mysql"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name              = local.db_name
  db_subnet_group_name = aws_db_subnet_group.main.name
  parameter_group_name = aws_db_parameter_group.main.name
  # Private subnets and never publicly reachable. The only path to this database is a
  # Fargate task in the app security group.
  publicly_accessible    = false
  vpc_security_group_ids = [var.db_security_group_id]
  port                   = 3306

  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az                    = var.multi_az
  backup_retention_period     = var.backup_retention_days
  backup_window               = "04:00-05:00"
  maintenance_window          = "Sun:05:30-Sun:06:30"
  copy_tags_to_snapshot       = true
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  # The master user's password is generated and rotated by RDS directly into Secrets
  # Manager. This is the one credential Terraform never sees, so it is the one that
  # never lands in state — the reason to prefer it over random_password even though it
  # means the ARN is only knowable after create.
  username                      = "openbooks_master"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  performance_insights_enabled          = var.performance_insights
  performance_insights_retention_period = var.performance_insights ? 7 : null
  performance_insights_kms_key_id       = var.performance_insights ? var.kms_key_arn : null
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["error", "slowquery"]

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-final"
  apply_immediately         = false

  lifecycle {
    # Losing a ledger to a plan nobody read carefully is not a recoverable mistake.
    prevent_destroy = true
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${var.name_prefix}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
