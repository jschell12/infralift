# Migrating from AWS

## Prerequisites

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) (`brew install awscli`)
- `aws configure` completed (or `AWS_PROFILE` set)
- `pg_dump` and `pg_restore`
- `rclone` (for S3 sync)

## Database export

```bash
# Get the RDS endpoint from the console or CLI
aws rds describe-db-instances \
  --query 'DBInstances[*].[DBInstanceIdentifier,Endpoint.Address,Endpoint.Port]' \
  --output table

# Dump from RDS Postgres
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://username:password@your-rds-endpoint.rds.amazonaws.com:5432/dbname" \
  > aws-export.dump

# For RDS instances in a private subnet, use an SSH tunnel or Session Manager
aws ssm start-session --target i-bastion-instance-id \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["your-rds-endpoint.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}'

# Then dump via the tunnel
pg_dump --format=custom --no-owner --no-privileges \
  --clean --if-exists \
  "postgresql://username:password@localhost:15432/dbname" \
  > aws-export.dump
```

## Object storage sync

```bash
# List S3 buckets
aws s3 ls

# Sync S3 to local
aws s3 sync s3://your-bucket ./s3-export/

# Or use rclone for cross-provider sync (S3 to R2 directly)
rclone sync aws-s3:your-bucket r2:infralift-demo-storage/
```

## Environment variables

```bash
# From App Runner
aws apprunner describe-service \
  --service-arn arn:aws:apprunner:us-east-1:123456789:service/your-service \
  --query 'Service.SourceConfiguration.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables'

# From ECS task definition
aws ecs describe-task-definition --task-definition your-task \
  --query 'taskDefinition.containerDefinitions[0].environment'

# From Elastic Beanstalk
aws elasticbeanstalk describe-configuration-settings \
  --application-name your-app --environment-name your-env \
  --query 'ConfigurationSettings[0].OptionSettings[?Namespace==`aws:elasticbeanstalk:application:environment`]'

# From Lambda
aws lambda get-function-configuration --function-name your-function \
  --query 'Environment.Variables'
```

## DNS records

```bash
# List Route 53 hosted zones
aws route53 list-hosted-zones --query 'HostedZones[*].[Name,Id]' --output table

# List records in a zone
aws route53 list-resource-record-sets --hosted-zone-id Z1234567890 \
  --output json > route53-records.json
```

## Import to target

```bash
# Restore database to Neon
pg_restore --no-owner --no-privileges \
  --clean --if-exists \
  --dbname="$TARGET_DATABASE_URL" aws-export.dump

# Sync S3 to R2 (Cloudflare target) via rclone
rclone sync aws-s3:your-bucket r2:infralift-demo-storage/

# Or sync to a local volume (Hetzner target)
rsync -av ./s3-export/ /opt/app/uploads/
```
