# One PostgreSQL instance on RDS, reachable only from inside the network.
#
# It lives in the private subnets it is given, is never publicly accessible,
# and its security group admits port 5432 from one CIDR (the VPC's own range
# unless told otherwise) and optionally one security group. Storage is
# encrypted, deletion protection is on, and deleting it anyway takes a final
# snapshot.
#
# The master password is generated and rotated by RDS in Secrets Manager
# (manage_master_user_password), so it never appears in this code, in a
# variable or in state.

data "aws_vpc" "this" {
  id = var.vpc_id
}

locals {
  allowed_cidr = var.allowed_cidr != "" ? var.allowed_cidr : data.aws_vpc.this.cidr_block
  # "17" becomes "postgres17": a parameter group belongs to one major version.
  parameter_family = "postgres${split(".", var.engine_version)[0]}"
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids

  tags = { Name = var.name }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-postgres"
  description = "PostgreSQL clients allowed to reach ${var.name}"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.name}-postgres" }
}

resource "aws_vpc_security_group_ingress_rule" "cidr" {
  security_group_id = aws_security_group.db.id
  description       = "PostgreSQL from ${local.allowed_cidr}"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = local.allowed_cidr
}

resource "aws_vpc_security_group_ingress_rule" "group" {
  count = var.allowed_security_group_id != "" ? 1 : 0

  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${var.allowed_security_group_id}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.allowed_security_group_id
}

# No egress rule: the database answers connections and starts none.

resource "aws_db_parameter_group" "this" {
  name        = "${var.name}-${local.parameter_family}"
  family      = local.parameter_family
  description = "${var.name}: TLS required, slow statements logged"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # A new major version needs a new group; create it before the old one goes.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  username                    = "dbadmin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-03:30"
  maintenance_window      = "sun:04:00-sun:04:30"
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"

  tags = { Name = var.name }
}
