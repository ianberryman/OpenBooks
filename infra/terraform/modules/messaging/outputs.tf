output "queue_arn" {
  value = aws_sqs_queue.jobs.arn
}

output "queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "queue_name" {
  value = aws_sqs_queue.jobs.name
}

output "dlq_arn" {
  value = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.id
}

output "attachments_bucket_arn" {
  value = aws_s3_bucket.attachments.arn
}

output "ses_identity_arn" {
  value = aws_sesv2_email_identity.domain.arn
}

output "ses_configuration_set_name" {
  value = aws_sesv2_configuration_set.main.configuration_set_name
}

output "ses_configuration_set_arn" {
  value = aws_sesv2_configuration_set.main.arn
}

output "ses_mail_from_domain" {
  value = aws_sesv2_email_identity_mail_from_attributes.domain.mail_from_domain
}
