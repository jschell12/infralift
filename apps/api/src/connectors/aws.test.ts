import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { AWS_NOT_ENABLED, AwsNotEnabledError, DEFAULT_REGIONS, RESOURCE_CAP, createAwsConnector, lastFullMonth, regionsFor } from "./aws.js";
import { ProviderHttpError } from "./types.js";
import { planAdoption } from "../lib/import/adopt.js";

// Hand mocks for the SDK clients. Bodies are __fixtures__/aws-api.json, the AWS
// API reference examples (see its _source note), not captured responses.
const fx = JSON.parse(readFileSync(new URL("./__fixtures__/aws-api.json", import.meta.url), "utf8"));
const ARN = "arn:aws:iam::123456789012:role/infralift-readonly";
const TOKEN = JSON.stringify({ roleArn: ARN, externalId: "org-external-id-0123456789abcdef" });
const NOW = () => new Date("2026-11-10T12:00:00Z");

const fail = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};

function mock(over: { assumeRole?: () => unknown; identity?: () => unknown; resources?: (region: string) => unknown; cost?: () => unknown } = {}) {
  const calls = { sts: [] as unknown[], tagging: [] as { region: string; token?: string }[], ce: [] as unknown[] };
  const clients = {
    sts: () => ({
      send: async (cmd: unknown) => {
        calls.sts.push(cmd);
        if (cmd instanceof AssumeRoleCommand) return (over.assumeRole ?? (() => fx.AssumeRole))();
        if (cmd instanceof GetCallerIdentityCommand) return (over.identity ?? (() => fx.GetCallerIdentity))();
      },
    }),
    tagging: (region: string) => ({
      send: async (cmd: unknown) => {
        calls.tagging.push({ region, token: (cmd as GetResourcesCommand).input.PaginationToken });
        if (over.resources) return over.resources(region);
        return region === "us-east-1" ? fx.GetResources : { ResourceTagMappingList: [] };
      },
    }),
    costExplorer: () => ({
      send: async (cmd: unknown) => {
        calls.ce.push((cmd as { input: unknown }).input);
        return (over.cost ?? (() => fx.GetCostAndUsage))();
      },
    }),
  };
  return { connector: createAwsConnector(clients, NOW), calls };
}

beforeEach(() => {
  process.env.INFRALIFT_AWS_ACCOUNT_ID = "999999999999";
});
afterEach(() => {
  delete process.env.INFRALIFT_AWS_ACCOUNT_ID;
});

