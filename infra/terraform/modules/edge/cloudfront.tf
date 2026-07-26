# ===========================================================================
# Static web bundle — S3 + CloudFront with OAC
# ===========================================================================
#
# ONE ORIGIN, AND THAT IS THE POINT. The built packages/web bundle (OB-024) is static
# assets; it calls the API at var.api_fqdn over the same public /v1 surface any integrator
# uses. Spec §12 has no privileged internal path, so there is nothing for CloudFront to
# route to a second origin, no /internal behaviour to protect, and no signed-header trick
# needed to distinguish "the first-party UI" from "an API client". A CDN distribution with a
# single S3 origin and no cache-behaviour exceptions is the whole design, and it is that
# simple because the API surface is.

resource "aws_s3_bucket" "web" {
  bucket = "${var.name_prefix}-web"
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  # Public access is blocked even though this bucket serves a public website. The website is
  # served by CloudFront through the OAC below; the bucket itself is never addressed
  # directly, which is what keeps the bucket URL from becoming a second, uncached,
  # unversioned way to reach the app.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id

  # A bad `aws s3 sync` is the most likely way this bucket breaks, and versioning is what
  # makes that recoverable without a rebuild.
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  # SSE-S3, not the environment KMS key: these objects are a public website, so encryption
  # at rest protects nothing here, and SSE-KMS would add a KMS Decrypt charge to every
  # CloudFront origin fetch plus a key grant for the CloudFront service principal.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# OAC, not OAI. OAI is legacy, does not support SSE-KMS origins, and signs with a
# CloudFront-managed identity rather than SigV4. OAC is the supported mechanism.
resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.name_prefix}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web.json

  depends_on = [aws_s3_bucket_public_access_block.web]
}

data "aws_iam_policy_document" "web" {
  # Scoped to this one distribution by ARN. Without the SourceArn condition, any CloudFront
  # distribution in any AWS account could use this bucket as an origin.
  statement {
    sid       = "AllowThisDistributionOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.web.arn,
      "${aws_s3_bucket.web.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# Managed policies looked up by name rather than by their well-known UUIDs, which are
# stable but unreadable in a diff.
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_response_headers_policy" "web" {
  name = "${var.name_prefix}-web-security"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false # preload is a one-way door across the whole domain
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  # No Content-Security-Policy header here on purpose. A CSP tight enough to be worth having
  # has to enumerate what the built bundle actually loads, which is OB-024's business and
  # will change with every dependency the frontend adds. A wrong CSP set from infrastructure
  # either breaks the app or is permissive enough to be decorative. Owned by the web package.
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name_prefix} web"
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class
  aliases             = [var.app_fqdn]

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "s3-web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-web"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # A static SPA bundle. Nothing here mutates anything, and allowing POST to an S3 origin
    # would only produce confusing errors.
    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  # React Router owns the URL space, so /orgs/123/journals is a valid app route and not a
  # valid S3 key. S3 answers 403 (not 404, because ListBucket is not granted), and both must
  # become the shell with a 200 or deep links break on refresh.
  #
  # This is safe here precisely because there is no API behind this distribution: rewriting
  # every miss to index.html cannot mask a real API 404. If an API origin were ever added,
  # these two rules would have to be scoped to the static behaviour only.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate_validation.app.certificate_arn
    ssl_support_method  = "sni-only"
    # TLS 1.2 floor. sni-only plus this policy excludes clients that predate SNI, which no
    # browser in use does.
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Deliberately not configured: standard access logging. It needs a log bucket with ACLs
  # enabled (CloudFront standard logging still writes with the log-delivery ACL, which
  # conflicts with BucketOwnerEnforced everywhere else here) or a v2 delivery configuration.
  # The distribution serves static assets whose access pattern is already visible in
  # CloudFront metrics; the API's access log, which is the one that matters for an audit
  # trail, is on the ALB.
}

resource "aws_route53_record" "app" {
  zone_id = var.route53_zone_id
  name    = var.app_fqdn
  type    = "A"

  alias {
    name    = aws_cloudfront_distribution.web.domain_name
    zone_id = aws_cloudfront_distribution.web.hosted_zone_id
    # CloudFront has no per-record health to evaluate.
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "app_ipv6" {
  zone_id = var.route53_zone_id
  name    = var.app_fqdn
  type    = "AAAA"

  # Unlike the ALB, CloudFront is dualstack whenever is_ipv6_enabled is set, so this record
  # resolves to something.
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}
