variable "name_prefix" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "route53_zone_id" {
  type = string
}

variable "api_fqdn" {
  type = string
}

variable "app_fqdn" {
  type = string
}

variable "app_port" {
  type = number
}

variable "health_check_path" {
  type = string
}

variable "access_logs_enabled" {
  type = bool
}

variable "deletion_protection" {
  type = bool
}

variable "cloudfront_price_class" {
  type = string
}

variable "log_retention_days" {
  type = number
}
