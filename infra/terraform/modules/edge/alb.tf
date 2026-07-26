resource "aws_lb" "main" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  enable_deletion_protection = var.deletion_protection
  enable_http2               = true
  idle_timeout               = 60

  # Header names that are not valid HTTP are the raw material for request-smuggling and
  # header-injection attacks against whatever sits behind the balancer. Rejecting them at the
  # edge means Fastify never has to have an opinion about them.
  drop_invalid_header_fields = true

  dynamic "access_logs" {
    for_each = var.access_logs_enabled ? [1] : []

    content {
      bucket  = aws_s3_bucket.alb_logs[0].id
      prefix  = "alb"
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name_prefix}-api"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "ip" # awsvpc networking gives each task its own ENI address
  vpc_id      = var.vpc_id

  # Shorter than the api container's stopTimeout (120s), so the balancer stops sending
  # connections and lets existing ones finish before ECS asks the process to exit.
  deregistration_delay = 30

  health_check {
    enabled = true
    # GUESS: the api role's health endpoint. OB-022 owns the actual route; if it differs,
    # every deploy fails health checks and rolls back, which is a loud failure but a
    # confusing one. Confirm before the first apply.
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # No create_before_destroy here, unlike the certificates and security groups. ELB target
  # group names are capped at 32 characters, so coexisting replacements would need a
  # `name_prefix` of six characters or fewer — short enough that two environments in one
  # account become indistinguishable in the console. A target group replacement is rare
  # (it needs a protocol, port or vpc_id change) and is worth sequencing by hand when it
  # happens.
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"

  # TLS 1.2 floor with TLS 1.3 available. Anything older exists only for clients that
  # should not be handling accounting data.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = aws_acm_certificate_validation.api.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  # A 301 rather than a 403: an integrator who hardcodes http:// gets a working redirect
  # once, and their client follows it. Nothing is served over port 80.
  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

# ---------------------------------------------------------------------------
# Access logs
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket        = "${var.name_prefix}-alb-logs"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.alb_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.alb_logs[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3, not the environment KMS key. ALB access log delivery does not support SSE-KMS with
# a customer-managed key, and configuring one silently drops the logs rather than failing.
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.alb_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.alb_logs[0].id

  rule {
    id     = "expire"
    status = "Enabled"

    filter {}

    expiration {
      days = var.log_retention_days
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.alb_logs[0].id
  policy = data.aws_iam_policy_document.alb_logs[0].json

  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}

data "aws_iam_policy_document" "alb_logs" {
  count = var.access_logs_enabled ? 1 : 0

  # The current service principal, not the per-region ELB account ID that older examples
  # use. Both work; the account-ID form requires looking up a hardcoded table per region.
  statement {
    sid     = "AlbLogDelivery"
    actions = ["s3:PutObject"]

    resources = ["${aws_s3_bucket.alb_logs[0].arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.alb_logs[0].arn,
      "${aws_s3_bucket.alb_logs[0].arn}/*",
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

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

resource "aws_route53_record" "api" {
  zone_id = var.route53_zone_id
  name    = var.api_fqdn
  type    = "A"

  # An alias, not a CNAME to the ALB's DNS name: aliases cost nothing to resolve, work at a
  # zone apex, and follow the balancer if its addresses change.
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# No AAAA record for the API. The ALB is IPv4-only (ip_address_type defaults to ipv4) because
# a dualstack balancer needs an IPv6 CIDR on the VPC and on every subnet, which the network
# module does not allocate. Publishing an AAAA alias for an IPv4-only balancer resolves to
# nothing and breaks IPv6-preferring clients. Adding IPv6 properly is a network-module change
# first; the record follows.
