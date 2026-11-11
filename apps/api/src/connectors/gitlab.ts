import type { Connector, ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";

// GitLab is a destination, like GitHub: infralift creates the project's
// repository there and opens merge requests. It is not an assessment source,
// so assess() reports nothing.

export const GITLAB_API = "https://gitlab.com/api/v4";

export const gitlabConnector: Connector = {
  provider: "gitlab",

  async verify(token) {
    const res = await httpFetch(`${GITLAB_API}/user`, {
      headers: { "PRIVATE-TOKEN": token },
    });
    return res.ok;
  },

  async assess(): Promise<ConnectorAssessment> {
    return {
      inventory: [],
      findings: [],
      estimatedMonthlyCostCents: null,
    };
  },
};
