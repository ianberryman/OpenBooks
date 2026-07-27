variable "environment" {
  description = "Environment name. Prefixes every resource name and keys the remote state."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must be lowercase alphanumeric with hyphens, 2-21 characters."
  }
}

variable "region" {
  description = "Primary AWS region."
  type        = string
  default     = "us-east-1"
}

# ---------------------------------------------------------------------------
# DNS and certificates
# ---------------------------------------------------------------------------

variable "root_domain" {
  description = "Apex domain of an EXISTING Route53 public hosted zone. The zone itself is not managed here — see the README's 'not managed here' section."
  type        = string
}

variable "app_subdomain" {
  description = "Subdomain serving the built packages/web bundle from CloudFront. Empty string means the apex."
  type        = string
  default     = "app"
}

variable "api_subdomain" {
  description = "Subdomain serving the /v1 API from the ALB."
  type        = string
  default     = "api"
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "IPv4 CIDR for the VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones. Two is the floor: RDS multi-AZ and the ALB both require it."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "single_nat_gateway" {
  description = "Share one NAT gateway across all private subnets. Cheaper, and a single AZ failure takes egress with it. Cost lever for non-production only."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB. Must exceed db_allocated_storage."
  type        = number
  default     = 500
}

variable "db_multi_az" {
  description = "RDS multi-AZ standby. Defaults on; hosted-prod must not turn it off."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. An accounting ledger should not go below 14."
  type        = number
  default     = 30
}

variable "db_deletion_protection" {
  description = "Block `terraform destroy` and console deletion of the database."
  type        = bool
  default     = true
}

variable "db_require_secure_transport" {
  description = "Force TLS on every MySQL connection. Pairs with REQUIRE SSL on both application users."
  type        = bool
  default     = true
}

variable "db_performance_insights" {
  description = "Enable RDS Performance Insights (7-day retention is in the free tier)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------------

variable "image_tag" {
  description = "ECR tag for the one OpenBooks image, used by all four task definitions (spec §2.5). Overridden per deploy by CI (OB-027)."
  type        = string
  default     = "develop"
}

variable "manage_ecr_repository" {
  description = "Create the ECR repository in this environment. Exactly one environment per account should own it so an image is promoted by digest rather than rebuilt; hosted-prod owns it and staging reads it."
  type        = bool
  default     = true
}

variable "ecr_repository_name" {
  description = "Deliberately not environment-prefixed — see manage_ecr_repository."
  type        = string
  default     = "openbooks/server"
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture for every task family. ARM64 is roughly 20% cheaper per vCPU-hour; CI (OB-027) must build the image for the same architecture or tasks fail with an exec format error."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

variable "app_port" {
  description = "Port the api role listens on. Must match the PORT env var, which is set from this value."
  type        = number
  default     = 3000
}

variable "api_health_check_path" {
  description = "ALB health check path on the api role. GUESS — OB-022 owns the actual endpoint; confirm before the first apply."
  type        = string
  default     = "/v1/health"
}

variable "api_cpu" {
  description = "Fargate CPU units for the api task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) for the api task."
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "Baseline api task count and the autoscaling floor."
  type        = number
  default     = 2
}

variable "api_max_count" {
  description = "Autoscaling ceiling for the api service."
  type        = number
  default     = 6
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Fargate memory (MiB) for the worker task."
  type        = number
  default     = 512
}

variable "worker_desired_count" {
  description = "Worker task count. One is correct for M1 — the worker role starts cleanly with no registered jobs (ROADMAP)."
  type        = number
  default     = 1
}

variable "worker_use_spot" {
  description = "Run the worker on FARGATE_SPOT. Acceptable for idempotent queue consumers, not for the api service."
  type        = bool
  default     = false
}

variable "migrate_cpu" {
  description = "Fargate CPU units for the one-shot migrate task."
  type        = number
  default     = 512
}

variable "migrate_memory" {
  description = "Fargate memory (MiB) for the one-shot migrate task."
  type        = number
  default     = 1024
}

variable "enable_execute_command" {
  description = "Allow `aws ecs execute-command` into running tasks. Adds ssmmessages to the task role, so it stays off in production."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch log retention for all task families."
  type        = number
  default     = 90
}

variable "ecr_untagged_expiry_days" {
  description = "Days before an untagged ECR image is expired."
  type        = number
  default     = 14
}

variable "ecr_tagged_image_count" {
  description = "How many tagged images to retain. Deep enough to roll back several deploys."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------
# Edge
# ---------------------------------------------------------------------------

variable "alb_access_logs_enabled" {
  description = "Ship ALB access logs to a dedicated S3 bucket."
  type        = bool
  default     = true
}

variable "alb_deletion_protection" {
  description = "Block deletion of the load balancer."
  type        = bool
  default     = true
}

variable "cloudfront_price_class" {
  description = "CloudFront edge footprint. PriceClass_100 is North America and Europe only."
  type        = string
  default     = "PriceClass_100"
}

# ---------------------------------------------------------------------------
# Messaging, storage, email
# ---------------------------------------------------------------------------

variable "queue_visibility_timeout_seconds" {
  description = "SQS visibility timeout. Must exceed the worst-case job runtime or work is redelivered while still running."
  type        = number
  default     = 300
}

variable "queue_max_receive_count" {
  description = "Deliveries before a message is moved to the DLQ."
  type        = number
  default     = 5
}

variable "attachments_noncurrent_version_days" {
  description = "Days a superseded attachment version is kept before expiry. Versioning is a corruption backstop, not an archive."
  type        = number
  default     = 90
}

variable "ses_mail_from_subdomain" {
  description = "Custom MAIL FROM subdomain, which is what makes SPF align rather than merely pass."
  type        = string
  default     = "mail"
}

variable "ses_from_address" {
  description = "Envelope From used by the application. Must sit inside root_domain or SES will refuse to send."
  type        = string
  default     = ""
}

variable "ses_dmarc_policy" {
  description = "DMARC p= value published at _dmarc.<root_domain>. Start at none and tighten once DKIM and SPF are observed passing."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.ses_dmarc_policy)
    error_message = "ses_dmarc_policy must be none, quarantine or reject."
  }
}

# ---------------------------------------------------------------------------
# Provider selection (spec §2.5)
# ---------------------------------------------------------------------------

# Spec §2.5: one image everywhere, and everything that differs between self-host and
# hosted sits behind a provider interface selected by an environment variable. These
# exist as variables rather than hardcoded strings purely so the hosted-vs-self-host
# seam is visible in one place — the hosted stack has no reason to set anything else.
variable "queue_provider" {
  description = "QUEUE_PROVIDER for the api and worker tasks. Self-host Compose sets in-process."
  type        = string
  default     = "sqs"
}

variable "storage_provider" {
  description = "STORAGE_PROVIDER for the api and worker tasks. Self-host Compose sets local."
  type        = string
  default     = "s3"
}

variable "email_provider" {
  description = "EMAIL_PROVIDER for the api and worker tasks. Self-host Compose sets log."
  type        = string
  default     = "ses"
}

variable "log_level" {
  description = "LOG_LEVEL for the pino logger (OB-009)."
  type        = string
  default     = "info"
}

# ---------------------------------------------------------------------------
# Tagging
# ---------------------------------------------------------------------------

variable "extra_tags" {
  description = "Additional tags merged into default_tags, for cost allocation."
  type        = map(string)
  default     = {}
}

variable "db_bootstrap_image" {
  description = "Image for the one-shot db-bootstrap task. NOT the OpenBooks image — see the README on why, and pin a digest before the first real run."
  type        = string
  default     = "public.ecr.aws/docker/library/mysql:8.4"
}
