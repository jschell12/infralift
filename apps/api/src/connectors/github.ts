import type { Connector, ConnectorAssessment } from "./types.js";

// GitHub is a destination connector (Terraform code generation commits into a
// customer repo), not an assessment source — assess() reports nothing.

const API = "https://api.github.com";

export const githubConnector: Connector = {
  provider: "github",

  async verify(token) {
    const res = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    return res.ok;
  },

  async assess(): Promise<ConnectorAssessment> {
    return {
      inventory: [],
      findings: [],
      estimatedMonthlyCostCents: null,
      estimatedMonthlySavingsCents: null,
    };
  },
};
