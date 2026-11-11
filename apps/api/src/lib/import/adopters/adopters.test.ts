import { describe, expect, it } from "vitest";
import type { Provider, ResourceInventoryItem } from "@infralift/shared";
import { planAdoption, renderAdoption } from "../adopt.js";
import { adopterFor } from "./index.js";

// ARN formats are the ones in the AWS Service Authorization Reference for each
// service; resource types and import ids are those in the hashicorp/aws v5
// docs. None of these were captured from a live account.
const ACCT = "123456789012";
const awsItem = (arn: string, name = "thing", region?: string): ResourceInventoryItem => ({
  provider: "aws",
  type: "aws:any",
  externalId: arn,
  name,
  region,
  metadata: { arn },
});

describe("aws adopter", () => {
  const cases: [string, string, string, string | undefined][] = [
    // [ARN, resource type, import id, region alias or undefined for global]
    [`arn:aws:s3:::assets-bucket`, "aws_s3_bucket", "assets-bucket", "us_west_2"],
    [`arn:aws:ec2:us-west-2:${ACCT}:instance/i-0abcd1234efgh5678`, "aws_instance", "i-0abcd1234efgh5678", "us_west_2"],
    [`arn:aws:ec2:us-west-2:${ACCT}:vpc/vpc-0a1b2c3d`, "aws_vpc", "vpc-0a1b2c3d", "us_west_2"],
    [`arn:aws:ec2:us-west-2:${ACCT}:security-group/sg-0a1b2c3d`, "aws_security_group", "sg-0a1b2c3d", "us_west_2"],
    [`arn:aws:ec2:us-west-2:${ACCT}:elastic-ip/eipalloc-0a1b2c3d`, "aws_eip", "eipalloc-0a1b2c3d", "us_west_2"],
    [`arn:aws:rds:us-west-2:${ACCT}:db:orders-db`, "aws_db_instance", "orders-db", "us_west_2"],
    [`arn:aws:rds:us-west-2:${ACCT}:cluster:orders-cluster`, "aws_rds_cluster", "orders-cluster", "us_west_2"],
    [`arn:aws:lambda:us-west-2:${ACCT}:function:resize-images`, "aws_lambda_function", "resize-images", "us_west_2"],
    [`arn:aws:sqs:us-west-2:${ACCT}:jobs`, "aws_sqs_queue", `https://sqs.us-west-2.amazonaws.com/${ACCT}/jobs`, "us_west_2"],
    [`arn:aws:sns:us-west-2:${ACCT}:alerts`, "aws_sns_topic", `arn:aws:sns:us-west-2:${ACCT}:alerts`, "us_west_2"],
    [`arn:aws:dynamodb:us-west-2:${ACCT}:table/users`, "aws_dynamodb_table", "users", "us_west_2"],
    [`arn:aws:ecr:us-west-2:${ACCT}:repository/team/api`, "aws_ecr_repository", "team/api", "us_west_2"],
    [`arn:aws:ecs:us-west-2:${ACCT}:cluster/prod`, "aws_ecs_cluster", "prod", "us_west_2"],
    [`arn:aws:ecs:us-west-2:${ACCT}:service/prod/api`, "aws_ecs_service", "prod/api", "us_west_2"],
    [`arn:aws:ecs:us-west-2:${ACCT}:task-definition/api:7`, "aws_ecs_task_definition", `arn:aws:ecs:us-west-2:${ACCT}:task-definition/api:7`, "us_west_2"],
    [`arn:aws:eks:us-west-2:${ACCT}:cluster/prod`, "aws_eks_cluster", "prod", "us_west_2"],
    [`arn:aws:eks:us-west-2:${ACCT}:nodegroup/prod/workers/0ac2b8f4-1234`, "aws_eks_node_group", "prod:workers", "us_west_2"],
    [`arn:aws:cloudfront::${ACCT}:distribution/EDFDVBD6EXAMPLE`, "aws_cloudfront_distribution", "EDFDVBD6EXAMPLE", undefined],
    [`arn:aws:route53:::hostedzone/Z1D633PJN98FT9`, "aws_route53_zone", "Z1D633PJN98FT9", undefined],
    [`arn:aws:elasticloadbalancing:us-west-2:${ACCT}:loadbalancer/app/web/50dc6c495c0c9188`, "aws_lb", `arn:aws:elasticloadbalancing:us-west-2:${ACCT}:loadbalancer/app/web/50dc6c495c0c9188`, "us_west_2"],
    [`arn:aws:elasticloadbalancing:us-west-2:${ACCT}:loadbalancer/legacy-web`, "aws_elb", "legacy-web", "us_west_2"],
    [`arn:aws:elasticloadbalancing:us-west-2:${ACCT}:targetgroup/web/73e2d6bc24d8a067`, "aws_lb_target_group", `arn:aws:elasticloadbalancing:us-west-2:${ACCT}:targetgroup/web/73e2d6bc24d8a067`, "us_west_2"],
    [`arn:aws:secretsmanager:us-west-2:${ACCT}:secret:db-pass-AbCdEf`, "aws_secretsmanager_secret", `arn:aws:secretsmanager:us-west-2:${ACCT}:secret:db-pass-AbCdEf`, "us_west_2"],
    [`arn:aws:iam::${ACCT}:role/service-role/deployer`, "aws_iam_role", "deployer", undefined],
    [`arn:aws:iam::${ACCT}:policy/deploy`, "aws_iam_policy", `arn:aws:iam::${ACCT}:policy/deploy`, undefined],
    [`arn:aws:kms:us-west-2:${ACCT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`, "aws_kms_key", "1234abcd-12ab-34cd-56ef-1234567890ab", "us_west_2"],
    [`arn:aws:logs:us-west-2:${ACCT}:log-group:/aws/lambda/resize:*`, "aws_cloudwatch_log_group", "/aws/lambda/resize", "us_west_2"],
    [`arn:aws:elasticache:us-west-2:${ACCT}:cluster:sessions`, "aws_elasticache_cluster", "sessions", "us_west_2"],
    [`arn:aws:elasticache:us-west-2:${ACCT}:replicationgroup:cache`, "aws_elasticache_replication_group", "cache", "us_west_2"],
    [`arn:aws:elasticfilesystem:us-west-2:${ACCT}:file-system/fs-0123abcd`, "aws_efs_file_system", "fs-0123abcd", "us_west_2"],
    [`arn:aws:states:us-west-2:${ACCT}:stateMachine:orders`, "aws_sfn_state_machine", `arn:aws:states:us-west-2:${ACCT}:stateMachine:orders`, "us_west_2"],
    [`arn:aws:autoscaling:us-west-2:${ACCT}:autoScalingGroup:0a1b-2c3d:autoScalingGroupName/web-asg`, "aws_autoscaling_group", "web-asg", "us_west_2"],
    [`arn:aws:mq:us-west-2:${ACCT}:broker:events:b-1234a5b6-78cd-901e-2fgh-3i45j6k178l9`, "aws_mq_broker", "b-1234a5b6-78cd-901e-2fgh-3i45j6k178l9", "us_west_2"],
    [`arn:aws:apigateway:us-west-2::/restapis/a1b2c3d4e5`, "aws_api_gateway_rest_api", "a1b2c3d4e5", "us_west_2"],
    [`arn:aws:apigateway:us-west-2::/apis/a1b2c3d4e5`, "aws_apigatewayv2_api", "a1b2c3d4e5", "us_west_2"],
  ];

  it.each(cases)("%s", (arn, tf, id, alias) => {
    const plan = planAdoption("aws", [awsItem(arn, "thing", "us-west-2")]);
    expect(plan.skipped).toEqual([]);
    expect(plan.imports[0]).toMatchObject({ to: `${tf}.thing`, id });
    expect(plan.imports[0].provider).toBe(alias && `aws.${alias}`);
  });

  it("skips with a reason when the ARN cannot produce the import id", () => {
    const plan = planAdoption("aws", [
      awsItem(`arn:aws:ec2:us-west-2:${ACCT}:key-pair/key-0123abcd`),
      awsItem(`arn:aws:ssm:us-west-2:${ACCT}:parameter/app/db-url`),
      awsItem(`arn:aws:ecs:us-west-2:${ACCT}:service/api`),
      awsItem(`arn:aws:dynamodb:us-west-2:${ACCT}:table/users/stream/2026-01-01T00:00:00.000`),
      awsItem(`arn:aws:apigateway:us-west-2::/restapis/a1b2c3d4e5/stages/prod`),
      awsItem(`arn:aws-cn:s3:::assets`),
      awsItem(`arn:aws:s3:::no-region-known`),
      awsItem(`arn:aws:glacier:us-west-2:${ACCT}:vaults/archive`),
    ]);
    expect(plan.imports).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      "aws_key_pair imports by key name, and the ARN carries only the key pair id",
      "the ARN does not say whether the parameter name starts with a slash, which the import id needs",
      "this older ECS service ARN does not name its cluster, which the import id needs",
      "this ARN names a part of a table, not the table itself",
      "only whole REST, HTTP and WebSocket APIs are mapped, not their stages or routes",
      "only the commercial aws partition is mapped, not aws-cn",
      "infralift could not tell which region it is in",
      "no Terraform import mapping for this kind yet",
    ]);
  });

  it("writes one aliased provider per region and puts each import on it", () => {
    const plan = planAdoption("aws", [
      awsItem(`arn:aws:ec2:eu-west-1:${ACCT}:instance/i-0aaa`, "eu"),
      awsItem(`arn:aws:ec2:us-west-2:${ACCT}:instance/i-0bbb`, "us"),
      awsItem(`arn:aws:iam::${ACCT}:role/deployer`, "deployer"),
    ]);
    const files = render("aws", plan);
    expect(files["provider.tf"]).toContain(
      ['provider "aws" {', '  region = "us-east-1"', "}", "", 'provider "aws" {', '  alias  = "eu_west_1"', '  region = "eu-west-1"', "}"].join("\n")
    );
    expect(files["provider.tf"]).toContain('  alias  = "us_west_2"');
    expect(files["imports.tf"]).toContain(
      ["import {", "  to       = aws_instance.eu", '  id       = "i-0aaa"', "  provider = aws.eu_west_1", "}"].join("\n")
    );
    // Global: the default provider, no provider argument.
    expect(files["imports.tf"]).toContain(["import {", "  to = aws_iam_role.deployer", '  id = "deployer"', "}"].join("\n"));
  });
});

