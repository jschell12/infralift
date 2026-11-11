import type { Adopter, AdoptSkip } from "./types.js";
import { tfName } from "./types.js";

// ---------------------------------------------------------------------------
// AWS: the connector inventories anything the Tagging API returns, keyed by
// ARN. This table turns an ARN into the hashicorp/aws v5 resource type and the
// import id that resource's docs give. Where the ARN alone cannot produce the
// id, the entry says so rather than guessing.
//
// Keyed on "<service>:<resource type>", the resource type being the part of
// the ARN's resource before the first "/" or ":" (lowercased), or "" when the
// resource has no type (S3 buckets, SNS topics, SQS queues, API Gateway).
// ---------------------------------------------------------------------------

export interface Arn {
  arn: string;
  partition: string;
  service: string;
  region: string;
  account: string;
  /** Everything after the account field. */
  resource: string;
  /** The resource after its type and separator; the whole resource when untyped. */
  rest: string;
}

export function parseArn(arn: string): Arn | null {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;
  const [, partition, service, region, account] = parts;
  const resource = parts.slice(5).join(":");
  const sep = resource.search(/[/:]/);
  return { arn, partition, service, region, account, resource, rest: sep <= 0 ? resource : resource.slice(sep + 1) };
}

function typeOf(a: Arn): string {
  const sep = a.resource.search(/[/:]/);
  return sep <= 0 ? "" : a.resource.slice(0, sep).toLowerCase();
}

type Id = string | AdoptSkip;
interface Entry {
  tf: string | ((a: Arn) => string);
  id: (a: Arn) => Id;
  /** IAM, CloudFront and Route 53 are global; they use the default provider. */
  global?: true;
}

const rest = (a: Arn) => a.rest;
const whole = (a: Arn) => a.arn;
const last = (a: Arn) => a.rest.split("/").pop()!;
/** A name that must be a single segment, e.g. not a DynamoDB index or stream. */
const single = (what: string) => (a: Arn): Id => (/[/:]/.test(a.rest) ? { skip: `this ARN names a part of a ${what}, not the ${what} itself` } : a.rest);

