# GCP connector test fixtures
#
# Provisions a Cloud Run service, GCS bucket, and Cloud Function stub.
# All within the free tier or the $300 trial credit for new accounts.
#
# Required env vars:
#   GOOGLE_CREDENTIALS (path to service account JSON key with Editor role)
#   - or - gcloud auth application-default login
#
# Cost: $0 (Cloud Run free: 2M req/mo; GCS free: 5GB standard; Functions free: 2M invocations)

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.45"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  default = "us-central1"
}

# Enable required APIs
resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

# GCS bucket (free tier: 5GB standard storage)
resource "google_storage_bucket" "test" {
  name          = "${var.project_id}-infralift-test"
  location      = var.region
  storage_class = "STANDARD"
  force_destroy = true

  labels = {
    managed-by = "terraform"
    project    = "infralift-test"
  }
}

# Cloud Run service (free tier: 2M requests/mo)
resource "google_cloud_run_v2_service" "test" {
  name     = "infralift-test"
  location = var.region

  deletion_protection = false

  template {
    containers {
      image = "gcr.io/cloudrun/hello"
      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }
    }
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
  }

  depends_on = [google_project_service.run]
}

# Allow unauthenticated access (so it's a real reachable service)
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.test.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "cloud_run_url" {
  value = google_cloud_run_v2_service.test.uri
}

output "bucket_name" {
  value = google_storage_bucket.test.name
}
