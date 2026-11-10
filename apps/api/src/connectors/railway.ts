import type { ResourceInventoryItem } from "@infralift/shared";
import type { Connector, ConnectorAssessment } from "./types.js";

const API = "https://backboard.railway.com/graphql/v2";

async function gql(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<any> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Railway GraphQL -> ${res.status}`);
  }
  const body: any = await res.json();
  if (body.errors?.length) {
    throw new Error(
      `Railway GraphQL: ${body.errors[0].message ?? JSON.stringify(body.errors)}`
    );
  }
  return body.data;
}

export const railwayConnector: Connector = {
  provider: "railway",

  async verify(token) {
    try {
      const data = await gql(token, `{ me { id } }`);
      return !!data?.me?.id;
    } catch {
      return false;
    }
  },

  async assess(token): Promise<ConnectorAssessment> {
    const inventory: ResourceInventoryItem[] = [];
    const findings: ConnectorAssessment["findings"] = [];
    let totalCostCents = 0;

    // Fetch projects with services and environments
    const data = await gql(
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
              plugins {
                edges {
                  node {
                    id
                    name
                    friendlyName
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

      // Plugins (databases: Postgres, Redis, MongoDB, MySQL)
      for (const { node: plugin } of project.plugins?.edges ?? []) {
        const pluginName = String(
          plugin.friendlyName ?? plugin.name ?? ""
        ).toLowerCase();
        inventory.push({
          provider: "railway",
          type: "railway:plugin",
          externalId: plugin.id,
          name: `${project.name}/${plugin.friendlyName ?? plugin.name}`,
          metadata: { pluginType: plugin.name ?? null },
        });

        if (pluginName.includes("postgres")) {
          findings.push({
            category: "recommendation",
            severity: "info",
            title: `${project.name}: Railway Postgres plugin`,
            detail:
              "Railway Postgres migrates via pg_dump/pg_restore to Neon, a VPS Postgres, or any managed provider. Connection strings move to Terraform-managed env vars.",
            resourceRef: plugin.id,
          });
        }
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

    // Estimate cost from usage (Railway uses per-second billing)
    try {
      const usageData = await gql(
        token,
        `{
          me {
            id
            projects {
              edges {
                node {
                  id
                  name
                  subscription {
                    plan
                  }
                }
              }
            }
          }
        }`
      );
      const userProjects = usageData?.me?.projects?.edges ?? [];
      for (const { node: p } of userProjects) {
        const plan = String(
          p.subscription?.plan ?? ""
        ).toLowerCase();
        if (plan === "pro") totalCostCents += 2000; // $20/mo base
        else if (plan === "hobby") totalCostCents += 500; // $5/mo base
      }
    } catch {
      // Usage query may fail with limited scopes; skip.
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
      estimatedMonthlyCostCents: totalCostCents || null,
    };
  },
};
