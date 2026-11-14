// The DigitalOcean account Prism serves (sources.ts "digitalocean"). Only the
// fields connectors/digitalocean.ts reads, plus what makes a record
// recognizable; extract.ts fills every other required field from the
// response schema and checks the whole example against it.

export const DO_SEED = {
  droplet: { id: 3164444, name: "e2e-web-1" },
  app: { id: "e2e0a0a0-0000-4000-8000-000000000001", name: "e2e-app" },
  database: { id: "e2e0a0a0-0000-4000-8000-000000000002", name: "e2e-pg" },
  domain: { name: "infralift-e2e-do.example" },
  cluster: { id: "e2e0a0a0-0000-4000-8000-000000000003", name: "e2e-k8s" },
} as const;

const page = (total: number) => ({ links: {}, meta: { total } });

export const DO_EXAMPLES: Record<string, unknown> = {
  "/v2/account": { account: { email: "e2e@infralift-e2e-do.example", uuid: "e2e0a0a0-0000-4000-8000-0000000000aa", status: "active" } },
  "/v2/droplets": {
    droplets: [
      {
        id: DO_SEED.droplet.id,
        name: DO_SEED.droplet.name,
        size_slug: "s-1vcpu-1gb",
        region: { slug: "nyc3", name: "New York 3" },
        vcpus: 1,
        memory: 1024,
        disk: 25,
        status: "active",
        image: { slug: "ubuntu-24-04-x64", name: "24.04 (LTS) x64" },
      },
    ],
    ...page(1),
  },
  "/v2/apps": {
    apps: [{ id: DO_SEED.app.id, spec: { name: DO_SEED.app.name }, tier_slug: "basic", region: { slug: "nyc" } }],
    ...page(1),
  },
  "/v2/databases": {
    databases: [
      { id: DO_SEED.database.id, name: DO_SEED.database.name, engine: "pg", version: "16", region: "nyc3", size: "db-s-1vcpu-1gb", num_nodes: 1, status: "online" },
    ],
  },
  "/v2/domains": { domains: [{ name: DO_SEED.domain.name, ttl: 1800 }], ...page(1) },
  "/v2/kubernetes/clusters": {
    kubernetes_clusters: [
      {
        id: DO_SEED.cluster.id,
        name: DO_SEED.cluster.name,
        region: "nyc3",
        version: "1.31.1-do.5",
        node_pools: [{ size: "s-1vcpu-2gb", name: "e2e-pool", count: 1 }],
        status: { state: "running" },
      },
    ],
    ...page(1),
  },
};
