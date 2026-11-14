# Where database snapshots go when they are exported out of RDS.
#
# Automated backups live inside RDS and disappear with their retention
# window. An export copies a snapshot to S3 as Parquet, where it outlives the
# instance and can be read without restoring it. RDS requires a customer KMS
# key for exports and a role it can assume to write the bucket; both are here.
#
# Objects move to Glacier Instant Retrieval after transition_days and are
# deleted after retention_days. Exports are started on demand (see the
# README); nothing here starts one.

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "exports" {
  description             = "${var.name}: RDS snapshot exports"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "exports" {
  name          = "alias/${var.name}-snapshot-exports"
  target_key_id = aws_kms_key.exports.key_id
}

resource "aws_s3_bucket" "exports" {
  # Bucket names are global; the account id keeps this one from colliding.
  bucket = "${var.name}-snapshot-exports-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "${var.name}-snapshot-exports" }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket = aws_s3_bucket.exports.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.exports.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    id     = "age-out-exports"
    status = "Enabled"

    filter {}

    transition {
      days          = var.transition_days
      storage_class = "GLACIER_IR"
    }

    expiration {
      days = var.retention_days
    }

    # Versioning keeps an overwritten or deleted export; this bounds how long.
    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.exports]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.exports.arn, "${aws_s3_bucket.exports.arn}/*"]
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

resource "aws_s3_bucket_policy" "exports" {
  bucket = aws_s3_bucket.exports.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.exports]
}

# The role RDS assumes to write an export, limited to this bucket and key.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["export.rds.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "export" {
  name               = "${var.name}-rds-snapshot-export"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "export" {
  statement {
    actions = [
      "s3:PutObject*",
      "s3:GetObject*",
      "s3:DeleteObject*",
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = [aws_s3_bucket.exports.arn, "${aws_s3_bucket.exports.arn}/*"]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.exports.arn]
  }
}

resource "aws_iam_role_policy" "export" {
  name   = "write-snapshot-exports"
  role   = aws_iam_role.export.id
  policy = data.aws_iam_policy_document.export.json
}
