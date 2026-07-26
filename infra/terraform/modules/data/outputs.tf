output "db_address" {
  value = aws_db_instance.main.address
}

output "db_port" {
  value = aws_db_instance.main.port
}

output "db_name" {
  value = local.db_name
}

output "app_username" {
  value = local.app_username
}

output "migrator_username" {
  value = local.migrator_username
}

output "app_secret_arn" {
  description = "Secrets Manager ARN for openbooks_app. Read by the api and worker execution roles only."
  value       = aws_secretsmanager_secret.app.arn
}

output "migrator_secret_arn" {
  description = "Secrets Manager ARN for openbooks_migrator. Read by the migrate execution role only."
  value       = aws_secretsmanager_secret.migrator.arn
}

output "master_secret_arn" {
  description = "RDS-managed master credential. Read by the db-bootstrap execution role only; no application path uses it."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "bootstrap_task_definition_family" {
  description = "Pass to `aws ecs run-task --task-definition` for the one-time (and post-rotation) DB user bootstrap."
  value       = aws_ecs_task_definition.bootstrap.family
}

output "bootstrap_task_definition_arn" {
  value = aws_ecs_task_definition.bootstrap.arn
}
