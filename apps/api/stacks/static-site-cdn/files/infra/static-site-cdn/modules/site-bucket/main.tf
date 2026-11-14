# The private bucket a static site's files live in.
#
# Nobody reads it directly: public access is blocked, and the only reader is
# the CloudFront distribution in ../cdn, which the bucket policy there names.
# Versioning keeps an overwritten or deleted file for 30 days, so a bad
# upload can be rolled back.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "site" {
  # Bucket names are global; the account id keeps this one from colliding.
  bucket = "${var.name}-site-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "${var.name}-site" }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# S3-managed keys: CloudFront's origin access control reads them with no key
# policy to maintain, which a KMS key would need.
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.site]
}
