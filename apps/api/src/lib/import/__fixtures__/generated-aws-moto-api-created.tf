# Captured 2026-11-14 from the e2e stack, not from real AWS: OpenTofu 1.12.6
# `plan -generate-config-out` with hashicorp/aws 6.73.0, against moto 5.2.5,
# for a KMS key and an SQS queue created through the API with no options, the
# way a console or CLI user makes them. moto leaves KeyUsage out (real AWS
# returns it), hence key_usage = "". The queue has SQS's 1 MiB default, which
# 6.x accepts (5.x rejected it). Below this header, byte for byte what OpenTofu
# wrote. Used by cleanup.test.ts.
# __generated__ by OpenTofu
# Please review these resources and move them into your main configuration files.

# __generated__ by OpenTofu
resource "aws_sqs_queue" "console" {
  provider                          = aws.us_east_1
  content_based_deduplication       = false
  deduplication_scope               = ""
  delay_seconds                     = 0
  fifo_queue                        = false
  fifo_throughput_limit             = ""
  kms_data_key_reuse_period_seconds = 300
  kms_master_key_id                 = ""
  max_message_size                  = 1048576
  message_retention_seconds         = 345600
  name                              = "console"
  name_prefix                       = ""
  policy                            = ""
  receive_wait_time_seconds         = 0
  redrive_allow_policy              = ""
  redrive_policy                    = ""
  region                            = "us-east-1"
  sqs_managed_sse_enabled           = true
  tags                              = {}
  tags_all                          = {}
  visibility_timeout_seconds        = 30
}

# __generated__ by OpenTofu
resource "aws_kms_key" "console" {
  provider                           = aws.us_east_1
  bypass_policy_lockout_safety_check = null
  custom_key_store_id                = ""
  customer_master_key_spec           = "SYMMETRIC_DEFAULT"
  deletion_window_in_days            = null
  description                        = ""
  enable_key_rotation                = false
  is_enabled                         = true
  key_usage                          = ""
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
  region                  = "us-east-1"
  rotation_period_in_days = 0
  tags                    = {}
  tags_all                = {}
  xks_key_id              = ""
}
