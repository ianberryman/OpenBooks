data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

# Two certificates for two different FQDNs in two different regions. Not duplication: the
# ALB can only use a certificate in its own region and CloudFront can only use one in
# us-east-1, so a single certificate cannot serve both.
#
# DNS validation, not email: email validation needs a human to click a link in a mailbox
# that may not exist, and cannot renew unattended. The validation records below live in the
# same zone Terraform already manages records in, so renewal is automatic forever.

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_fqdn
  validation_method = "DNS"

  lifecycle {
    # ACM will not let a certificate in use be deleted, so the replacement must exist and be
    # attached before the old one goes.
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # ACM reuses the same validation CNAME across certificates for the same name, so a
  # renewal or a re-apply can collide with an identical existing record.
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in aws_route53_record.api_validation : r.fqdn]
}

resource "aws_acm_certificate" "app" {
  provider = aws.us_east_1

  domain_name       = var.app_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "app_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.app_validation : r.fqdn]
}
