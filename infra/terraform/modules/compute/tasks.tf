# ===========================================================================
# Task definitions — one image, three roles (spec §2.5)
# ===========================================================================
#
# All three families below reference local.image. The ONLY differences between them are
# OPENBOOKS_ROLE, sizing, which database credential is injected, and which AWS-facing env
# vars are present. If a future change makes one of these families use a different image,
# spec §2.5 has been violated and the change is wrong.
#
# GUESSES, all of them in this file, all cheap to correct:
# OB-003 owns the Zod environment schema and has not landed, so every variable name below
# is an assumption about what it will require. The discrete DB_* form was chosen over a
# single DATABASE_URL because assembling a URL would additionally guess the DSN's query
# parameter names for TLS. When OB-003 lands, reconcile against its schema — the failure
# mode is loud (OB-003 fails fast naming the missing variables) rather than silent.

locals {
  # Present in every role, including migrate. Nothing here is a secret.
  base_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "OPENBOOKS_ENV", value = var.environment },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "AWS_REGION", value = data.aws_region.current.region },

    { name = "DB_HOST", value = var.db_host },
    { name = "DB_PORT", value = tostring(var.db_port) },
    { name = "DB_NAME", value = var.db_name },
    # Belt and braces with the parameter group's require_secure_transport and the users'
    # REQUIRE SSL: the client is told to use TLS rather than discovering it must.
    { name = "DB_SSL", value = tostring(var.db_require_secure_transport) },
  ]

  # api and worker only. The migrate role has no reason to reach a queue, a bucket or an
  # email provider, and giving it those variables would invite a migration that uses them.
  app_environment = concat(local.base_environment, [
    { name = "DB_USER", value = var.db_app_username },

    # Spec §2.5: this is the entire hosted-vs-self-host difference. Self-host Compose sets
    # in-process / local / smtp against the same image and the same code path.
    { name = "QUEUE_PROVIDER", value = var.queue_provider },
    { name = "STORAGE_PROVIDER", value = var.storage_provider },
    { name = "EMAIL_PROVIDER", value = var.email_provider },

    { name = "SQS_QUEUE_URL", value = var.queue_url },
    { name = "S3_ATTACHMENTS_BUCKET", value = var.attachments_bucket },
    { name = "SES_CONFIGURATION_SET", value = var.ses_configuration_set_name },
    { name = "EMAIL_FROM_ADDRESS", value = var.ses_from_address },

    { name = "PUBLIC_API_URL", value = var.api_base_url },
    { name = "PUBLIC_APP_URL", value = var.app_base_url },
  ])

  app_secrets = [
    { name = "DB_PASSWORD", valueFrom = "${var.db_app_secret_arn}:password::" },
    { name = "SESSION_SECRET", valueFrom = var.session_secret_arn },
  ]

  # Writable /tmp as a Fargate ephemeral volume, so the container root filesystem can be
  # read-only. Fargate does not support tmpfs, and a nameless volume is the supported way
  # to get a writable mount without one.
  tmp_volume_name = "tmp"

  tmp_mount = [{
    sourceVolume  = local.tmp_volume_name
    containerPath = "/tmp"
    readOnly      = false
  }]

  linux_parameters = {
    # PID 1 in a container does not reap children or forward signals by default. Fargate's
    # init does both, which is what makes a graceful SIGTERM shutdown work at all.
    initProcessEnabled = true
  }
}

