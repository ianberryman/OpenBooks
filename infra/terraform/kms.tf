# One customer-managed key per environment, used by RDS, SQS, the S3 buckets, Secrets
# Manager and CloudWatch Logs.
#
# One key rather than one per service: the blast radius of the key is the environment
# either way (anything able to read the database can read the attachments), so separate
# keys would add key policy surface and $1/month each without changing what an attacker
# reaches. Cross-service key policy statements are the cost of this choice and are all
# below.
resource "aws_kms_key" "main" {
  description             = "${local.name_prefix} data at rest"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.main.key_id
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch Logs encrypts with the key on its own behalf, so it needs a grant here
  # rather than an IAM policy. Scoped by the log group ARN pattern so this key cannot
  # be used to encrypt log groups belonging to another environment.
  statement {
    sid = "CloudWatchLogs"

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]

    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${data.aws_region.current.region}:${local.account_id}:log-group:/openbooks/${var.environment}/*"]
    }
  }

  # Required so RDS can put the generated master password into Secrets Manager, and so
  # SES/SQS can use the key for their own encryption on the account's behalf.
  statement {
    sid = "AwsServiceUse"

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:CreateGrant",
      "kms:DescribeKey",
    ]

    resources = ["*"]

    principals {
      type = "Service"
      identifiers = [
        "rds.amazonaws.com",
        "secretsmanager.amazonaws.com",
        "sqs.amazonaws.com",
        "ses.amazonaws.com",
        "delivery.logs.amazonaws.com",
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [local.account_id]
    }
  }
}
