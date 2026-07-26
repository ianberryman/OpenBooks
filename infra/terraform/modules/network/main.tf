data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /20 public and /20 private per AZ out of a /16: room to add more subnet tiers later
  # (a dedicated database tier, a VPC-endpoint tier) without renumbering what exists,
  # which would mean recreating every subnet.
  public_subnets  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnets = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  nat_count = var.single_nat_gateway ? 1 : var.az_count
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name_prefix }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = var.name_prefix }
}

# ---------------------------------------------------------------------------
# Subnets
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_subnets[count.index]
  availability_zone = local.azs[count.index]

  # Fargate tasks run in the private subnets and take their egress through NAT, so
  # nothing in the public subnets ever needs an auto-assigned public IP. Only the ALB
  # lives here and it brings its own addresses.
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    Name = "${var.name_prefix}-private-${local.azs[count.index]}"
    Tier = "private"
  }
}

# ---------------------------------------------------------------------------
# Egress
# ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"

  tags = { Name = "${var.name_prefix}-nat-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = { Name = "${var.name_prefix}-nat-${count.index}" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.name_prefix}-public" }
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One route table per private subnet even when sharing a single NAT gateway, so
# switching single_nat_gateway off later adds routes instead of restructuring tables.
resource "aws_route_table" "private" {
  count = var.az_count

  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.name_prefix}-private-${local.azs[count.index]}" }
}

resource "aws_route" "private_default" {
  count = var.az_count

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---------------------------------------------------------------------------
# VPC endpoints
# ---------------------------------------------------------------------------

# The S3 gateway endpoint costs nothing and takes ECR layer pulls and attachment
# traffic off the NAT gateway, where they would otherwise be billed per GiB. The
# interface endpoints that would do the same for ECR, Secrets Manager, SQS and Logs
# cost ~$7/month each per AZ, which is more than the NAT data charge at M1 volumes —
# see the README's cost notes for when that inverts.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = { Name = "${var.name_prefix}-s3" }
}

data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# Flow logs
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/openbooks/${trimprefix(var.name_prefix, "openbooks-")}/vpc-flow"
  retention_in_days = var.flow_log_retention_days
  kms_key_id        = var.kms_key_arn
}

resource "aws_iam_role" "flow" {
  name               = "${var.name_prefix}-vpc-flow"
  assume_role_policy = data.aws_iam_policy_document.flow_assume.json
}

data "aws_iam_policy_document" "flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "flow" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow.json
}

data "aws_iam_policy_document" "flow" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]

    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow.arn
  iam_role_arn         = aws_iam_role.flow.arn

  # REJECT only. ACCEPT traffic in a two-tier VPC is almost entirely the ALB talking to
  # Fargate and Fargate talking to RDS, which is high volume and tells you nothing;
  # rejects are the ones that indicate a misconfiguration or a probe.
  tags = { Name = "${var.name_prefix}-reject" }
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------
#
# Three groups, each rule referencing another group rather than a CIDR, so the chain is
# ALB -> Fargate -> RDS and nothing addresses the database or the tasks directly. Rules
# are separate aws_vpc_security_group_*_rule resources rather than inline blocks: inline
# rules and rule resources on the same group fight each other, and separate resources
# make an unintended opening visible as an added resource in the plan.

resource "aws_security_group" "alb" {
  # name_prefix, not name: create_before_destroy is what lets a rule change replace this group
  # while other groups still reference it, and a fixed name turns that into a duplicate-name
  # error. The readable identity is the Name tag.
  name_prefix = "${var.name_prefix}-alb-"
  description = "Public entry point. Ingress from the internet on 80/443 only."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name_prefix}-alb" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS at the listener"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the api tasks on the app port only"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "app" {
  # name_prefix, not name: create_before_destroy is what lets a rule change replace this group
  # while other groups still reference it, and a fixed name turns that into a duplicate-name
  # error. The readable identity is the Name tag.
  name_prefix = "${var.name_prefix}-app-"
  description = "Fargate tasks: api, worker, migrate, db-bootstrap."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name_prefix}-app" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "From the load balancer on the app port"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

# Unrestricted egress on the task group, and the reason is worth stating rather than
# leaving as an apparent oversight: these tasks must reach ECR, Secrets Manager, SQS,
# S3, SES and CloudWatch, all public AWS endpoints whose address ranges are not stable
# enough to enumerate here. Narrowing this properly means interface VPC endpoints for
# each service plus an endpoint-only egress rule, which is the right answer at scale and
# is priced in the README's cost notes. Ingress, which is what an attacker needs, is
# closed to everything but the ALB.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "To AWS service endpoints via NAT"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "db" {
  # name_prefix, not name: create_before_destroy is what lets a rule change replace this group
  # while other groups still reference it, and a fixed name turns that into a duplicate-name
  # error. The readable identity is the Name tag.
  name_prefix = "${var.name_prefix}-db-"
  description = "RDS MySQL. Ingress from the task security group on 3306 and nothing else."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.name_prefix}-db" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  description                  = "MySQL from Fargate tasks"
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
  referenced_security_group_id = aws_security_group.app.id
}

# No egress rule on the database group at all. Terraform's absence of an egress rule
# means the group denies all outbound, which is what a database should do — it has no
# reason to originate a connection.