# ---------------------------------------------------------------------------
# api
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.app_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = local.tmp_volume_name
  }

  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = local.image
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = local.linux_parameters

      # Fargate's ceiling. Long enough for in-flight requests to drain, and the ALB
      # deregistration delay is set shorter than this in the edge module so connections
      # stop arriving before the process is asked to stop.
      stopTimeout = 120

      portMappings = [
        {
          name          = "http"
          containerPort = var.app_port
          protocol      = "tcp"
        }
      ]

      environment = concat(local.app_environment, [
        { name = "OPENBOOKS_ROLE", value = "api" },
        { name = "PORT", value = tostring(var.app_port) },
      ])

      secrets = local.app_secrets

      # No container-level healthCheck. The ALB target group already probes the same
      # endpoint over the same path, and a second probe implemented as a shell command
      # would mean shipping curl in the image for no additional signal.

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.app_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = local.tmp_volume_name
  }

  container_definitions = jsonencode([
    {
      name                   = "worker"
      image                  = local.image
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = local.linux_parameters
      stopTimeout            = 120

      # No portMappings: the worker accepts no inbound traffic. It is in the same security
      # group as the api tasks, whose only ingress rule references the ALB, so nothing can
      # reach it even if it did listen.

      environment = concat(local.app_environment, [
        { name = "OPENBOOKS_ROLE", value = "worker" },
      ])

      secrets = local.app_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# migrate — a task definition, NOT a service
# ---------------------------------------------------------------------------
#
# WHY THIS IS NOT A SERVICE, since it is the point of A12 and spec §12:
#
# A service keeps N copies of a process alive. Migrations are the opposite shape: they run
# exactly once, must exit zero, and must have finished before any new API task serves a
# request. Modelling them as a service would mean ECS restarting the migrator every time it
# exited — successfully — and several migrators racing during a rolling deploy.
#
# The alternative usually reached for is running migrations in the container entrypoint.
# Spec §12 forbids it and A12 tests that it does not happen, for a specific reason: with N
# api tasks starting concurrently, N migrators race on the same schema, and a failed
# migration surfaces as a task that will not stay up rather than as a deploy that stopped.
# packages/server/src/config/role.ts is the application-side half of this; this task
# definition is the infrastructure half.
#
# It also connects as openbooks_migrator — the only thing in the stack that does — which is
# why its execution role is separate and why the api tasks cannot read that credential.
#
# HOW IT IS INVOKED (OB-027 owns the pipeline; this is the contract it implements):
#
#   1. Build and push the image, tagged with the commit SHA.
#   2. Register a migrate revision carrying THAT image, then run it to completion:
#        aws ecs run-task \
#          --cluster        "$(terraform output -raw ecs_cluster_name)" \
#          --task-definition "$(terraform output -raw migrate_task_definition_family)" \
#          --launch-type    FARGATE \
#          --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...],assignPublicIp=DISABLED}"
#      then `aws ecs wait tasks-stopped` and assert the container's exit code is 0.
#   3. Only then update the api and worker services to the new image.
#
# THE GAP, STATED PLAINLY: `run-task --overrides` cannot change a container image. So step
# 2 must register a new revision of this family with the new image before running it; the
# revision Terraform creates here is a template, not the revision CI runs. That makes it
# possible for CI to migrate with one image and deploy another, which is the one ordering
# failure this design does not structurally prevent. OB-027 must derive both from the same
# digest in the same job. The alternative — Terraform owning the image tag and CI calling
# `terraform apply` between steps — closes that gap at the cost of giving the pipeline
# Terraform credentials and a second state lock per deploy. Flagged rather than decided.

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.migrate_cpu
  memory                   = var.migrate_memory
  execution_role_arn       = aws_iam_role.migrate_execution.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = local.tmp_volume_name
  }

  container_definitions = jsonencode([
    {
      name                   = "migrate"
      image                  = local.image
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_mount
      linuxParameters        = local.linux_parameters

      # A migration interrupted mid-DDL is the worst outcome available here, so the stop
      # timeout is the maximum Fargate allows.
      stopTimeout = 120

      environment = concat(local.base_environment, [
        { name = "OPENBOOKS_ROLE", value = "migrate" },
        { name = "DB_USER", value = var.db_migrator_username },
      ])

      secrets = [
        { name = "DB_PASSWORD", valueFrom = "${var.db_migrator_secret_arn}:password::" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
          "awslogs-region"        = data.aws_region.current.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}
