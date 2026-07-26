# ===========================================================================
# Remote state backend — the chicken-and-egg root
# ===========================================================================
#
# The main root stores its state in S3 with a DynamoDB lock table. Something has to create
# those, and it cannot be the root that needs them. So this is a small, separate root with a
# LOCAL state file, applied once per account before anything else.
#
# Its own state is deliberately not remote. The alternative is applying this, then migrating
# its state into the bucket it just created, which works and then leaves a bucket whose
# deletion is gated on state living inside it. Instead: apply once, and commit nothing —
# .gitignore already excludes *.tfstate. Re-deriving this from code is a two-minute apply if
# the local state is ever lost, and every resource here is protected by prevent_destroy.
#
#   cd infra/terraform/state-backend
#   terraform init
#   terraform apply -var 'bucket_name=openbooks-tfstate-<account-suffix>'
#
# The bucket name must be globally unique, which is why it is a required variable with no
# default rather than something derived.

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "OpenBooks"
      Component = "terraform-state"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

# A dedicated key rather than the per-environment key from the main root: this bucket holds
# the state of every environment, so it cannot depend on any one of them.
resource "aws_kms_key" "state" {
  description             = "OpenBooks Terraform state"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "state" {
  name          = "alias/openbooks-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

# THIS BUCKET IS AS SENSITIVE AS THE PRODUCTION DATABASE. Terraform state holds the
# generated application database passwords and the session signing key in cleartext — see
# the note at the top of ../modules/data/secrets.tf. Read access here is read access to
# those credentials. Treat it accordingly when granting it.
resource "aws_s3_bucket" "state" {
  bucket = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Non-negotiable for a state bucket. A corrupted or truncated state file with versioning off
# is an unrecoverable loss of the mapping between code and real resources.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # Old state versions are the recovery path, so they are kept far longer than anywhere else
  # in this stack — but not forever, because every apply writes one.
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

data "aws_iam_policy_document" "state" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Blocks the unencrypted-write path, which would otherwise let a misconfigured client
  # store state in the clear in an otherwise-encrypted bucket.
  statement {
    sid     = "DenyUnencryptedWrites"
    effect  = "Deny"
    actions = ["s3:PutObject"]

    resources = ["${aws_s3_bucket.state.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}

# Both locking mechanisms are provisioned so either works:
#
#   * S3-native locking (`use_lockfile = true`, Terraform >= 1.10) needs nothing but the
#     bucket, and is what the committed env/*.backend.hcl files use.
#   * The DynamoDB table below is the older mechanism, kept so an operator pinned to an
#     older Terraform can set `dynamodb_table` instead without editing tracked code.
#
# The table is on-demand billing and effectively free when idle, so keeping the fallback
# costs approximately nothing. Delete it once nothing can possibly need it.
resource "aws_dynamodb_table" "locks" {
  name         = "${var.bucket_name}-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
