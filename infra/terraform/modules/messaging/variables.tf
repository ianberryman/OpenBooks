variable "name_prefix" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "visibility_timeout_seconds" {
  type = number
}

variable "max_receive_count" {
  type = number
}

variable "attachments_noncurrent_version_days" {
  type = number
}

variable "route53_zone_id" {
  type = string
}

variable "root_domain" {
  type = string
}

variable "mail_from_subdomain" {
  type = string
}

variable "dmarc_policy" {
  type = string
}
