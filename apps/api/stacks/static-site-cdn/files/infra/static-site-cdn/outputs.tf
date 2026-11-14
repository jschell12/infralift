output "url" {
  value = module.cdn.url
}

output "bucket" {
  description = "Upload the site here: aws s3 sync ./dist s3://<bucket> --delete"
  value       = module.site_bucket.bucket
}

output "distribution_id" {
  description = "Clear the cache after an upload: aws cloudfront create-invalidation --distribution-id <this> --paths '/*'"
  value       = module.cdn.distribution_id
}

output "distribution_domain_name" {
  value = module.cdn.distribution_domain_name
}
