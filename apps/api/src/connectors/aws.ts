import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import type { ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment, type VerifyResult } from "./types.js";

// AWS access is a cross-account IAM role in the customer's account, trusted
// to infralift's AWS account (INFRALIFT_AWS_ACCOUNT_ID) on condition of the
// org's external ID. The stored token is JSON {roleArn, externalId, regions?};
// services/aws-access.ts writes externalId from the org row, never from what
// was pasted. infralift's own credentials come from the standard AWS chain;
// without them or the account id, AWS is off (AwsNotEnabledError).

const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]+$/;
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** Tagging is regional; these bound an assessment unless the customer names regions. */
export const DEFAULT_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-central-1"];
export const MAX_REGIONS = 10;
/** Resources kept across all regions before the scan stops. */
export const RESOURCE_CAP = 1000;
export const AWS_NOT_ENABLED = "AWS connections are not enabled on this server";

export class AwsNotEnabledError extends Error {
  constructor() {
    super(AWS_NOT_ENABLED);
  }
}

export function infraliftAwsAccountId(): string | null {
  const id = process.env.INFRALIFT_AWS_ACCOUNT_ID?.trim();
  return id && /^\d{12}$/.test(id) ? id : null;
}

export interface AwsConnectionPayload {
  roleArn: string;
  externalId?: string;
  regions?: string[];
}

/** JSON {roleArn, externalId?, regions?} or a bare role ARN; null otherwise. */
export function parseAwsPayload(token: string): AwsConnectionPayload | null {
  let p: AwsConnectionPayload;
  try {
    const j = JSON.parse(token);
    if (typeof j?.roleArn !== "string") return null;
    p = {
      roleArn: j.roleArn.trim(),
      externalId: typeof j.externalId === "string" ? j.externalId : undefined,
      regions: Array.isArray(j.regions) ? j.regions.filter((r: unknown) => typeof r === "string") : undefined,
    };
  } catch {
    p = { roleArn: token.trim() };
  }
  return ROLE_ARN_RE.test(p.roleArn) ? p : null;
}

export function regionsFor(payload: AwsConnectionPayload): string[] {
  const wanted = [...new Set((payload.regions ?? []).filter((r) => REGION_RE.test(r)))];
  return wanted.length ? wanted.slice(0, MAX_REGIONS) : DEFAULT_REGIONS;
}

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}
type Sender = { send(command: unknown): Promise<any> };

/** Client factories, replaced in tests. */
export interface AwsClients {
  sts(creds?: Credentials): Sender;
  tagging(region: string, creds: Credentials): Sender;
  costExplorer(creds: Credentials): Sender;
}

const sdkClients: AwsClients = {
  sts: (creds) => new STSClient({ region: "us-east-1", ...(creds ? { credentials: creds } : {}) }),
  tagging: (region, creds) => new ResourceGroupsTaggingAPIClient({ region, credentials: creds }),
  // Cost Explorer has one endpoint, in us-east-1.
  costExplorer: (creds) => new CostExplorerClient({ region: "us-east-1", credentials: creds }),
};

const errName = (err: unknown): string => (err as { name?: string })?.name ?? "";
const isAccessDenied = (err: unknown) => /AccessDenied/.test(errName(err));

type Session = { ok: true; creds: Credentials; account: string } | { ok: false; reason: string };

async function openSession(clients: AwsClients, payload: AwsConnectionPayload): Promise<Session> {
  if (!infraliftAwsAccountId()) throw new AwsNotEnabledError();
  if (!payload.externalId) return { ok: false, reason: "this connection has no external ID; re-add it from the Connections page" };
  const expected = ROLE_ARN_RE.exec(payload.roleArn)![1];
  let c;
  try {
    const out = await clients.sts().send(
      new AssumeRoleCommand({
        RoleArn: payload.roleArn,
        RoleSessionName: "infralift-assessment",
        ExternalId: payload.externalId,
        DurationSeconds: 900,
      })
    );
    c = out?.Credentials;
  } catch (err) {
    if (errName(err) === "CredentialsProviderError") throw new AwsNotEnabledError();
    if (!isAccessDenied(err)) throw err;
    return {
      ok: false,
      reason: "AWS refused to let infralift assume this role: check that its trust policy names infralift's account and the external ID shown on the Connections page",
    };
  }
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) return { ok: false, reason: "AWS returned no credentials for this role" };
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  const identity = await clients.sts(creds).send(new GetCallerIdentityCommand({}));
  if (identity?.Account !== expected) {
    return { ok: false, reason: `the assumed role belongs to account ${identity?.Account ?? "unknown"}, not ${expected}` };
  }
  return { ok: true, creds, account: expected };
}

