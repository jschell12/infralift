# Resources "built by hand" in the emulated AWS account, which the e2e suite
# then adopts. Applied into moto by the suite (adopt-aws.e2e.test.ts), never
# against real AWS: the provider is pointed at moto by AWS_ENDPOINT_URL and
# carries moto's fixed test credentials. Tagged, because the connector lists
# what the Resource Groups Tagging API returns.
#
# This provider only stands in for the person who built them, so its version
# is not adoption's (adoption pins ~> 6.73.0 in lib/tf/codegen.ts). It stays on
# 5.x because 6.x sends a bucket's tags inside CreateBucket, which moto 5.2.5
# drops (measured 2026-11-14): the bucket would be untagged, and the Tagging
# API, which is how the connector finds it, would not list it.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region                      = "us-east-1"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
}

# The bucket the adopted project keeps its state in (the customer's bucket).
resource "aws_s3_bucket" "state" {
  bucket = "e2e-tofu-state"
}

resource "aws_s3_bucket" "assets" {
  bucket = "e2e-handmade-assets"
  tags   = { Name = "e2e-handmade-assets", env = "e2e" }
}

resource "aws_dynamodb_table" "sessions" {
  name         = "e2e-handmade-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
  tags = { env = "e2e" }
}

resource "aws_sns_topic" "events" {
  name = "e2e-handmade-events"
  tags = { env = "e2e" }
}

# Created by the provider, which sends KeyUsage = ENCRYPT_DECRYPT. A key made
# through moto's API with no options comes back without KeyUsage (real AWS
# always returns it), and its generated code would then plan a replacement;
# see GENERATED_CLEANUP_RULES in src/lib/import/cleanup.ts.
resource "aws_kms_key" "data" {
  description = "e2e handmade key"
  tags        = { env = "e2e" }
}

resource "aws_vpc" "main" {
  cidr_block = "10.42.0.0/16"
  tags       = { env = "e2e" }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.1.0/24"
  availability_zone = "us-east-1a"
  tags              = { env = "e2e" }
}

resource "aws_security_group" "web" {
  name        = "e2e-handmade-web"
  description = "hand made"
  vpc_id      = aws_vpc.main.id
  tags        = { env = "e2e" }
}

resource "aws_cloudwatch_log_group" "app" {
  name = "/e2e/handmade/app"
  tags = { env = "e2e" }
}

# The SQS queue is not here: a queue made in the console or CLI gets SQS's own
# defaults (a 1 MiB message size), which is the case that matters, so the
# suite creates it through moto's API instead of through the provider.
