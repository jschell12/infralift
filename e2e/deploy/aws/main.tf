# AWS E2E deployment for infralift-demo
#
# Provisions App Runner (Docker), RDS Postgres 16 (db.t4g.micro), and S3 bucket.
# App Runner pulls from a public Docker image (ECR_PUBLIC or Docker Hub).
#
# Prerequisites:
#   - AWS CLI configured (aws configure) or env vars set
#   - Docker image pushed to a public registry
#
# Required env vars:
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or AWS_PROFILE)
#   TF_VAR_db_password (Postgres password)
#
# Cost estimate:
#   App Runner: ~$5/mo (1 vCPU, 2GB, paused when idle)
#   RDS db.t4g.micro: $0 (750 hrs/mo free tier for 12 months)
#   S3: $0 (5GB free tier)
#   Total: ~$5/mo (less with free tier)

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.61"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "infralift-e2e"
      ManagedBy = "terraform"
    }
  }
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name = "${var.prefix}-${random_id.suffix.hex}"
}

# ---------- VPC networking for RDS ----------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "rds" {
  name_prefix = "${local.name}-rds-"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Postgres from App Runner (public access for demo only)"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "default" {
  name       = "${local.name}-dbsubnet"
  subnet_ids = data.aws_subnets.default.ids
}

# ---------- RDS Postgres ----------

resource "aws_db_instance" "postgres" {
  identifier     = "${local.name}-pg"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"

  db_name  = "infralift"
  username = "infralift"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.default.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = true
  skip_final_snapshot    = true

  tags = {
    Name = "${local.name}-postgres"
  }
}

# ---------- S3 bucket ----------

resource "aws_s3_bucket" "storage" {
  bucket        = local.name
  force_destroy = true
}

# ---------- App Runner ----------

resource "aws_apprunner_service" "app" {
  service_name = local.name

  source_configuration {
    auto_deployments_enabled = false

    image_repository {
      image_identifier      = var.docker_image
      image_repository_type = "ECR_PUBLIC"

      image_configuration {
        port = "3000"
        runtime_environment_variables = {
          DATABASE_URL  = "postgresql://${aws_db_instance.postgres.username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}"
          PROVIDER_NAME = "aws"
          STORAGE_BUCKET = aws_s3_bucket.storage.bucket
          STORAGE_REGION = var.region
        }
      }
    }
  }

  instance_configuration {
    cpu    = "1024"
    memory = "2048"
  }

  tags = {
    Name = local.name
  }
}
