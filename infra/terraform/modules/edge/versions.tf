terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
      # `aws.us_east_1` is required, not optional: CloudFront accepts ACM certificates
      # from us-east-1 only, wherever the rest of the stack lives.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
