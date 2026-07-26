# QUEUE_PROVIDER=sqs selects the adapter that talks to this queue. The self-host path
# sets in-process and this queue does not exist there — spec §2.5, and D-07 notes the
# adapter itself lands with its first consumer.

resource "aws_sqs_queue" "dlq" {
  name                              = "${var.name_prefix}-jobs-dlq"
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = 300

  # Maximum retention. A message reaches the DLQ only after max_receive_count failures,
  # which is a bug report; discarding it after four days would discard the evidence.
  message_retention_seconds = 1209600

  # Only the queue this is a DLQ for may redrive back into it, which stops a mistaken
  # redrive from another queue laundering unrelated messages into the job stream.
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

resource "aws_sqs_queue" "jobs" {
  name                              = "${var.name_prefix}-jobs"
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = 300

  # Must exceed the worst-case handler runtime, or SQS redelivers work that is still
  # running and the worker processes it twice.
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = 1209600

  # Long polling. Short polling on an idle queue is a per-request charge for nothing.
  receive_wait_time_seconds = 20

  # A standard queue, not FIFO: nothing in M1 enqueues anything (ROADMAP — the worker
  # role starts cleanly with no registered jobs), and the ledger's ordering guarantees
  # come from the database transaction in OB-020, not from queue ordering. Handlers must
  # be idempotent regardless, because standard SQS is at-least-once.
  sqs_managed_sse_enabled = false
}

# Separate resource rather than an inline redrive_policy, because the DLQ's
# redrive_allow_policy references the main queue and an inline policy on both sides is a
# dependency cycle Terraform cannot resolve.
resource "aws_sqs_queue_redrive_policy" "jobs" {
  queue_url = aws_sqs_queue.jobs.id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Alarming on the DLQ rather than on queue depth: depth is a capacity signal that needs a
# tuned threshold, while any message in the DLQ is unambiguously wrong. The alarm has no
# action wired to it — an SNS topic and its subscriptions are an on-call decision, not an
# infrastructure one. See the README's "not managed here".
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name_prefix}-jobs-dlq-not-empty"
  alarm_description   = "A job exhausted its retries. Inspect ${aws_sqs_queue.dlq.name}."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }
}
