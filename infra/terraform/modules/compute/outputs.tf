output "ecr_repository_url" {
  value = local.ecr_repository_url
}

output "ecr_repository_arn" {
  value = local.ecr_repository_arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "api_task_definition_family" {
  value = aws_ecs_task_definition.api.family
}

output "worker_task_definition_family" {
  value = aws_ecs_task_definition.worker.family
}

output "migrate_task_definition_family" {
  description = "Run this to completion, and require exit code 0, before rolling the api service forward (spec §12, A12). See the header of tasks.tf."
  value       = aws_ecs_task_definition.migrate.family
}

output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}

output "log_group_names" {
  value = {
    api      = aws_cloudwatch_log_group.api.name
    worker   = aws_cloudwatch_log_group.worker.name
    migrate  = aws_cloudwatch_log_group.migrate.name
    ecs_exec = aws_cloudwatch_log_group.exec.name
  }
}
