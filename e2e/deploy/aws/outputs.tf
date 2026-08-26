output "app_url" {
  description = "App Runner service URL"
  value       = "https://${aws_apprunner_service.app.service_url}"
}

output "database_url" {
  description = "Postgres connection string"
  value       = "postgresql://${aws_db_instance.postgres.username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}"
  sensitive   = true
}

output "bucket_name" {
  description = "S3 bucket name for object storage"
  value       = aws_s3_bucket.storage.bucket
}
