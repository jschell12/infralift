import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVENTORY_TYPE_LABELS, inventoryTypeLabel } from "@infralift/shared";
import { AWS_KINDS } from "../lib/import/adopters/aws.js";
import { inventoryItem } from "./aws.js";

// Every inventory type a connector emits has a human label in
// packages/shared/src/inventory-labels.ts. The types are read from the
// connectors' own source, so a connector that starts emitting a new type fails
// here until the table names it.

const DIR = new URL("./", import.meta.url);

/** `type: "provider:thing"` literals in the connectors (not grant_type). */
function literalTypes(): string[] {
  const out = new Set<string>();
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(new URL(file, DIR), "utf8");
    for (const m of src.matchAll(/(?<![\w])type:\s*"([a-z0-9]+:[a-z0-9_-]+)"/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

/** One ARN per entry in the AWS adopt table, run through the connector's own
 *  ARN-to-type mapping. Untyped resources (S3, SQS, SNS, API Gateway) have
 *  their own ARN shapes. */
function awsTypes(): string[] {
  const sample: Record<string, string> = {
    "s3:": "arn:aws:s3:::bucket",
    "sqs:": "arn:aws:sqs:us-east-1:123456789012:queue",
    "sns:": "arn:aws:sns:us-east-1:123456789012:topic",
    "apigateway:": "arn:aws:apigateway:us-east-1::/restapis/abc123",
  };
  return Object.keys(AWS_KINDS).map((key) => {
    const [service, kind] = key.split(":");
    const arn = sample[key] ?? `arn:aws:${service}:us-east-1:123456789012:${kind}/x`;
    return inventoryItem({ ResourceARN: arn }, "us-east-1")!.type;
  });
}

/** render.ts builds `render:${service.type}`; these are the service types
 *  Render's API returns, plus the connector's own fallback. */
const RENDER_SERVICE_TYPES = ["web_service", "static_site", "private_service", "background_worker", "cron_job", "service"].map(
  (t) => `render:${t}`
);

describe("inventory type labels", () => {
  it("finds the connectors' types at all (an empty scan would pass everything)", () => {
    const types = literalTypes();
    expect(types.length).toBeGreaterThan(40);
    expect(types).toContain("cloudflare:dns_record");
    expect(types).toContain("azure:virtual_machine");
    expect(types).not.toContain("urn:ietf");
  });

  it.each([...literalTypes(), ...awsTypes(), ...RENDER_SERVICE_TYPES])("labels %s", (type) => {
    expect(INVENTORY_TYPE_LABELS[type], `${type} has no entry in INVENTORY_TYPE_LABELS`).toBeTruthy();
  });

  it("maps the AWS table's keys to the types the connector really emits", () => {
    const types = awsTypes();
    expect(types).toContain("aws:ec2_instance");
    expect(types).toContain("aws:s3_bucket");
    expect(types).toContain("aws:apigateway_");
    expect(new Set(types).size).toBe(types.length);
  });

  it.each([
    ["cloudflare:dns_record", "DNS records"],
    ["cloudflare:r2_bucket", "R2 buckets"],
    ["cloudflare:worker", "Workers"],
    ["cloudflare:zone", "Zones"],
    ["cloudflare:load_balancer", "Load balancers"],
    ["aws:ec2_instance", "EC2 instances"],
  ])("names %s as %s", (type, label) => {
    expect(inventoryTypeLabel(type)).toBe(label);
  });

  it.each([
    ["aws:ec2_dedicated_host", "Ec2 dedicated host"],
    ["aws:logs_log-group-x", "Logs log group x"],
    ["newcloud:thing", "Thing"],
    ["noprovider", "Noprovider"],
    ["vercel:usage", "Usage"],
  ])("makes an unknown type %s readable as %s", (type, label) => {
    expect(inventoryTypeLabel(type)).toBe(label);
  });

  it("falls back to the provider, then to the id itself, when nothing after the colon is readable", () => {
    expect(inventoryTypeLabel("aws:")).toBe("Aws");
    expect(inventoryTypeLabel(":")).toBe(":");
    expect(inventoryTypeLabel("")).toBe("");
  });
});