describe("cloudflare adopter", () => {
  const ACC = "023e105f4ecef8ad9ca31a8372d0c353";
  const cf = (type: string, name: string, metadata: Record<string, unknown>, externalId = name): ResourceInventoryItem => ({
    provider: "cloudflare",
    type,
    externalId,
    name,
    metadata,
  });

  it("maps records and account-scoped resources to v5 import ids", () => {
    const plan = planAdoption("cloudflare", [
      cf("cloudflare:dns_record", "www.example.com", { zoneId: ACC, recordType: "CNAME" }, "372e67954025e0ba6aaa6d586b9e0b59"),
      cf("cloudflare:worker", "api", { accountId: ACC }),
      cf("cloudflare:pages_project", "site", { accountId: ACC }),
      cf("cloudflare:r2_bucket", "assets", { accountId: ACC, jurisdiction: "eu" }),
      cf("cloudflare:r2_bucket", "logs", { accountId: ACC }),
    ]);
    expect(plan.imports.map((i) => [i.to, i.id])).toEqual([
      ["cloudflare_dns_record.cname_www_example_com", `${ACC}/372e67954025e0ba6aaa6d586b9e0b59`],
      ["cloudflare_workers_script.api", `${ACC}/api`],
      ["cloudflare_pages_project.site", `${ACC}/site`],
      ["cloudflare_r2_bucket.assets", `${ACC}/assets/eu`],
      ["cloudflare_r2_bucket.logs", `${ACC}/logs/default`],
    ]);
  });

  it("skips account-scoped items assessed before the account id was stored", () => {
    const plan = planAdoption("cloudflare", [cf("cloudflare:worker", "api", { modifiedOn: null }), cf("cloudflare:dns_record", "a.example.com", {})]);
    expect(plan.imports).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      "assessed before infralift recorded the Cloudflare account id this import needs; run the assessment again",
      "the DNS record has no zone id recorded",
    ]);
  });
});

