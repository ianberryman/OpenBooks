# ===========================================================================
# Task IAM
# ===========================================================================
#
# Two roles per family, deliberately:
#   * EXECUTION role — used by the ECS agent before the container starts, to pull the
#     image and resolve `secrets` entries. Split by family so the api tasks' agent cannot
#     read the migrator credential and the migrate task's agent cannot read the app one.
#   * TASK role — the credentials the application process itself holds. Every statement
#     below names concrete resource ARNs. There is no `Resource: "*"` in this file except
#     where the AWS API genuinely has no resource to scope to, and each such case says so.

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

# ---------------------------------------------------------------------------
# Shared fragments
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecr_pull" {
  # ecr:GetAuthorizationToken has no resource — it mints a registry-wide token and the
  # API rejects any Resource other than "*". The layer-level actions immediately below
  # are what actually gate access, and those are scoped to the one repository.
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPullThisRepositoryOnly"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]

    resources = [local.ecr_repository_arn]
  }
}

# ---------------------------------------------------------------------------
# Execution role: api + worker
# ---------------------------------------------------------------------------
#
# api and worker share one execution role because they inject exactly the same two
# secrets. Splitting them would add a role without removing any access.

resource "aws_iam_role" "app_execution" {
  name               = "${var.name_prefix}-app-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "app_execution" {
  name   = "app-execution"
  role   = aws_iam_role.app_execution.id
  policy = data.aws_iam_policy_document.app_execution.json
}

data "aws_iam_policy_document" "app_execution" {
  source_policy_documents = [data.aws_iam_policy_document.ecr_pull.json]

  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]

    resources = [
      "${aws_cloudwatch_log_group.api.arn}:*",
      "${aws_cloudwatch_log_group.worker.arn}:*",
    ]
  }

  # Note what is absent: var.db_migrator_secret_arn. The running application must not be
  # able to obtain DDL rights even by reading a secret.
  statement {
    sid     = "InjectAppSecrets"
    actions = ["secretsmanager:GetSecretValue"]

    resources = [
      var.db_app_secret_arn,
      var.session_secret_arn,
    ]
  }

  statement {
    sid       = "DecryptInjectedSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution role: migrate
# ---------------------------------------------------------------------------

resource "aws_iam_role" "migrate_execution" {
  name               = "${var.name_prefix}-migrate-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "migrate_execution" {
  name   = "migrate-execution"
  role   = aws_iam_role.migrate_execution.id
  policy = data.aws_iam_policy_document.migrate_execution.json
}

data "aws_iam_policy_document" "migrate_execution" {
  source_policy_documents = [data.aws_iam_policy_document.ecr_pull.json]

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.migrate.arn}:*"]
  }

  statement {
    sid       = "InjectMigratorSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_migrator_secret_arn]
  }

  statement {
    sid       = "DecryptInjectedSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# Task roles
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "storage" {
  statement {
    sid     = "AttachmentObjects"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    # Objects, not the bucket. No s3:PutBucketPolicy, no s3:DeleteBucket, no
    # s3:PutBucketVersioning — the application cannot weaken the bucket it writes to.
    resources = ["${var.attachments_bucket_arn}/*"]
  }

  statement {
    sid       = "AttachmentListing"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [var.attachments_bucket_arn]
  }

  statement {
    sid       = "EncryptAttachments"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "email" {
  # Both the v2 (ses:SendEmail) and v1 (ses:SendRawEmail) action names, because which one
  # applies depends on whether the adapter uses SESv2Client or SESClient and D-07 defers
  # that adapter to its first consumer. Drop whichever is unused once it is written.
  statement {
    sid     = "SendFromThisIdentityOnly"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]

    resources = [
      var.ses_identity_arn,
      var.ses_configuration_set_arn,
    ]

    # Without this the role can send as any address in the verified domain, including
    # addresses belonging to real people. Pinning the From address means a compromised
    # task cannot impersonate billing@ or support@.
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_from_address]
    }
  }
}

data "aws_iam_policy_document" "execute_command" {
  # Only attached when var.enable_execute_command is set. These four actions have no
  # resource-level scoping in the SSM messages API; the gate is that the role is not
  # granted them at all in production.
  statement {
    sid = "SsmSessionChannel"

    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]

    resources = ["*"]
  }

  # The cluster encrypts execute-command session traffic with the environment CMK, and the
  # task role — not just the operator — must be able to use it. Without this, sessions fail
  # to open with a KMS error that reads like an ssmmessages problem.
  statement {
    sid       = "SsmSessionEncryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

# --- api ------------------------------------------------------------------

resource "aws_iam_role" "api_task" {
  name               = "${var.name_prefix}-api-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "api_task" {
  name   = "api-task"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

data "aws_iam_policy_document" "api_task" {
  source_policy_documents = concat(
    [
      data.aws_iam_policy_document.storage.json,
      data.aws_iam_policy_document.email.json,
    ],
    var.enable_execute_command ? [data.aws_iam_policy_document.execute_command.json] : [],
  )

  # The api enqueues and never consumes. It cannot ReceiveMessage, cannot DeleteMessage,
  # and has no access to the DLQ at all — an API request cannot quietly drain the queue.
  statement {
    sid     = "EnqueueOnly"
    actions = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]

    resources = [var.queue_arn]
  }

  statement {
    sid       = "EncryptQueuePayloads"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sqs.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

# --- worker ---------------------------------------------------------------

resource "aws_iam_role" "worker_task" {
  name               = "${var.name_prefix}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "worker-task"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}

data "aws_iam_policy_document" "worker_task" {
  source_policy_documents = concat(
    [
      data.aws_iam_policy_document.storage.json,
      data.aws_iam_policy_document.email.json,
    ],
    var.enable_execute_command ? [data.aws_iam_policy_document.execute_command.json] : [],
  )

  statement {
    sid = "ConsumeJobs"

    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]

    resources = [var.queue_arn]
  }

  # Read-only on the DLQ: enough to report depth and inspect a poisoned message, not
  # enough to delete the evidence. Redrive is an operator action through the console.
  statement {
    sid       = "InspectDlq"
    actions   = ["sqs:ReceiveMessage", "sqs:GetQueueAttributes"]
    resources = [var.dlq_arn]
  }

  statement {
    sid       = "EncryptQueuePayloads"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sqs.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

# --- migrate --------------------------------------------------------------

# A task role with no policy attached unless execute-command is on. The migrator talks to
# MySQL and to nothing else in AWS; giving it the api role's SQS and S3 access "for
# consistency" would hand DDL rights and queue access to the same identity.
resource "aws_iam_role" "migrate_task" {
  name               = "${var.name_prefix}-migrate-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "migrate_task" {
  count = var.enable_execute_command ? 1 : 0

  name   = "migrate-task"
  role   = aws_iam_role.migrate_task.id
  policy = data.aws_iam_policy_document.execute_command.json
}
