import type { Connector, ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";
import { DEFAULT_ENDPOINTS, type Endpoints } from "../lib/endpoints.js";

// GitLab is a destination, like GitHub: infralift creates the project's
// repository there and opens merge requests. It is not an assessment source,
// so assess() reports nothing.

/** The GitLab connector, calling endpoints.gitlabApi (lib/endpoints.ts). */
export function createGitlabConnector(endpoints: Pick<Endpoints, "gitlabApi"> = DEFAULT_ENDPOINTS): Connector {
  const api = endpoints.gitlabApi;
  const connector: Connector = {
    provider: "gitlab",

    async verify(token) {
      const res = await httpFetch(`${api}/user`, {
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
  return connector;
}

export const gitlabConnector: Connector = createGitlabConnector();
