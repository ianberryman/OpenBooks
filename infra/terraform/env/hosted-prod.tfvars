# hosted-prod — the environment spec §3's topology describes.
#
# Every value that trades durability for cost is set the durable way here. Anything you are
# tempted to relax in this file, relax in staging.tfvars instead.
#
# PLACEHOLDER: root_domain. There is no OpenBooks hosted domain yet (D-05 — nothing has been
# applied), so this is an example.com stand-in and the first apply will fail on the
# aws_route53_zone lookup until it names a real, already-delegated hosted zone.

environment = "hosted-prod"
region      = "us-east-1"

root_domain   = "example.com"
app_subdomain = "app"
api_subdomain = "api"

# --- network ---------------------------------------------------------------

vpc_cidr = "10.40.0.0/16"
az_count = 2
# One NAT gateway per AZ. Sharing one is ~$33/month cheaper and makes a single AZ's failure
# take down egress for every private subnet, including the database's outbound path for
# Performance Insights and log export.
single_nat_gateway = false

# --- data ------------------------------------------------------------------

db_instance_class        = "db.t4g.small"
db_allocated_storage     = 50
db_max_allocated_storage = 500
# Non-negotiable in prod. A single-AZ ledger has a maintenance window that is an outage.
db_multi_az                 = true
db_backup_retention_days    = 35
db_deletion_protection      = true
db_require_secure_transport = true
db_performance_insights     = true

# --- compute ---------------------------------------------------------------

# Overridden per deploy by CI (OB-027). The value here is what a `terraform apply` with no
# override would register, so it names a branch tag rather than a SHA that would go stale.
image_tag        = "develop"
cpu_architecture = "ARM64"

app_port = 3000
# GUESS — OB-022 owns the real health endpoint.
api_health_check_path = "/v1/health"

api_cpu           = 512
api_memory        = 1024
api_desired_count = 2
api_max_count     = 6

worker_cpu           = 256
worker_memory        = 512
worker_desired_count = 1
# On-demand, not Spot. Nothing enqueues anything in M1 so the saving is theoretical, and a
# Spot interruption during the first real job is not the moment to discover a handler is not
# idempotent.
worker_use_spot = false

migrate_cpu    = 512
migrate_memory = 1024

# Off in production. Turning it on grants ssmmessages to the task roles, which is an
# interactive shell inside a container holding live database credentials.
enable_execute_command = false

log_retention_days       = 365
ecr_untagged_expiry_days = 14
ecr_tagged_image_count   = 50

# --- edge ------------------------------------------------------------------

alb_access_logs_enabled = true
alb_deletion_protection = true
cloudfront_price_class  = "PriceClass_100"

# --- messaging, storage, email --------------------------------------------

queue_visibility_timeout_seconds = 300
queue_max_receive_count          = 5

attachments_noncurrent_version_days = 365

ses_mail_from_subdomain = "mail"
ses_from_address        = ""
# Start at none and read the aggregate reports before tightening. Publishing p=reject before
# DKIM and SPF are observed passing silently discards real mail.
ses_dmarc_policy = "none"

# --- providers (spec §2.5) -------------------------------------------------
#
# The entire hosted-vs-self-host difference, in four lines. The image is identical.

queue_provider   = "sqs"
storage_provider = "s3"
email_provider   = "ses"
log_level        = "info"

extra_tags = {
  CostCentre = "hosted"
  Tier       = "production"
}
