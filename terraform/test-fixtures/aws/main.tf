# AWS connector test fixtures
#
# Provisions an S3 bucket and a Route 53 health check — both free-tier eligible.
# The connector inventories aws:account (from the IAM role ARN), so any
# resources here just confirm the account has discoverable infrastructure.
#
# Required env vars:
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or AWS_PROFILE)
#
# Cost: $0 (S3 free tier: 5GB/2k PUTs/20k GETs; health check: first 50 free)

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.61"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "infralift-test"
      ManagedBy = "terraform"
    }
  }
}

variable "region" {
  default = "us-east-1"
}

variable "prefix" {
  default = "infralift-test"
}

# S3 bucket (free tier)
resource "aws_s3_bucket" "test" {
  bucket        = "${var.prefix}-${random_id.suffix.hex}"
  force_destroy = true
}

resource "random_id" "suffix" {
  byte_length = 4
}

# Route 53 health check (first 50 free)
resource "aws_route53_health_check" "test" {
  fqdn              = "example.com"
  type               = "HTTPS"
  port               = 443
  resource_path      = "/"
  failure_threshold  = 3
  request_interval   = 30

  tags = {
    Name = "${var.prefix}-healthcheck"
  }
}

# IAM role for infralift connector (read-only cross-account access)
data "aws_caller_identity" "current" {}

resource "aws_iam_role" "infralift_readonly" {
  name = "${var.prefix}-readonly"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = data.aws_caller_identity.current.arn
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "readonly" {
  role       = aws_iam_role.infralift_readonly.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

output "role_arn" {
  value       = aws_iam_role.infralift_readonly.arn
  description = "Paste this ARN into the infralift AWS connection"
}

output "bucket_name" {
  value = aws_s3_bucket.test.bucket
}
