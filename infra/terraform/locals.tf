data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  name_prefix = "openbooks-${var.environment}"

  tags = merge(
    {
      Project     = "OpenBooks"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = "OpenBooks/infra/terraform"
    },
    var.extra_tags,
  )

  account_id = data.aws_caller_identity.current.account_id

  app_fqdn = var.app_subdomain == "" ? var.root_domain : "${var.app_subdomain}.${var.root_domain}"
  api_fqdn = "${var.api_subdomain}.${var.root_domain}"

  # The web bundle calls the API over the same public /v1 surface any integrator uses
  # (spec §12: no privileged internal paths), so CloudFront needs exactly one origin —
  # the static bucket. There is no API behaviour behind the CDN, no second origin, and
  # no path-based routing to get wrong.
  api_base_url = "https://${local.api_fqdn}"
  app_base_url = "https://${local.app_fqdn}"

  # The From address sits in the root domain; the MAIL FROM subdomain is the *envelope*
  # domain and exists only so SPF aligns. Conflating the two is a common way to end up with
  # a From address recipients do not recognise.
  ses_from_address = var.ses_from_address != "" ? var.ses_from_address : "no-reply@${var.root_domain}"
}

data "aws_route53_zone" "primary" {
  name         = "${var.root_domain}."
  private_zone = false
}