describe("aws verify", () => {
  it("assumes the role with the stored external ID, then checks the account", async () => {
    const { connector, calls } = mock();
    expect(await connector.check!(TOKEN)).toEqual({ valid: true, reason: null, expiresAt: null });
    expect((calls.sts[0] as AssumeRoleCommand).input).toMatchObject({ RoleArn: ARN, ExternalId: "org-external-id-0123456789abcdef" });
    expect(calls.sts[1]).toBeInstanceOf(GetCallerIdentityCommand);
  });

  it("is invalid when the assumed identity is in another account", async () => {
    const { connector } = mock({ identity: () => ({ ...fx.GetCallerIdentity, Account: "210987654321" }) });
    const result = await connector.check!(TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("the assumed role belongs to account 210987654321, not 123456789012");
  });

  it("maps AccessDenied to the trust policy / external ID reason", async () => {
    const { connector, calls } = mock({ assumeRole: fail("AccessDenied") });
    const result = await connector.check!(TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/trust policy.*external ID/);
    expect(calls.sts).toHaveLength(1);
  });

  it("is off, and calls nothing, without INFRALIFT_AWS_ACCOUNT_ID", async () => {
    delete process.env.INFRALIFT_AWS_ACCOUNT_ID;
    const { connector, calls } = mock();
    await expect(connector.check!(TOKEN)).rejects.toThrow(AWS_NOT_ENABLED);
    expect(calls.sts).toHaveLength(0);
  });

  it("is off when infralift has no base credentials", async () => {
    const { connector } = mock({ assumeRole: fail("CredentialsProviderError") });
    await expect(connector.check!(TOKEN)).rejects.toBeInstanceOf(AwsNotEnabledError);
  });

  it("rejects a malformed ARN and a connection with no external ID without calling AWS", async () => {
    const { connector, calls } = mock();
    expect((await connector.check!("not-an-arn")).valid).toBe(false);
    expect((await connector.check!(ARN)).reason).toMatch(/no external ID/);
    expect(calls.sts).toHaveLength(0);
  });
});

describe("aws assess", () => {
  it("builds inventory from tagged resources and last month's unblended cost", async () => {
    const { connector, calls } = mock();
    const result = await connector.assess(TOKEN);
    expect(result.inventory.map((i) => i.type)).toEqual(["aws:account", "aws:ec2_instance", "aws:s3_bucket", "aws:lambda_function", "aws:rds_db"]);
    expect(result.inventory[1]).toMatchObject({ name: "web-1", region: "us-east-1", externalId: fx.GetResources.ResourceTagMappingList[0].ResourceARN });
    // The S3 ARN carries no region; the scanned one stands in.
    expect(result.inventory[2]).toMatchObject({ name: "example-assets-bucket", region: "us-east-1" });
    expect(calls.tagging.map((t) => t.region)).toEqual(DEFAULT_REGIONS);
    expect(calls.ce[0]).toEqual({ TimePeriod: { Start: "2026-10-01", End: "2026-11-01" }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"] });
    expect(result.estimatedMonthlyCostCents).toBe(41235);
    expect(result.findings.some((f) => f.title.includes("stopped at"))).toBe(false);
  });

  it("makes no Cost Explorer call when asked for the inventory only", async () => {
    const { connector, calls } = mock();
    const result = await connector.assess(TOKEN, { costs: false });
    expect(calls.ce).toHaveLength(0);
    expect(result.estimatedMonthlyCostCents).toBeNull();
    expect(result.inventory.map((i) => i.type)).toEqual(["aws:account", "aws:ec2_instance", "aws:s3_bucket", "aws:lambda_function", "aws:rds_db"]);
    // The default still prices it.
    await connector.assess(TOKEN);
    expect(calls.ce).toHaveLength(1);
  });

  it("follows pagination and stops at the resource cap, and says so", async () => {
    let n = 0;
    const page = () => ({
      PaginationToken: "next",
      ResourceTagMappingList: Array.from({ length: 100 }, () => ({ ResourceARN: `arn:aws:sqs:us-east-1:123456789012:q-${n++}` })),
    });
    const { connector, calls } = mock({ resources: page });
    const result = await connector.assess(TOKEN);
    expect(result.inventory).toHaveLength(RESOURCE_CAP + 1); // + the account
    expect(calls.tagging.map((t) => t.token)).toEqual([undefined, ...Array(RESOURCE_CAP / 100).fill("next")]);
    expect(new Set(calls.tagging.map((t) => t.region))).toEqual(new Set(["us-east-1"]));
    expect(result.findings.some((f) => f.title === `Inventory stopped at ${RESOURCE_CAP} resources`)).toBe(true);
  });

  it("returns null cost with a note when Cost Explorer is denied", async () => {
    const { connector } = mock({ cost: fail("AccessDeniedException") });
    const result = await connector.assess(TOKEN);
    expect(result.estimatedMonthlyCostCents).toBeNull();
    expect(result.findings.some((f) => f.title === "No cost data: Cost Explorer access denied")).toBe(true);
    expect(result.inventory).toHaveLength(5);
  });

  it("throws a 403 when the role cannot be assumed, so the connection is marked", async () => {
    const err = await mock({ assumeRole: fail("AccessDenied") }).connector.assess(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(403);
  });

  it("skips a region that errors, and notes it", async () => {
    const { connector } = mock({
      resources: (r) => (r === "eu-west-1" ? fail("UnrecognizedClientException")() : r === "us-east-1" ? fx.GetResources : {}),
    });
    const result = await connector.assess(TOKEN);
    expect(result.inventory).toHaveLength(5);
    expect(result.findings.some((f) => f.title === "Could not scan eu-west-1")).toBe(true);
  });

  it("scans the customer's regions, validated, deduplicated and capped", () => {
    expect(regionsFor({ roleArn: ARN, regions: ["ap-southeast-2", "bogus", "ap-southeast-2"] })).toEqual(["ap-southeast-2"]);
    expect(regionsFor({ roleArn: ARN, regions: Array.from({ length: 20 }, (_, i) => `us-east-${i}`) })).toHaveLength(10);
    expect(lastFullMonth(new Date("2027-01-03T00:00:00Z"))).toEqual({ Start: "2026-12-01", End: "2027-01-01" });
  });

  it("produces inventory that adoption maps, on a provider alias per region", async () => {
    const { inventory } = await mock().connector.assess(TOKEN);
    const plan = planAdoption("aws", inventory);
    expect(plan.imports.map((i) => [i.to.split(".")[0], i.id, i.provider])).toEqual([
      ["aws_instance", "i-0abcd1234efgh5678", "aws.us_east_1"],
      ["aws_s3_bucket", "example-assets-bucket", "aws.us_east_1"],
      ["aws_lambda_function", "resize-images", "aws.us_east_1"],
      ["aws_db_instance", "orders-db", "aws.us_east_1"],
    ]);
    expect(plan.skipped).toEqual([{ type: "aws:account", name: expect.any(String), reason: "the account itself is not a Terraform resource" }]);
    expect(plan.settings?.regions).toEqual(["us-east-1"]);
  });
});
