# ===========================================================================
# Services
# ===========================================================================
#
# WHO OWNS THE DEPLOYED REVISION. Both services ignore changes to `task_definition`:
# Terraform declares the families (env vars, IAM, sizing) and CI (OB-027) rolls the running
# revision forward. Without the ignore, every `terraform apply` after a deploy would try to
# pull the service back to the tag in var.image_tag and undo it.
#
# The cost of that choice, so it is not discovered later: after the first CI deploy, this
# module's container definitions describe what the NEXT deploy will use, not what is
# running. Changing an environment variable here is inert until CI deploys again. The
# alternative — Terraform owning the deployed revision and CI invoking `terraform apply` —
# keeps declaration and reality together but needs Terraform credentials and a state lock in
# the deploy path. Flagged for OB-027 rather than decided here.

resource "aws_ecs_service" "api" {
  name            = "${var.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count

  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets = var.private_subnet_ids
    # Private subnets with NAT egress. A public IP on the task would make the app port
    # reachable from the internet subject only to the security group, which is one
    # misconfigured rule away from bypassing the ALB entirely.
    assign_public_ip = false
    security_groups  = [var.app_security_group_id]
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.app_port
  }

  # Long enough for Node to start and connect to MySQL before failed health checks begin
  # killing tasks. Too short here presents as a deploy that never stabilises.
  health_check_grace_period_seconds = 60

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    # A bad image rolls itself back instead of draining the healthy tasks. This is also
    # what makes the migrate-then-deploy ordering survivable: if migrations succeeded but
    # the new code is broken, the service returns to the previous revision on its own.
    enable   = true
    rollback = true
  }

  # Terraform cannot enforce "migrations have run" as a dependency — the migrate task is
  # invoked by CI, outside any Terraform graph. What it can enforce is ordering against the
  # listener: registering with a target group whose listener does not exist yet fails inside
  # ECS as an opaque service error rather than as a dependency error. `target_group_arn`
  # alone only orders against the target group, so the root composition additionally
  # declares `depends_on = [module.edge]` on this module.

  lifecycle {
    ignore_changes = [
      task_definition, # CI owns the running revision; see the note above
      desired_count,   # autoscaling owns this after creation
    ]
  }
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name_prefix}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count

  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"

  # Spot is acceptable for a queue consumer only because SQS redelivers anything not
  # deleted: a two-minute Spot interruption notice returns in-flight messages to the queue
  # after the visibility timeout. It is not acceptable for the api service, where an
  # interruption is a dropped request.
  dynamic "capacity_provider_strategy" {
    for_each = var.worker_use_spot ? [1] : []

    content {
      capacity_provider = "FARGATE_SPOT"
      weight            = 1
    }
  }

  dynamic "capacity_provider_strategy" {
    for_each = var.worker_use_spot ? [] : [1]

    content {
      capacity_provider = "FARGATE"
      weight            = 1
    }
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    assign_public_ip = false
    security_groups  = [var.app_security_group_id]
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

# ---------------------------------------------------------------------------
# Autoscaling — api only
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name_prefix}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = 60

    # Asymmetric on purpose: scale out quickly, scale in slowly. Removing capacity during a
    # lull that turns out to be a trough costs a second scale-out and a latency spike.
    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}

# The worker is deliberately NOT autoscaled. The right signal is queue backlog per task
# (ApproximateNumberOfMessagesVisible divided by running count), which needs a metric math
# alarm and a target-tracking policy against a custom metric. In M1 nothing enqueues
# anything (ROADMAP: the worker role starts cleanly with no registered jobs), so that
# machinery would be tuned against zero traffic. Add it with the first real job.