describe("provider blocks", () => {
  it("gives azurerm its features block", () => {
    const plan = planAdoption("azure", [
      { provider: "azure", type: "azure:storage_account", externalId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acme", name: "acme" },
    ]);
    expect(render("azure", plan)["provider.tf"]).toContain('provider "azurerm" {\n  features {}\n}\n');
  });

  it("gives google the assessed project, and omits one that is not a project id", () => {
    const bucket: ResourceInventoryItem = { provider: "gcp", type: "gcp:gcs_bucket", externalId: "assets", name: "assets" };
    const project = (id: string): ResourceInventoryItem => ({ provider: "gcp", type: "gcp:project", externalId: id, name: id });
    const good = planAdoption("gcp", [project("acme-prod-123"), bucket]);
    expect(render("gcp", good)["provider.tf"]).toContain('provider "google" {\n  project = "acme-prod-123"\n}\n');
    expect(good.skipped).toEqual([{ type: "gcp:project", name: "acme-prod-123", reason: "no Terraform import mapping for this kind yet" }]);
    const bad = planAdoption("gcp", [project('x" }'), bucket]);
    expect(render("gcp", bad)["provider.tf"]).toContain('provider "google" {}');
  });

  it("leaves providers without settings empty, and falls back to codegen's table", () => {
    expect(adopterFor("heroku").map({ provider: "heroku", type: "heroku:app", externalId: "u-1", name: "web" })).toEqual({
      to: "heroku_app.web",
      id: "u-1",
    });
    const plan = planAdoption("cloudflare", [{ provider: "cloudflare", type: "cloudflare:zone", externalId: "z", name: "acme.dev" }]);
    expect(render("cloudflare", plan)["provider.tf"]).toContain('provider "cloudflare" {}');
  });
});

function render(provider: Provider, plan: ReturnType<typeof planAdoption>): Record<string, string> {
  const { files } = renderAdoption({ provider, plan, backend: { kind: "s3", bucket: "acme-state", key: "k", region: "us-east-1" }, path: "", label: "" });
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}
