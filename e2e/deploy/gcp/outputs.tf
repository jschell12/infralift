output "cloud_run_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.app.uri
}

output "database_url" {
  description = "Cloud SQL Postgres connection string"
  value       = "postgresql://infralift:${var.db_password}@${google_sql_database_instance.postgres.public_ip_address}:5432/infralift"
  sensitive   = true
}

output "bucket_name" {
  description = "GCS bucket name"
  value       = google_storage_bucket.storage.name
}
