variable "bucket_name" {
  description = "Globally unique S3 bucket name for Terraform state. No default: bucket names are global, so any default would either collide or silently point a reviewer at someone else's bucket."
  type        = string
}

variable "region" {
  description = "Region for the state bucket and lock table. Not required to match any environment's region."
  type        = string
  default     = "us-east-1"
}
