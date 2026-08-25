import type { Connector, ConnectorAssessment } from "./types.js";

// AWS assessment uses an assumed ReadOnlyAccess IAM role (cross-account,
// external-ID protected) rather than a pasted token. The connection "token"
// stores the role ARN + external ID as JSON. Full inventory via the AWS SDK
// (Cost Explorer, Resource Groups Tagging API) lands in a later iteration —
// this connector validates the ARN shape and returns guidance findings so
// the intake and report flow works end to end.

const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/;

interface AwsConnectionPayload {
  roleArn: string;
  externalId?: string;
}

function parsePayload(token: string): AwsConnectionPayload | null {
  try {
    const parsed = JSON.parse(token);
    if (typeof parsed?.roleArn === "string") return parsed;
    return null;
  } catch {
    // Allow a bare role ARN too.
    return ROLE_ARN_RE.test(token) ? { roleArn: token } : null;
  }
}

export const awsConnector: Connector = {
  provider: "aws",

  async verify(token) {
    const payload = parsePayload(token);
    return payload !== null && ROLE_ARN_RE.test(payload.roleArn);
  },

  async assess(token): Promise<ConnectorAssessment> {
    const payload = parsePayload(token);
    if (!payload) {
      throw new Error(
        "AWS connection must be a role ARN or JSON {roleArn, externalId}"
      );
    }
    const accountId = payload.roleArn.split(":")[4];

    return {
      inventory: [
        {
          provider: "aws",
          type: "aws:account",
          externalId: accountId,
          name: `AWS account ${accountId}`,
          metadata: { roleArn: payload.roleArn },
        },
      ],
      findings: [
        {
          category: "inventory",
          severity: "info",
          title: "AWS role connected — full inventory pending",
          detail:
            "The ReadOnlyAccess role is registered. Automated Cost Explorer + resource inventory runs during the assessment engagement; findings will populate this report.",
        },
        {
          category: "recommendation",
          severity: "info",
          title: "Typical AWS savings levers",
          detail:
            "Common wins for small AWS accounts: NAT gateway removal (~$32/mo each), idle load balancers (~$18/mo each), gp2→gp3 volumes (~20%), and rightsizing always-on EC2 to a VPS or Cloudflare Workers.",
        },
      ],
      estimatedMonthlyCostCents: null,
      estimatedMonthlySavingsCents: null,
    };
  },
};
