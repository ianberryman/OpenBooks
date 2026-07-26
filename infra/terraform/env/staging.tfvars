# staging — same modules, same image, cheaper and less durable.
#
# The point of this file is that it changes only cost and blast-radius settings. It does not
# change the topology, it does not skip a component, and it does not set a different provider
# for the queue, storage or email. If staging exercised a different code path from prod it
# would not be testing prod.
#
# PLACEHOLDER: root_domain, as in hosted-prod.
#
# NOTE ON THE VPC CIDR: 10.41/16 rather than 10.40/16 so the two environments could be peered
# for a data-migration exercise without renumbering. Nothing peers them today.

environment = "staging"
region      = "us-east-1"

root_domain   = "example.com"
app_subdomain = "app-staging"
api_subdomain = "api-staging"

# --- network ---------------------------------------------------------------

vpc_cidr = "10.41.0.0/16"
az_count = 2
# The single largest saving available here, about $33/month. Acceptable because an AZ failure
# in staging is an inconvenience.
single_nat_gateway = true

# --- data ------------------------------------------------------------------

db_instance_class        = "db.t4g.micro"
db_allocated_storage     = 20
db_max_allocated_storage = 100
db_multi_az              = false
# Enough to recover from yesterday's mistake, not enough to be an archive.
db_backup_retention_days = 7
# Off, so a staging environment can actually be torn down. prevent_destroy on the instance
# still stands in the way deliberately — removing it is a code change, which is the point.
db_deletion_protection = false
# Kept ON even though it is stricter, because REQUIRE SSL on the users is the thing most
# likely to break a first connection and staging is where that should surface.
db_require_secure_transport = true
db_performance_insights     = false

# --- compute ---------------------------------------------------------------

image_tag        = "develop"
cpu_architecture = "ARM64"

app_port              = 3000
api_health_check_path = "/v1/health"

# One task, no headroom. Enough to prove the deploy works.
api_cpu           = 256
api_memory        = 512
api_desired_count = 1
api_max_count     = 2

worker_cpu           = 256
worker_memory        = 512
worker_desired_count = 1
worker_use_spot      = true

migrate_cpu    = 512
migrate_memory = 1024

# On here, off in prod. This is where you debug a task that will not start.
enable_execute_command = true

log_retention_days       = 14
ecr_untagged_expiry_days = 7
ecr_tagged_image_count   = 10

# The ECR repository is not environment-prefixed and exactly one environment in an account
# creates it; hosted-prod does. Staging reads it, so an image can be promoted by digest
# rather than rebuilt — which is what makes "the artifact staging tested" and "the artifact
# prod runs" the same bytes.
#
# CONSEQUENCE, worth knowing before the first apply: this makes staging depend on
# hosted-prod having been applied first in the same account. If the two ever live in separate
# accounts, this becomes a cross-account ECR repository policy instead.
manage_ecr_repository = false

# --- edge ------------------------------------------------------------------

# Off: staging traffic is synthetic and the log volume is not worth the storage.
alb_access_logs_enabled = false
alb_deletion_protection = false
cloudfront_price_class  = "PriceClass_100"

# --- messaging, storage, email --------------------------------------------

queue_visibility_timeout_seconds = 300
queue_max_receive_count          = 3

attachments_noncurrent_version_days = 30

ses_mail_from_subdomain = "mail-staging"
ses_from_address        = ""
ses_dmarc_policy        = "none"

# --- providers (spec §2.5) -------------------------------------------------
#
# Identical to hosted-prod on purpose. Setting in-process / local / smtp here would make
# staging a self-host test rather than a hosted one, and the hosted adapters would then only
# ever run for the first time in production.

queue_provider   = "sqs"
storage_provider = "s3"
email_provider   = "ses"
log_level        = "debug"

extra_tags = {
  CostCentre = "hosted"
  Tier       = "staging"
}
