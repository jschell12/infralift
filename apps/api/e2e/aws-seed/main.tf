# Resources "built by hand" in the emulated AWS account, which the e2e suite
# then adopts. Applied into moto by the suite (adopt-aws.e2e.test.ts), never
# against real AWS: the provider is pointed at moto by AWS_ENDPOINT_URL and
# carries moto's fixed test credentials. Tagged, because the connector lists
# what the Resource Groups Tagging API returns.
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
