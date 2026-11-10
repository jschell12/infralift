import { randomBytes } from "node:crypto";
import type { AwsSetup } from "@infralift/shared";
import { prisma } from "../lib/db.js";
import { NotFound, Unprocessable } from "../lib/errors.js";
import { AWS_NOT_ENABLED, infraliftAwsAccountId, parseAwsPayload } from "../connectors/aws.js";

// ---------------------------------------------------------------------------
// The org's AWS external ID, and the policies a customer pastes into IAM.
//
// The external ID is what stops one org from pointing infralift at another
// org's role: the role's trust policy requires it, and the stored connection
// always carries the caller's org's ID, whatever the pasted JSON said.
// ---------------------------------------------------------------------------

/** The actions assess() calls, and nothing else. */
export const AWS_READ_ACTIONS = ["tag:GetResources", "ce:GetCostAndUsage"];

/** 32 url-safe characters from 24 random bytes. */
export function mintExternalId(): string {
  return randomBytes(24).toString("base64url");
}

/** The org's external ID, minted on first call. Two concurrent first calls
 *  both read back whichever write won, because only a null is overwritten. */
export async function orgAwsExternalId(orgId: string): Promise<string> {
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { awsExternalId: true } });
  if (!org) throw new NotFound("Not found");
  if (org.awsExternalId) return org.awsExternalId;
  await prisma.org.updateMany({ where: { id: orgId, awsExternalId: null }, data: { awsExternalId: mintExternalId() } });
  const minted = await prisma.org.findUnique({ where: { id: orgId }, select: { awsExternalId: true } });
  if (!minted?.awsExternalId) throw new NotFound("Not found");
  return minted.awsExternalId;
}

export function trustPolicy(accountId: string, externalId: string): string {
  const statement = {
    Effect: "Allow",
    Principal: { AWS: `arn:aws:iam::${accountId}:root` },
    Action: "sts:AssumeRole",
    Condition: { StringEquals: { "sts:ExternalId": externalId } },
  };
  return JSON.stringify({ Version: "2012-10-17", Statement: [statement] }, null, 2);
}

export function permissionsPolicy(): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: AWS_READ_ACTIONS, Resource: "*" }] }, null, 2);
}

export async function awsSetup(orgId: string): Promise<AwsSetup> {
  const accountId = infraliftAwsAccountId();
  if (!accountId) return { enabled: false };
  const externalId = await orgAwsExternalId(orgId);
  return { enabled: true, accountId, externalId, trustPolicy: trustPolicy(accountId, externalId), permissionsPolicy: permissionsPolicy() };
}

/** The secret to store or use for a connection. For AWS: the role ARN and
 *  regions from what was pasted, with the org's own external ID. Refused
 *  when AWS is off on this server. Other providers pass through. */
export async function connectionSecret(orgId: string, provider: string, secret: string): Promise<string> {
  if (provider !== "aws") return secret;
  if (!infraliftAwsAccountId()) throw new Unprocessable(AWS_NOT_ENABLED);
  const payload = parseAwsPayload(secret);
  // A malformed ARN goes through unchanged; verify reports why it failed.
  if (!payload) return secret;
  return JSON.stringify({
    roleArn: payload.roleArn,
    externalId: await orgAwsExternalId(orgId),
    ...(payload.regions?.length ? { regions: payload.regions } : {}),
  });
}