export const AWS_KINDS: Record<string, Entry> = {
  "s3:": { tf: "aws_s3_bucket", id: single("bucket") },
  "ec2:instance": { tf: "aws_instance", id: rest },
  "ec2:volume": { tf: "aws_ebs_volume", id: rest },
  "ec2:vpc": { tf: "aws_vpc", id: rest },
  "ec2:subnet": { tf: "aws_subnet", id: rest },
  "ec2:security-group": { tf: "aws_security_group", id: rest },
  "ec2:internet-gateway": { tf: "aws_internet_gateway", id: rest },
  "ec2:natgateway": { tf: "aws_nat_gateway", id: rest },
  "ec2:route-table": { tf: "aws_route_table", id: rest },
  "ec2:elastic-ip": { tf: "aws_eip", id: rest },
  "ec2:launch-template": { tf: "aws_launch_template", id: rest },
  "ec2:key-pair": { tf: "aws_key_pair", id: () => ({ skip: "aws_key_pair imports by key name, and the ARN carries only the key pair id" }) },
  "rds:db": { tf: "aws_db_instance", id: rest },
  "rds:cluster": { tf: "aws_rds_cluster", id: rest },
  "lambda:function": { tf: "aws_lambda_function", id: single("function") },
  // aws_sqs_queue imports by queue URL, which is derivable for the aws partition.
  "sqs:": { tf: "aws_sqs_queue", id: (a) => `https://sqs.${a.region}.amazonaws.com/${a.account}/${a.rest}` },
  "sns:": { tf: "aws_sns_topic", id: whole },
  "dynamodb:table": { tf: "aws_dynamodb_table", id: single("table") },
  "ecr:repository": { tf: "aws_ecr_repository", id: rest },
  "ecs:cluster": { tf: "aws_ecs_cluster", id: rest },
  // "<cluster>/<service>". The old ARN format, service/<name>, omits the cluster.
  "ecs:service": {
    tf: "aws_ecs_service",
    id: (a) => (a.rest.split("/").length === 2 ? a.rest : { skip: "this older ECS service ARN does not name its cluster, which the import id needs" }),
  },
  "ecs:task-definition": { tf: "aws_ecs_task_definition", id: whole },
  "eks:cluster": { tf: "aws_eks_cluster", id: rest },
  // nodegroup/<cluster>/<node group>/<uuid> imports as "<cluster>:<node group>".
  "eks:nodegroup": {
    tf: "aws_eks_node_group",
    id: (a) => {
      const [cluster, group] = a.rest.split("/");
      return cluster && group ? `${cluster}:${group}` : { skip: "the node group ARN does not name its cluster" };
    },
  },
  "cloudfront:distribution": { tf: "aws_cloudfront_distribution", id: rest, global: true },
  "route53:hostedzone": { tf: "aws_route53_zone", id: rest, global: true },
  // Application, network and gateway load balancers import by ARN; a classic
  // load balancer's ARN is loadbalancer/<name> and imports by name.
  "elasticloadbalancing:loadbalancer": {
    tf: (a) => (/^(app|net|gwy)\//.test(a.rest) ? "aws_lb" : "aws_elb"),
    id: (a) => (/^(app|net|gwy)\//.test(a.rest) ? a.arn : a.rest),
  },
  "elasticloadbalancing:targetgroup": { tf: "aws_lb_target_group", id: whole },
  "elasticloadbalancing:listener": { tf: "aws_lb_listener", id: whole },
  "secretsmanager:secret": { tf: "aws_secretsmanager_secret", id: whole },
  // A role or user ARN carries its path (role/service-role/name); import is by name.
  "iam:role": { tf: "aws_iam_role", id: last, global: true },
  "iam:user": { tf: "aws_iam_user", id: last, global: true },
  "iam:policy": { tf: "aws_iam_policy", id: whole, global: true },
  "kms:key": { tf: "aws_kms_key", id: rest },
  "logs:log-group": { tf: "aws_cloudwatch_log_group", id: (a) => a.rest.replace(/:\*$/, "") },
  "cloudwatch:alarm": { tf: "aws_cloudwatch_metric_alarm", id: rest },
  "events:rule": { tf: "aws_cloudwatch_event_rule", id: rest },
  "elasticache:cluster": { tf: "aws_elasticache_cluster", id: rest },
  "elasticache:replicationgroup": { tf: "aws_elasticache_replication_group", id: rest },
  "elasticfilesystem:file-system": { tf: "aws_efs_file_system", id: rest },
  "states:statemachine": { tf: "aws_sfn_state_machine", id: whole },
  "kinesis:stream": { tf: "aws_kinesis_stream", id: rest },
  "cognito-idp:userpool": { tf: "aws_cognito_user_pool", id: rest },
  "acm:certificate": { tf: "aws_acm_certificate", id: whole },
  "es:domain": { tf: "aws_opensearch_domain", id: rest },
  "redshift:cluster": { tf: "aws_redshift_cluster", id: rest },
  "codebuild:project": { tf: "aws_codebuild_project", id: rest },
  // autoScalingGroup:<uuid>:autoScalingGroupName/<name>
  "autoscaling:autoscalinggroup": {
    tf: "aws_autoscaling_group",
    id: (a) => a.rest.split("autoScalingGroupName/")[1] || { skip: "the ARN does not carry the group name" },
  },
  // broker:<name>:<broker id>; aws_mq_broker imports by broker id.
  "mq:broker": { tf: "aws_mq_broker", id: (a) => a.rest.split(":")[1] || { skip: "the ARN does not carry the broker id" } },
  // arn:aws:apigateway:<region>::/restapis/<id> or ::/apis/<id> (HTTP and WebSocket).
  "apigateway:": {
    tf: (a) => (a.resource.startsWith("/apis/") ? "aws_apigatewayv2_api" : "aws_api_gateway_rest_api"),
    id: (a) => /^\/(restapis|apis)\/[a-z0-9]+$/.exec(a.resource)?.[0].split("/")[2] ?? { skip: "only whole REST, HTTP and WebSocket APIs are mapped, not their stages or routes" },
  },
  "ssm:parameter": {
    tf: "aws_ssm_parameter",
    id: () => ({ skip: "the ARN does not say whether the parameter name starts with a slash, which the import id needs" }),
  },
};

const REGION = /^[a-z]{2}-[a-z]+-\d$/;
/** The default provider's region, where global services live. */
export const AWS_DEFAULT_REGION = "us-east-1";

export const awsAdopter: Adopter = {
  provider: "aws",
  map(item) {
    if (item.type === "aws:account") return { skip: "the account itself is not a Terraform resource" };
    const raw = typeof item.metadata?.arn === "string" ? item.metadata.arn : item.externalId;
    const a = parseArn(raw);
    if (!a) return null;
    if (a.partition !== "aws") return { skip: `only the commercial aws partition is mapped, not ${a.partition}` };
    const entry = AWS_KINDS[`${a.service}:${typeOf(a)}`];
    if (!entry) return null;
    const id = entry.id(a);
    if (typeof id !== "string") return id;
    const tf = typeof entry.tf === "string" ? entry.tf : entry.tf(a);
    const to = `${tf}.${tfName(item.name)}`;
    if (entry.global) return { to, id };
    // S3 ARNs carry no region; the connector records the region it found the bucket in.
    const region = a.region || item.region || "";
    if (!REGION.test(region)) return { skip: "infralift could not tell which region it is in" };
    return { to, id, region };
  },
};
