output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_arn" {
  value = aws_lb.main.arn
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "https_listener_arn" {
  value = aws_lb_listener.https.arn
}

output "web_bucket" {
  description = "Sync the built packages/web bundle here, then invalidate the distribution."
  value       = aws_s3_bucket.web.id
}

output "web_bucket_arn" {
  value = aws_s3_bucket.web.arn
}

output "cloudfront_distribution_id" {
  description = "Needed for `aws cloudfront create-invalidation` after a web deploy."
  value       = aws_cloudfront_distribution.web.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "api_certificate_arn" {
  value = aws_acm_certificate.api.arn
}

output "app_certificate_arn" {
  value = aws_acm_certificate.app.arn
}

output "alb_access_logs_bucket" {
  value = var.access_logs_enabled ? aws_s3_bucket.alb_logs[0].id : null
}
