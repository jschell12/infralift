# GCP E2E deployment for infralift-demo
#
# Provisions Cloud Run (Docker image), Cloud SQL for Postgres 16 (db-f1-micro),
# and a GCS bucket. Enables required APIs automatically.
#
# Prerequisites:
#   - GCP project with billing enabled
#   - gcloud auth application-default login (or GOOGLE_CREDENTIALS env var)
#   - APIs will be auto-enabled: Cloud Run, Cloud SQL Admin, Cloud Storage
#
# Required env vars:
#   GOOGLE_CREDENTIALS (path to service account JSON) or gcloud auth
#   TF_VAR_project_id, TF_VAR_db_password
#
# Cost estimate:
#   Cloud Run: $0 (2M req/mo free, 180k vCPU-sec, 360k GiB-sec)
#   Cloud SQL db-f1-micro: ~$7/mo (shared core, no free tier)
#   GCS: $0 (5GB standard free)
#   Total: ~$7/mo

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.45"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name = "infralift-e2e-${random_id.suffix.hex}"
}

# ---------- Enable APIs ----------

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "sqladmin" {
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

# ---------- Cloud SQL Postgres ----------

resource "google_sql_database_instance" "postgres" {
  name             = "${local.name}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  deletion_protection = false

  settings {
    tier              = "db-f1-micro"
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled    = true
      # Allow all for demo (restrict in production)
      authorized_networks {
        name  = "all"
        value = "0.0.0.0/0"
      }
    }

    user_labels = {
      project    = "infralift-e2e"
      managed-by = "terraform"
    }
  }

  depends_on = [google_project_service.sqladmin]
}

resource "google_sql_database" "infralift" {
  name     = "infralift"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "infralift" {
  name     = "infralift"
  instance = google_sql_database_instance.postgres.name
  password = var.db_password
}

# ---------- GCS bucket ----------

resource "google_storage_bucket" "storage" {
  name          = "${var.project_id}-${local.name}"
  location      = var.region
  storage_class = "STANDARD"
  force_destroy = true

  labels = {
    project    = "infralift-e2e"
    managed-by = "terraform"
  }

  depends_on = [google_project_service.storage]
}

# ---------- Cloud Run ----------

resource "google_cloud_run_v2_service" "app" {
  name     = local.name
  location = var.region

  deletion_protection = false

  template {
    containers {
      image = var.docker_image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "DATABASE_URL"
        value = "postgresql://infralift:${var.db_password}@${google_sql_database_instance.postgres.public_ip_address}:5432/infralift"
      }

      env {
        name  = "PROVIDER_NAME"
        value = "gcp"
      }

      env {
        name  = "STORAGE_BUCKET"
        value = google_storage_bucket.storage.name
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
  }

  depends_on = [google_project_service.run]
}

# Allow unauthenticated access
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
