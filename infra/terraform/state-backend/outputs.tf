output "bucket" {
  description = "Use as `bucket` in env/<environment>.backend.hcl."
  value       = aws_s3_bucket.state.id
}

output "region" {
  value = var.region
}

output "dynamodb_lock_table" {
  description = "Fallback locking for Terraform < 1.10. The committed backend.hcl files use S3-native locking instead."
  value       = aws_dynamodb_table.locks.name
}

output "kms_key_arn" {
  value = aws_kms_key.state.arn
}
