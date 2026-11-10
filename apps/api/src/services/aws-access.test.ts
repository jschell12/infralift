import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The org's external ID against an in-memory Org table: minted once, stable,
// different per org, and the one written into a stored AWS connection no
// matter what external ID was pasted.

const orgs = new Map<string, { awsExternalId: string | null }>();

vi.mock("../lib/db.js", () => ({
  prisma: {
    org: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = orgs.get(where.id);
        return row ? { awsExternalId: row.awsExternalId } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; awsExternalId: null }; data: { awsExternalId: string } }) => {
        const row = orgs.get(where.id);
        if (!row || row.awsExternalId !== where.awsExternalId) return { count: 0 };
        row.awsExternalId = data.awsExternalId;
        return { count: 1 };
      }),
    },
  },
}));

const { awsSetup, connectionSecret, mintExternalId, orgAwsExternalId } = await import("./aws-access.js");
const { AppError } = await import("../lib/errors.js");

const ARN = "arn:aws:iam::123456789012:role/infralift-readonly";

beforeEach(() => {
  orgs.clear();
  orgs.set("org-a", { awsExternalId: null });
  orgs.set("org-b", { awsExternalId: null });
  process.env.INFRALIFT_AWS_ACCOUNT_ID = "999999999999";
});
afterEach(() => {
  delete process.env.INFRALIFT_AWS_ACCOUNT_ID;
});

describe("org AWS external ID", () => {
  it("is 32 random url-safe characters, minted once and then stable", async () => {
    expect(mintExternalId()).not.toBe(mintExternalId());
    const first = await orgAwsExternalId("org-a");
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await orgAwsExternalId("org-a")).toBe(first);
    expect(orgs.get("org-a")!.awsExternalId).toBe(first);
  });

  it("differs between orgs, and each org's setup shows only its own", async () => {
    const a = await awsSetup("org-a");
    const b = await awsSetup("org-b");
    expect(a.externalId).not.toBe(b.externalId);
    expect(a.trustPolicy).toContain(a.externalId);
    expect(a.trustPolicy).not.toContain(b.externalId);
    expect(JSON.parse(a.trustPolicy!).Statement[0]).toEqual({
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::999999999999:root" },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": a.externalId } },
    });
    expect(JSON.parse(a.permissionsPolicy!).Statement[0].Action).toEqual(["tag:GetResources", "ce:GetCostAndUsage"]);
  });

  it("is 404 for an org that does not exist", async () => {
    await expect(orgAwsExternalId("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("connectionSecret", () => {
  it("replaces a pasted external ID with the caller's org's own", async () => {
    const a = await orgAwsExternalId("org-a");
    const secret = await connectionSecret("org-b", "aws", JSON.stringify({ roleArn: ARN, externalId: a, regions: ["ap-southeast-2"] }));
    const stored = JSON.parse(secret);
    expect(stored.externalId).toBe(orgs.get("org-b")!.awsExternalId);
    expect(stored.externalId).not.toBe(a);
    expect(stored).toMatchObject({ roleArn: ARN, regions: ["ap-southeast-2"] });
  });

  it("accepts a bare role ARN, and passes other providers through untouched", async () => {
    expect(await connectionSecret("org-a", "vercel", "tok")).toBe("tok");
    expect(orgs.get("org-a")!.awsExternalId).toBeNull();
    const id = JSON.parse(await connectionSecret("org-a", "aws", ARN)).externalId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(id).toBe(orgs.get("org-a")!.awsExternalId);
  });

  it("is 422 'not enabled' when the server has no AWS account configured, and mints nothing", async () => {
    delete process.env.INFRALIFT_AWS_ACCOUNT_ID;
    const err = await connectionSecret("org-a", "aws", ARN).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(422);
    expect(err.body()).toEqual({ error: "AWS connections are not enabled on this server" });
    expect(await awsSetup("org-a")).toEqual({ enabled: false });
    expect(orgs.get("org-a")!.awsExternalId).toBeNull();
  });
});
