provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

# CloudFront only accepts ACM certificates issued in us-east-1, regardless of where
# the rest of the stack lives. The ALB certificate is issued in var.region by the
# default provider; this alias exists solely for the CloudFront certificate.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}
