# STORAGE_PROVIDER=s3 selects the adapter that writes here; self-host sets local.

resource "aws_s3_bucket" "attachments" {
  bucket = "${var.name_prefix}-attachments"

  lifecycle {
    # Receipts and bank statements attached to accounting records. Deleting the bucket is
    # never the intent of a plan that happens to delete the bucket.
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }

    # Without this, every GET is a separate KMS Decrypt call and KMS becomes both a cost
    # line and a throttling limit on attachment reads.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  # Versioning here is a backstop against a bad overwrite or delete, not an archive.
  # Without expiry, every superseded version is billed forever.
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.attachments_noncurrent_version_days
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

# The application reaches this bucket through an IAM role, so plain HTTP has no
# legitimate use and unencrypted transport of a customer's bank statement does.
resource "aws_s3_bucket_policy" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  policy = data.aws_iam_policy_document.attachments.json

  depends_on = [aws_s3_bucket_public_access_block.attachments]
}

data "aws_iam_policy_document" "attachments" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.attachments.arn,
      "${aws_s3_bucket.attachments.arn}/*",
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
}
