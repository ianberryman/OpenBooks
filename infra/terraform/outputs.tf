# Outputs exist for two consumers: the deploy pipeline (OB-027), which must not hardcode
# names Terraform owns, and the operator running the bootstrap runbook. Nothing here is
# sensitive — the secret ARNs are references, not values.

output "environment" {
  value = var.environment
}

output "region" {
  value = var.region
}

# --- URLs -----------------------------------------------------------------

output "api_url" {
  value = local.api_base_url
}

output "app_url" {
  value = local.app_base_url
}

# --- network (needed by every `aws ecs run-task` invocation) ---------------

output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  description = "Pass as awsvpcConfiguration.subnets when running the migrate or db-bootstrap task."
  value       = module.network.private_subnet_ids
}

output "app_security_group_id" {
  description = "Pass as awsvpcConfiguration.securityGroups when running the migrate or db-bootstrap task."
  value       = module.network.app_security_group_id
}

# --- compute --------------------------------------------------------------

output "ecr_repository_url" {
  value = module.compute.ecr_repository_url
}

output "ecs_cluster_name" {
  value = module.compute.ecs_cluster_name
}

output "api_service_name" {
  value = module.compute.api_service_name
}

output "worker_service_name" {
  value = module.compute.worker_service_name
}

output "api_task_definition_family" {
  value = module.compute.api_task_definition_family
}

output "worker_task_definition_family" {
  value = module.compute.worker_task_definition_family
}

output "migrate_task_definition_family" {
  description = "Must run to completion with exit code 0 before the api service is rolled forward (spec §12, A12)."
  value       = module.compute.migrate_task_definition_family
}

output "db_bootstrap_task_definition_family" {
  description = "Creates openbooks_migrator and openbooks_app with the shared grant split. Run once after the database exists, and again after any password rotation."
  value       = module.data.bootstrap_task_definition_family
}

# --- edge (needed to publish the web bundle) ------------------------------

output "web_bucket" {
  value = module.edge.web_bucket
}

output "cloudfront_distribution_id" {
  value = module.edge.cloudfront_distribution_id
}

output "alb_dns_name" {
  value = module.edge.alb_dns_name
}

# --- data -----------------------------------------------------------------

output "db_address" {
  value = module.data.db_address
}

output "db_name" {
  value = module.data.db_name
}

output "db_app_secret_arn" {
  value = module.data.app_secret_arn
}

output "db_migrator_secret_arn" {
  value = module.data.migrator_secret_arn
}

output "db_master_secret_arn" {
  description = "RDS-managed. Readable only by the db-bootstrap execution role; no application path uses it."
  value       = module.data.master_secret_arn
}

# --- messaging ------------------------------------------------------------

output "queue_url" {
  value = module.messaging.queue_url
}

output "dlq_url" {
  value = module.messaging.dlq_url
}

output "attachments_bucket" {
  value = module.messaging.attachments_bucket
}

output "ses_configuration_set_name" {
  value = module.messaging.ses_configuration_set_name
}

output "ses_mail_from_domain" {
  value = module.messaging.ses_mail_from_domain
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}
