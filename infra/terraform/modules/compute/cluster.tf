resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }

  configuration {
    execute_command_configuration {
      kms_key_id = var.kms_key_arn
      logging    = "OVERRIDE"

      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.exec.name
      }
    }
  }
}

# Even with execute-command disabled in production, the audit log group exists — so that
# turning it on during an incident does not also mean deciding where the session
# transcript goes.
resource "aws_cloudwatch_log_group" "exec" {
  name              = "${local.log_group_prefix}/ecs-exec"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# One log group per role rather than one per cluster. The pino output (OB-009) is
# structured JSON and CloudWatch Insights queries are per log group, so separating them
# means "what did the workers do" is a query against worker logs rather than a filter over
# everything.
resource "aws_cloudwatch_log_group" "api" {
  name              = "${local.log_group_prefix}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "${local.log_group_prefix}/worker"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "${local.log_group_prefix}/migrate"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}
