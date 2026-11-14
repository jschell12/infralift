# VPC flow logs to a CloudWatch log group that expires what it holds.
#
# Every accepted and rejected connection in the VPC is recorded, which is what
# you want when something was reachable that should not have been. The log
# group's retention is what bounds the cost: ingestion is billed per GB, and
# storage is billed for as long as the logs are kept.

data "aws_partition" "current" {}

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/vpc/${var.name}/flow-logs"
  retention_in_days = var.retention_days
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow" {
  name               = "${var.name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

# Write access to this log group only, not to every log group in the account.
data "aws_iam_policy_document" "write" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:${data.aws_partition.current.partition}:logs:*:*:log-group:*"]
  }
}

resource "aws_iam_role_policy" "flow" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.write.json
}

resource "aws_flow_log" "this" {
  vpc_id                   = var.vpc_id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flow.arn
  max_aggregation_interval = 600

  tags = { Name = "${var.name}-flow-logs" }
}