/** "arn:aws:ec2:us-east-1:123:instance/i-abc" becomes an aws:ec2_instance named i-abc (or its Name tag). */
function inventoryItem(m: { ResourceARN?: string; Tags?: { Key?: string; Value?: string }[] }, scanned: string): ResourceInventoryItem | null {
  const arn = m.ResourceARN;
  if (!arn) return null;
  const [, , service = "unknown", region = "", , ...rest] = arn.split(":");
  const resource = rest.join(":");
  const sep = resource.search(/[/:]/);
  const kind = sep === -1 ? ({ s3: "bucket", sns: "topic", sqs: "queue" } as Record<string, string>)[service] ?? "resource" : resource.slice(0, sep);
  const id = sep === -1 ? resource : resource.slice(sep + 1);
  return {
    provider: "aws",
    type: `aws:${service}_${kind.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`,
    externalId: arn,
    name: m.Tags?.find((t) => t.Key === "Name")?.Value || id || arn,
    region: region || scanned,
    metadata: { arn, service, resourceType: kind },
  };
}

/** Last full calendar month, UTC: [first of last month, first of this month). */
export function lastFullMonth(now: Date): { Start: string; End: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  return { Start: start.toISOString().slice(0, 10), End: end.toISOString().slice(0, 10) };
}

export function createAwsConnector(clients: AwsClients = sdkClients, now: () => Date = () => new Date()): Connector {
  async function check(token: string): Promise<VerifyResult> {
    const payload = parseAwsPayload(token);
    if (!payload) return { valid: false, reason: "not an IAM role ARN (arn:aws:iam::<account>:role/<name>)", expiresAt: null };
    const s = await openSession(clients, payload);
    return { valid: s.ok, reason: s.ok ? null : s.reason, expiresAt: null };
  }

  return {
    provider: "aws",
    check,
    verify: async (token) => (await check(token)).valid,

    async assess(token): Promise<ConnectorAssessment> {
      const payload = parseAwsPayload(token);
      if (!payload) throw new Error("AWS connection must be an IAM role ARN or JSON {roleArn, regions?}");
      const session = await openSession(clients, payload);
      // A refused role is the credential failing: 403 marks the connection invalid.
      if (!session.ok) throw new ProviderHttpError(`AWS AssumeRole: ${session.reason}`, 403);
      const { creds, account } = session;

      const findings: ConnectorAssessment["findings"] = [];
      const note = (severity: "info" | "medium", title: string, detail: string, category: "inventory" | "cost" = "inventory") =>
        findings.push({ category, severity, title, detail });
      const inventory: ResourceInventoryItem[] = [
        { provider: "aws", type: "aws:account", externalId: account, name: `AWS account ${account}`, metadata: { roleArn: payload.roleArn } },
      ];
      const seen = new Set<string>();
      const regions = regionsFor(payload);
      const failed: string[] = [];
      let capped = false;

      scan: for (const region of regions) {
        const client = clients.tagging(region, creds);
        let PaginationToken: string | undefined;
        try {
          do {
            const page = await client.send(new GetResourcesCommand({ ResourcesPerPage: 100, PaginationToken }));
            for (const mapping of page?.ResourceTagMappingList ?? []) {
              const item = inventoryItem(mapping, region);
              if (!item || seen.has(item.externalId)) continue;
              if (seen.size >= RESOURCE_CAP) {
                capped = true;
                break scan;
              }
              seen.add(item.externalId);
              inventory.push(item);
            }
            PaginationToken = page?.PaginationToken || undefined;
          } while (PaginationToken);
        } catch (err) {
          if (isAccessDenied(err)) throw new ProviderHttpError(`AWS tag:GetResources in ${region} was denied`, 403);
          failed.push(region);
        }
      }

      note(
        "info",
        `${seen.size} AWS resources found in ${regions.length} region${regions.length === 1 ? "" : "s"}`,
        `Scanned ${regions.join(", ")} with the Resource Groups Tagging API, which lists only resources that carry, or once carried, a tag. Untagged resources do not appear.`
      );
      if (capped) note("medium", `Inventory stopped at ${RESOURCE_CAP} resources`, `More than ${RESOURCE_CAP} tagged resources in the scanned regions; the rest are not in this report.`);
      if (failed.length) note("medium", `Could not scan ${failed.join(", ")}`, "AWS returned an error for these regions (often a region not enabled on the account). Resources there are not in this report.");

      let estimatedMonthlyCostCents: number | null = null;
      try {
        const out = await clients.costExplorer(creds).send(
          new GetCostAndUsageCommand({ TimePeriod: lastFullMonth(now()), Granularity: "MONTHLY", Metrics: ["UnblendedCost"] })
        );
        let total = 0;
        for (const r of out?.ResultsByTime ?? []) total += Number(r?.Total?.UnblendedCost?.Amount ?? 0);
        estimatedMonthlyCostCents = Number.isFinite(total) ? Math.round(total * 100) : null;
      } catch (err) {
        if (!isAccessDenied(err)) throw err;
        note("medium", "No cost data: Cost Explorer access denied", "The role cannot call ce:GetCostAndUsage, so this report has no monthly spend. Add that action to the role's policy and re-run the assessment.", "cost");
      }

      return { inventory, findings, estimatedMonthlyCostCents };
    },
  };
}

export const awsConnector: Connector = createAwsConnector();
