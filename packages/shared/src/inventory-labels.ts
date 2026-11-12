// Human names for the connectors' inventory types ("cloudflare:dns_record"
// reads as "DNS records"). One table for the API and the dashboard, so a
// heading on the adopt view and anything else that names a type agree.
//
// The ids come from apps/api/src/connectors/*.ts. AWS ids are built from the
// ARN ("aws:<service>_<resource type>"), so the AWS rows below are the ones
// the adopt table in apps/api/src/lib/import/adopters/aws.ts knows; any other
// AWS type gets the readable fallback. apps/api/src/connectors/
// inventory-labels.test.ts fails when a connector emits a type that is not
// here.

/** Plural, because a label names a group of resources of that type. */
export const INVENTORY_TYPE_LABELS: Readonly<Record<string, string>> = {
  // AWS
  "aws:account": "Accounts",
  "aws:s3_bucket": "S3 buckets",
  "aws:ec2_instance": "EC2 instances",
  "aws:ec2_volume": "EBS volumes",
  "aws:ec2_vpc": "VPCs",
  "aws:ec2_subnet": "Subnets",
  "aws:ec2_security_group": "Security groups",
  "aws:ec2_internet_gateway": "Internet gateways",
  "aws:ec2_natgateway": "NAT gateways",
  "aws:ec2_route_table": "Route tables",
  "aws:ec2_elastic_ip": "Elastic IPs",
  "aws:ec2_launch_template": "Launch templates",
  "aws:ec2_key_pair": "Key pairs",
  "aws:rds_db": "RDS databases",
  "aws:rds_cluster": "RDS clusters",
  "aws:lambda_function": "Lambda functions",
  "aws:sqs_queue": "SQS queues",
  "aws:sns_topic": "SNS topics",
  "aws:dynamodb_table": "DynamoDB tables",
  "aws:ecr_repository": "ECR repositories",
  "aws:ecs_cluster": "ECS clusters",
  "aws:ecs_service": "ECS services",
  "aws:ecs_task_definition": "ECS task definitions",
  "aws:eks_cluster": "EKS clusters",
  "aws:eks_nodegroup": "EKS node groups",
  "aws:cloudfront_distribution": "CloudFront distributions",
  "aws:route53_hostedzone": "Route 53 hosted zones",
  "aws:elasticloadbalancing_loadbalancer": "Load balancers",
  "aws:elasticloadbalancing_targetgroup": "Target groups",
  "aws:elasticloadbalancing_listener": "Load balancer listeners",
  "aws:secretsmanager_secret": "Secrets Manager secrets",
  "aws:iam_role": "IAM roles",
  "aws:iam_user": "IAM users",
  "aws:iam_policy": "IAM policies",
  "aws:kms_key": "KMS keys",
  "aws:logs_log_group": "CloudWatch log groups",
  "aws:cloudwatch_alarm": "CloudWatch alarms",
  "aws:events_rule": "EventBridge rules",
  "aws:elasticache_cluster": "ElastiCache clusters",
  "aws:elasticache_replicationgroup": "ElastiCache replication groups",
  "aws:elasticfilesystem_file_system": "EFS file systems",
  "aws:states_statemachine": "Step Functions state machines",
  "aws:kinesis_stream": "Kinesis streams",
  "aws:cognito-idp_userpool": "Cognito user pools",
  "aws:acm_certificate": "ACM certificates",
  "aws:es_domain": "OpenSearch domains",
  "aws:redshift_cluster": "Redshift clusters",
  "aws:codebuild_project": "CodeBuild projects",
  "aws:autoscaling_autoscalinggroup": "Auto Scaling groups",
  "aws:mq_broker": "MQ brokers",
  // An API Gateway ARN's resource starts with "/restapis/", so the connector
  // finds no resource type before the separator and the id ends in "_".
  "aws:apigateway_": "API Gateway APIs",
  "aws:ssm_parameter": "SSM parameters",

  // Azure
  "azure:subscription": "Subscriptions",
  "azure:app_service_plan": "App Service plans",
  "azure:app_service": "App Services",
  "azure:function_app": "Function apps",
  "azure:virtual_machine": "Virtual machines",
  "azure:sql_server": "SQL servers",
  "azure:sql_database": "SQL databases",
  "azure:storage_account": "Storage accounts",

  // Cloudflare
  "cloudflare:worker": "Workers",
  "cloudflare:pages_project": "Pages projects",
  "cloudflare:r2_bucket": "R2 buckets",
  "cloudflare:zone": "Zones",
  "cloudflare:dns_record": "DNS records",
  "cloudflare:load_balancer": "Load balancers",

  // DigitalOcean
  "digitalocean:droplet": "Droplets",
  "digitalocean:app": "Apps",
  "digitalocean:database": "Databases",
  "digitalocean:space": "Spaces",
  "digitalocean:domain": "Domains",
  "digitalocean:kubernetes": "Kubernetes clusters",

  // Firebase
  "firebase:project": "Projects",
  "firebase:hosting_site": "Hosting sites",
  "firebase:function": "Functions",
  "firebase:firestore_database": "Firestore databases",
  "firebase:cloud_run": "Cloud Run services",
  "firebase:cloud_sql": "Cloud SQL instances",

  // Fly.io
  "flyio:app": "Apps",
  "flyio:machine": "Machines",
  "flyio:volume": "Volumes",

  // Google Cloud
  "gcp:project": "Projects",
  "gcp:cloud_run_service": "Cloud Run services",
  "gcp:cloud_run": "Cloud Run services",
  "gcp:gce_instance": "Compute Engine instances",
  "gcp:cloud_sql": "Cloud SQL instances",
  "gcp:gcs_bucket": "Cloud Storage buckets",
  "gcp:cloud_function": "Cloud Functions",
  "gcp:firestore_database": "Firestore databases",

  // Heroku
  "heroku:app": "Apps",
  "heroku:dyno": "Dynos",
  "heroku:addon": "Add-ons",

  // Netlify
  "netlify:site": "Sites",
  "netlify:dns_zone": "DNS zones",
  "netlify:form": "Forms",
  "netlify:build_hook": "Build hooks",

  // Railway
  "railway:project": "Projects",
  "railway:service": "Services",
  "railway:plugin": "Plugins",
  "railway:environment": "Environments",

  // Render. Services are "render:<service type>", the types Render's API
  // returns; "render:service" is the connector's fallback when it has none.
  "render:web_service": "Web services",
  "render:static_site": "Static sites",
  "render:private_service": "Private services",
  "render:background_worker": "Background workers",
  "render:cron_job": "Cron jobs",
  "render:service": "Services",
  "render:postgres": "Postgres databases",
  "render:redis": "Redis instances",
  "render:env_group": "Environment groups",

  // Vercel
  "vercel:project": "Projects",
  "vercel:domain": "Domains",
  "vercel:postgres": "Postgres databases",
};

/** "load_balancer" or "log-group" as "Load balancer" / "Log group". */
function readable(id: string): string {
  const words = id.replace(/[_:-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * The name to show for an inventory type. Known types come from the table;
 * billing lines ("<provider>:usage") are "Usage"; anything else is the part
 * after the provider made readable ("aws:ec2_dedicated_host" becomes
 * "Ec2 dedicated host"), never the raw id. An id with nothing readable in it
 * is returned as it is, so a heading is never empty.
 */
export function inventoryTypeLabel(type: string): string {
  const known = INVENTORY_TYPE_LABELS[type];
  if (known) return known;
  if (type.endsWith(":usage")) return "Usage";
  const colon = type.indexOf(":");
  const rest = colon === -1 ? type : type.slice(colon + 1);
  return readable(rest) || readable(type) || type;
}
