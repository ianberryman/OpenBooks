# ===========================================================================
# Root composition
# ===========================================================================
#
# One root, one state file per environment, keyed by the backend.hcl passed at init. The
# bootstrap sequence the README describes (state -> network -> data -> DB users -> compute)
# is expressed with -target for the first apply only; steady state is a single apply of
# everything.

module "network" {
  source = "./modules/network"

  name_prefix        = local.name_prefix
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  app_port           = var.app_port
  kms_key_arn        = aws_kms_key.main.arn

  flow_log_retention_days = var.log_retention_days
}

module "data" {
  source = "./modules/data"

  name_prefix = local.name_prefix
  environment = var.environment
  kms_key_arn = aws_kms_key.main.arn

  private_subnet_ids   = module.network.private_subnet_ids
  db_security_group_id = module.network.db_security_group_id

  instance_class           = var.db_instance_class
  allocated_storage        = var.db_allocated_storage
  max_allocated_storage    = var.db_max_allocated_storage
  multi_az                 = var.db_multi_az
  backup_retention_days    = var.db_backup_retention_days
  deletion_protection      = var.db_deletion_protection
  require_secure_transport = var.db_require_secure_transport
  performance_insights     = var.db_performance_insights

  # Pinned, and pinned to match Compose and testcontainers. See the module's variable
  # description — a difference here means the invariant suite proves something about a
  # database that is not the one serving customers.
  engine_version         = "8.0.42"
  parameter_group_family = "mysql8.0"

  log_retention_days = var.log_retention_days
  cpu_architecture   = var.cpu_architecture

  bootstrap_image = var.db_bootstrap_image
  # The shared grant split lives outside the Terraform tree so Compose and testcontainers
  # can consume the same file. path.root resolves to this directory regardless of which
  # module is reading it.
  bootstrap_sql_dir = "${path.root}/../db-bootstrap"
}

module "messaging" {
  source = "./modules/messaging"

  name_prefix = local.name_prefix
  kms_key_arn = aws_kms_key.main.arn

  visibility_timeout_seconds          = var.queue_visibility_timeout_seconds
  max_receive_count                   = var.queue_max_receive_count
  attachments_noncurrent_version_days = var.attachments_noncurrent_version_days

  route53_zone_id     = data.aws_route53_zone.primary.zone_id
  root_domain         = var.root_domain
  mail_from_subdomain = var.ses_mail_from_subdomain
  dmarc_policy        = var.ses_dmarc_policy
}

module "edge" {
  source = "./modules/edge"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name_prefix = local.name_prefix
  kms_key_arn = aws_kms_key.main.arn

  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id

  route53_zone_id = data.aws_route53_zone.primary.zone_id
  api_fqdn        = local.api_fqdn
  app_fqdn        = local.app_fqdn

  app_port          = var.app_port
  health_check_path = var.api_health_check_path

  access_logs_enabled    = var.alb_access_logs_enabled
  deletion_protection    = var.alb_deletion_protection
  cloudfront_price_class = var.cloudfront_price_class
  log_retention_days     = var.log_retention_days
}

module "compute" {
  source = "./modules/compute"

  name_prefix = local.name_prefix
  environment = var.environment
  kms_key_arn = aws_kms_key.main.arn

  private_subnet_ids    = module.network.private_subnet_ids
  app_security_group_id = module.network.app_security_group_id
  target_group_arn      = module.edge.target_group_arn

  image_tag                = var.image_tag
  manage_ecr_repository    = var.manage_ecr_repository
  ecr_repository_name      = var.ecr_repository_name
  cpu_architecture         = var.cpu_architecture
  ecr_untagged_expiry_days = var.ecr_untagged_expiry_days
  ecr_tagged_image_count   = var.ecr_tagged_image_count

  app_port             = var.app_port
  api_cpu              = var.api_cpu
  api_memory           = var.api_memory
  api_desired_count    = var.api_desired_count
  api_max_count        = var.api_max_count
  worker_cpu           = var.worker_cpu
  worker_memory        = var.worker_memory
  worker_desired_count = var.worker_desired_count
  worker_use_spot      = var.worker_use_spot
  migrate_cpu          = var.migrate_cpu
  migrate_memory       = var.migrate_memory

  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days

  db_host                     = module.data.db_address
  db_port                     = module.data.db_port
  db_name                     = module.data.db_name
  db_app_username             = module.data.app_username
  db_migrator_username        = module.data.migrator_username
  db_app_secret_arn           = module.data.app_secret_arn
  db_migrator_secret_arn      = module.data.migrator_secret_arn
  db_require_secure_transport = var.db_require_secure_transport

  queue_provider   = var.queue_provider
  storage_provider = var.storage_provider
  email_provider   = var.email_provider

  queue_url                  = module.messaging.queue_url
  queue_arn                  = module.messaging.queue_arn
  dlq_arn                    = module.messaging.dlq_arn
  attachments_bucket         = module.messaging.attachments_bucket
  attachments_bucket_arn     = module.messaging.attachments_bucket_arn
  ses_identity_arn           = module.messaging.ses_identity_arn
  ses_configuration_set_arn  = module.messaging.ses_configuration_set_arn
  ses_configuration_set_name = module.messaging.ses_configuration_set_name
  ses_from_address           = local.ses_from_address

  session_secret_arn = aws_secretsmanager_secret.session.arn

  api_base_url = local.api_base_url
  app_base_url = local.app_base_url
  log_level    = var.log_level

  # `target_group_arn` orders this module against the target group but not against the
  # HTTPS listener. An ECS service that registers with a target group whose listener does
  # not exist yet fails as an opaque service error, so the ordering is made explicit here.
  depends_on = [module.edge]
}
