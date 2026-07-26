variable "name_prefix" {
  type = string
}

variable "environment" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "db_security_group_id" {
  type = string
}

variable "instance_class" {
  type = string
}

variable "allocated_storage" {
  type = number
}

variable "max_allocated_storage" {
  type = number
}

variable "multi_az" {
  type = bool
}

variable "backup_retention_days" {
  type = number
}

variable "deletion_protection" {
  type = bool
}

variable "require_secure_transport" {
  type = bool
}

variable "performance_insights" {
  type = bool
}

variable "engine_version" {
  description = "RDS MySQL engine version. Must match what Compose and testcontainers run (OB-004, OB-014) or behaviour diverges between the environment tests pass in and the one that serves customers."
  type        = string
}

variable "parameter_group_family" {
  description = "Explicit rather than derived from engine_version, so a version bump forces a conscious decision about the parameter family."
  type        = string
}

variable "log_retention_days" {
  type = number
}

variable "bootstrap_image" {
  type = string
}

variable "bootstrap_sql_dir" {
  description = "Directory holding 01-users-rds.sql and the shared 02-grants.sql. Passed in rather than resolved inside the module so the shared SQL has one home outside the Terraform tree."
  type        = string
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture for the bootstrap task. Must match the architecture the OpenBooks image is built for (OB-027) so one setting cannot drift from the other."
  type        = string
}
