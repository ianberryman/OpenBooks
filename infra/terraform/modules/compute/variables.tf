variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

# --- network ---------------------------------------------------------------

variable "private_subnet_ids" {
  type = list(string)
}

variable "app_security_group_id" {
  type = string
}

variable "target_group_arn" {
  description = "ALB target group for the api service, from the edge module."
  type        = string
}

# --- image ----------------------------------------------------------------

variable "manage_ecr_repository" {
  description = "Create the ECR repository here. Exactly one environment in an account should own it, so an image can be promoted between environments by digest instead of rebuilt."
  type        = bool
  default     = true
}

variable "ecr_repository_name" {
  description = "Deliberately not environment-prefixed. One image, promoted; see manage_ecr_repository."
  type        = string
  default     = "openbooks/server"
}

variable "image_tag" {
  type = string
}

variable "cpu_architecture" {
  type = string
}

variable "ecr_untagged_expiry_days" {
  type = number
}

variable "ecr_tagged_image_count" {
  type = number
}

# --- sizing ---------------------------------------------------------------

variable "app_port" {
  type = number
}

variable "api_cpu" {
  type = number
}

variable "api_memory" {
  type = number
}

variable "api_desired_count" {
  type = number
}

variable "api_max_count" {
  type = number
}

variable "worker_cpu" {
  type = number
}

variable "worker_memory" {
  type = number
}

variable "worker_desired_count" {
  type = number
}

variable "worker_use_spot" {
  type = bool
}

variable "migrate_cpu" {
  type = number
}

variable "migrate_memory" {
  type = number
}

variable "enable_execute_command" {
  type = bool
}

variable "log_retention_days" {
  type = number
}

# --- database -------------------------------------------------------------

variable "db_host" {
  type = string
}

variable "db_port" {
  type = number
}

variable "db_name" {
  type = string
}

variable "db_app_username" {
  type = string
}

variable "db_migrator_username" {
  type = string
}

variable "db_app_secret_arn" {
  type = string
}

variable "db_migrator_secret_arn" {
  type = string
}

variable "db_require_secure_transport" {
  type = bool
}

# --- providers (spec §2.5) ------------------------------------------------

variable "queue_provider" {
  type = string
}

variable "storage_provider" {
  type = string
}

variable "email_provider" {
  type = string
}

variable "queue_url" {
  type = string
}

variable "queue_arn" {
  type = string
}

variable "dlq_arn" {
  type = string
}

variable "attachments_bucket" {
  type = string
}

variable "attachments_bucket_arn" {
  type = string
}

variable "ses_identity_arn" {
  type = string
}

variable "ses_configuration_set_arn" {
  type = string
}

variable "ses_configuration_set_name" {
  type = string
}

variable "ses_from_address" {
  type = string
}

variable "session_secret_arn" {
  type = string
}

# --- application config ---------------------------------------------------

variable "api_base_url" {
  type = string
}

variable "app_base_url" {
  type = string
}

variable "log_level" {
  type = string
}
