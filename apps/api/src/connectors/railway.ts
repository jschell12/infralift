import type { ResourceInventoryItem } from "@infralift/shared";
import { ProviderHttpError, type Connector, type ConnectorAssessment } from "./types.js";
import { httpFetch } from "../lib/http.js";
import { DEFAULT_ENDPOINTS, type Endpoints } from "../lib/endpoints.js";

/** `api` is the full GraphQL URL, DEFAULT_ENDPOINTS.railwayApi unless
 *  overridden (lib/endpoints.ts). */
async function gql(
  api: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<any> {
  const res = await httpFetch(api, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new ProviderHttpError(`Railway GraphQL -> ${res.status}`, res.status);
  }
  const body: any = await res.json();
  if (body.errors?.length) {
    throw new Error(
      `Railway GraphQL: ${body.errors[0].message ?? JSON.stringify(body.errors)}`
    );
  }
  return body.data;
}

/** The Railway connector, calling endpoints.railwayApi (lib/endpoints.ts). */
export function createRailwayConnector(endpoints: Pick<Endpoints, "railwayApi"> = DEFAULT_ENDPOINTS): Connector {
  const api = endpoints.railwayApi;
  const connector: Connector = {
    provider: "railway",

    async verify(token) {
      try {
        const data = await gql(api, token, `{ me { id } }`);
        return !!data?.me?.id;
      } catch {
        return false;
      }
    },

    async assess(token): Promise<ConnectorAssessment> {
      const inventory: ResourceInventoryItem[] = [];
      const findings: ConnectorAssessment["findings"] = [];

      // Projects with their services and environments. No `plugins`: Railway's
      // schema marks it deprecated ("Plugins have been removed"); databases
      // are services now, so they are listed with the rest.
      const data = await gql(
        api,
        token,
        `{
        projects {
          edges {
            node {
              id
              name
              description
              environments {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
              services {
                edges {
                  node {
                    id
                    name
                    icon
                  }
                }
              }
            }
          }
        }
      }`
      );

      const projects = data?.projects?.edges ?? [];

      for (const { node: project } of projects) {
        inventory.push({
          provider: "railway",
          type: "railway:project",
          externalId: project.id,
          name: project.name,
          metadata: { description: project.description ?? null },
        });

        // Services
        for (const { node: svc } of project.services?.edges ?? []) {
          inventory.push({
            provider: "railway",
            type: "railway:service",
            externalId: svc.id,
            name: `${project.name}/${svc.name}`,
            metadata: { icon: svc.icon ?? null },
          });
        }

        // Environments
        for (const { node: env } of project.environments?.edges ?? []) {
          inventory.push({
            provider: "railway",
            type: "railway:environment",
            externalId: env.id,
            name: `${project.name}/${env.name}`,
          });
        }
      }

      if (projects.length > 0) {
        findings.push({
          category: "cost",
          severity: "medium",
          title: "Railway usage-based billing",
          detail: `Found ${projects.length} project(s). Railway bills per-second for CPU/memory/egress plus a $5-$20/mo platform fee. A VPS or Cloudflare Workers replaces usage billing with fixed costs.`,
        });

        findings.push({
          category: "recommendation",
          severity: "info",
          title: "Railway services port directly to Docker or Workers",
          detail:
            "Railway deploys from Dockerfiles or Nixpacks. Dockerfiles run unchanged on a VPS (Docker Compose + systemd). Nixpack-built Node/Python apps port to Cloudflare Workers or a VPS reverse-proxy setup.",
        });
      }

      return {
        inventory,
        findings,
        // Unknown, never $0. The plan query this used to make selected
        // Project.subscription, which Railway's schema does not have (#153
        // finding 4), so it always failed and the estimate read $0. Usage
        // (estimatedUsage) comes back as resource measurements, not dollars,
        // and turning it into a bill would need Railway's unit prices.
        estimatedMonthlyCostCents: null,
      };
    },
  };
  return connector;
}

export const railwayConnector: Connector = createRailwayConnector();
