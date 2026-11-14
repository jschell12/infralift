# Captured 2026-11-14 from a `make e2e` run (adopt-aws.e2e.test.ts), not from
# real AWS: the check's Generate step, `plan -generate-config-out` in the
# OpenTofu 1.12.6 container with hashicorp/aws 5.100.0 (adoption's ~> 5.0),
# against moto 5.2.5, for the resources apps/api/e2e/aws-seed/main.tf creates.
# Below this header, byte for byte what OpenTofu wrote, before the cleanup.
# Used by cleanup.test.ts.
# __generated__ by OpenTofu
# Please review these resources and move them into your main configuration files.

# __generated__ by OpenTofu
resource "aws_subnet" "subnet_861fd13d2d1f8ee16" {
  provider                                       = aws.us_east_1
  assign_ipv6_address_on_creation                = false
  availability_zone                              = "us-east-1a"
  availability_zone_id                           = "use1-az6"
  cidr_block                                     = "10.42.1.0/24"
  customer_owned_ipv4_pool                       = ""
  enable_dns64                                   = false
  enable_lni_at_device_index                     = 0
  enable_resource_name_dns_a_record_on_launch    = false
  enable_resource_name_dns_aaaa_record_on_launch = false
  ipv6_cidr_block                                = ""
  ipv6_native                                    = false
  map_customer_owned_ip_on_launch                = false
  map_public_ip_on_launch                        = false
  outpost_arn                                    = ""
  private_dns_hostname_type_on_launch            = "ip-name"
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
  vpc_id = "vpc-06ecc563645a822ca"
}

# __generated__ by OpenTofu
resource "aws_security_group" "sg_7ee5f2cef1cb7bffc" {
  provider               = aws.us_east_1
  description            = "hand made"
  egress                 = []
  ingress                = []
  name                   = "e2e-handmade-web"
  name_prefix            = ""
  revoke_rules_on_delete = null
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
  vpc_id = "vpc-06ecc563645a822ca"
}

# __generated__ by OpenTofu
resource "aws_cloudwatch_log_group" "_e2e_handmade_app" {
  provider          = aws.us_east_1
  kms_key_id        = ""
  log_group_class   = ""
  name              = "/e2e/handmade/app"
  name_prefix       = ""
  retention_in_days = 0
  skip_destroy      = false
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
}

# __generated__ by OpenTofu
resource "aws_sns_topic" "e2e_handmade_events" {
  provider                                 = aws.us_east_1
  application_failure_feedback_role_arn    = ""
  application_success_feedback_role_arn    = ""
  application_success_feedback_sample_rate = 0
  archive_policy                           = ""
  content_based_deduplication              = false
  delivery_policy                          = ""
  display_name                             = ""
  fifo_throughput_scope                    = ""
  fifo_topic                               = false
  firehose_failure_feedback_role_arn       = ""
  firehose_success_feedback_role_arn       = ""
  firehose_success_feedback_sample_rate    = 0
  http_failure_feedback_role_arn           = ""
  http_success_feedback_role_arn           = ""
  http_success_feedback_sample_rate        = 0
  kms_master_key_id                        = ""
  lambda_failure_feedback_role_arn         = ""
  lambda_success_feedback_role_arn         = ""
  lambda_success_feedback_sample_rate      = 0
  name                                     = "e2e-handmade-events"
  name_prefix                              = ""
  policy = jsonencode({
    Id = "__default_policy_ID"
    Statement = [{
      Action = ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"]
      Condition = {
        StringEquals = {
          "AWS:SourceOwner" = "123456789012"
        }
      }
      Effect = "Allow"
      Principal = {
        AWS = "*"
      }
      Resource = "arn:aws:sns:us-east-1:123456789012:e2e-handmade-events"
      Sid      = "__default_statement_ID"
    }]
    Version = "2008-10-17"
  })
  signature_version                = 0
  sqs_failure_feedback_role_arn    = ""
  sqs_success_feedback_role_arn    = ""
  sqs_success_feedback_sample_rate = 0
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
  tracing_config = ""
}

# __generated__ by OpenTofu
resource "aws_kms_key" "da83db11_4fb0_4c4d_8963_72affbc38047" {
  provider                           = aws.us_east_1
  bypass_policy_lockout_safety_check = null
  custom_key_store_id                = ""
  customer_master_key_spec           = "SYMMETRIC_DEFAULT"
  deletion_window_in_days            = null
  description                        = "e2e handmade key"
  enable_key_rotation                = false
  is_enabled                         = true
  key_usage                          = "ENCRYPT_DECRYPT"
  multi_region                       = false
  policy = jsonencode({
    Id = "key-default-1"
    Statement = [{
      Action = "kms:*"
      Effect = "Allow"
      Principal = {
        AWS = "arn:aws:iam::123456789012:root"
      }
      Resource = "*"
      Sid      = "Enable IAM User Permissions"
    }]
    Version = "2012-10-17"
  })
  rotation_period_in_days = 0
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
  xks_key_id = ""
}

# __generated__ by OpenTofu
resource "aws_dynamodb_table" "e2e_handmade_sessions" {
  provider                    = aws.us_east_1
  billing_mode                = "PAY_PER_REQUEST"
  deletion_protection_enabled = false
  hash_key                    = "id"
  name                        = "e2e-handmade-sessions"
  range_key                   = null
  read_capacity               = 0
  restore_date_time           = null
  restore_source_name         = null
  restore_source_table_arn    = null
  restore_to_latest_time      = null
  stream_enabled              = false
  stream_view_type            = ""
  table_class                 = "STANDARD"
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
  write_capacity = 0
  attribute {
    name = "id"
    type = "S"
  }
  point_in_time_recovery {
    enabled                 = false
    recovery_period_in_days = 0
  }
  ttl {
    attribute_name = ""
    enabled        = false
  }
}

# __generated__ by OpenTofu
resource "aws_vpc" "vpc_06ecc563645a822ca" {
  provider                             = aws.us_east_1
  assign_generated_ipv6_cidr_block     = false
  cidr_block                           = "10.42.0.0/16"
  enable_dns_hostnames                 = false
  enable_dns_support                   = true
  enable_network_address_usage_metrics = false
  instance_tenancy                     = "default"
  ipv4_ipam_pool_id                    = null
  ipv4_netmask_length                  = null
  ipv6_cidr_block                      = ""
  ipv6_cidr_block_network_border_group = ""
  ipv6_ipam_pool_id                    = ""
  ipv6_netmask_length                  = 0
  tags = {
    env = "e2e"
  }
  tags_all = {
    env = "e2e"
  }
}

# __generated__ by OpenTofu
resource "aws_s3_bucket" "e2e_handmade_assets" {
  provider            = aws.us_east_1
  bucket              = "e2e-handmade-assets"
  bucket_prefix       = ""
  force_destroy       = null
  object_lock_enabled = false
  tags = {
    Name = "e2e-handmade-assets"
    env  = "e2e"
  }
  tags_all = {
    Name = "e2e-handmade-assets"
    env  = "e2e"
  }
}
