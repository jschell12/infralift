import type { Connector, ConnectorAssessment } from "./types.js";

// GitHub is a destination connector (Terraform code generation commits into a
// customer repo), not an assessment source — assess() reports nothing.

const API = "https://api.github.com";

export const githubConnector: Connector = {
  provider: "github",

  async verify(token) {
    return (await githubConnector.check!(token)).valid;
  },

  // A personal access token with an expiry gets it back on every response in
  // github-authentication-token-expiration; a token without one gets no header.
  async check(token) {
    const res = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const expiresAt = parseGithubExpiration(res.headers.get("github-authentication-token-expiration"));
    if (res.ok) return { valid: true, reason: null, expiresAt };
    const body: any = await res.json().catch(() => null);
    const why = typeof body?.message === "string" ? `: ${body.message.slice(0, 120)}` : "";
    return { valid: false, reason: `GitHub answered ${res.status}${why}`, expiresAt };
  },

  async assess(): Promise<ConnectorAssessment> {
    return {
      inventory: [],
      findings: [],
      estimatedMonthlyCostCents: null,
    };
  },
};

/** "2026-12-01 00:00:00 UTC" (or a numeric offset, "-0700") to a Date; null
 *  for an absent or unreadable header. */
export function parseGithubExpiration(header: string | null): Date | null {
  const m = header?.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/);
  if (!m) return null;
  const zone = m[3] === "UTC" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
