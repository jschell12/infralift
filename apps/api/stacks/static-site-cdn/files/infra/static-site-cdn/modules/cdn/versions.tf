terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73.0"
      # CloudFront only accepts certificates from us-east-1, whatever region
      # the bucket is in.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
