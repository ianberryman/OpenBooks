variable "name_prefix" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "az_count" {
  type = number
}

variable "single_nat_gateway" {
  type = bool
}

variable "app_port" {
  description = "Port the api container listens on. Opened from the ALB security group only."
  type        = number
}

variable "flow_log_retention_days" {
  type    = number
  default = 30
}

variable "kms_key_arn" {
  type = string
}
