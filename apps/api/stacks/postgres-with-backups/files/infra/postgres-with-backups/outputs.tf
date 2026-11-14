output "db_address" {
  value = module.database.address
}

output "db_port" {
  value = module.database.port
}

output "db_security_group_id" {
  value = module.database.security_group_id
}

output "db_master_user_secret_arn" {
  description = "Read the password with: aws secretsmanager get-secret-value --secret-id <this>"
  value       = module.database.master_user_secret_arn
}

output "db_arn" {
  value = module.database.arn
}

output "export_bucket" {
  value = module.snapshot_exports.bucket
}

output "export_kms_key_arn" {
  value = module.snapshot_exports.kms_key_arn
}

output "export_role_arn" {
  value = module.snapshot_exports.export_role_arn
}
