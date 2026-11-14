output "bucket" {
  value = aws_s3_bucket.exports.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.exports.arn
}

output "export_role_arn" {
  value = aws_iam_role.export.arn
}
