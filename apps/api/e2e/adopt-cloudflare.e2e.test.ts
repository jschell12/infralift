// ---------------------------------------------------------------------------
// Adopt from a Cloudflare account, against Prism serving Cloudflare's own
// OpenAPI description (the operations the connector calls, pinned, with the
// seeded account in specs/cloudflare-seed.ts).
//
// This covers the unmanaged view and the adoption pull request. It does not
// run OpenTofu: Prism answers from examples and keeps no state, so the
// cloudflare provider's reads of a zone or record would not describe what
// the connector listed, and a plan against it would prove nothing.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { api, until } from "./harness/api.js";
import { STACK } from "./harness/env.js";
import { branchFiles, gh, violations } from "./harness/github.js";
import { CF_SEED } from "./specs/cloudflare-seed.js";
import { FAKE_LOGIN } from "./github-fake/server.js";

const REPO = `${FAKE_LOGIN}/cloudflare-infra`;
const db = new PrismaClient({ datasources: { db: { url: STACK.databaseUrl } } });
let githubId: string;
let cloudflareId: string;

beforeAll(async () => {
  await gh("POST", "/user/repos", { name: "cloudflare-infra", auto_init: true, private: true });
  // The AWS file may have connected GitHub already; one connection is enough.
  const existing = (await api<any[]>("GET", "/connections")).body.find((c) => c.provider === "github");
  githubId = existing?.id ?? (await api("POST", "/connections", { provider: "github", label: "e2e github (cloudflare)", token: STACK.githubToken })).body.id;
});
afterAll(() => db.$disconnect());

describe("adopt from a Cloudflare account", () => {
  it("connects Cloudflare: the token verifies against the described /user/tokens/verify", async () => {
    const { status, body } = await api("POST", "/connections", { provider: "cloudflare", label: "e2e cloudflare", token: STACK.cloudflareToken });
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: "valid", lastError: null });
    cloudflareId = body.id;
  });

  it("lists every seeded resource as unmanaged, with the account for the R2 backend", async () => {
    const { status, body } = await api("GET", `/connections/${cloudflareId}/unmanaged?refresh=1`);
    expect(status).toBe(200);
    const rows = new Map(body.resources.map((r: any) => [`${r.type} ${r.providerId}`, r]));
    expect(rows.get(`cloudflare:zone ${CF_SEED.zone.id}`)).toMatchObject({ adoptable: true, terraformType: "cloudflare_zone" });
    expect(rows.get(`cloudflare:dns_record ${CF_SEED.dnsRecord.id}`)).toMatchObject({ adoptable: true, terraformType: "cloudflare_dns_record" });
    expect(rows.get(`cloudflare:r2_bucket ${CF_SEED.r2Bucket.name}`)).toMatchObject({ adoptable: true, terraformType: "cloudflare_r2_bucket" });
    expect(rows.get(`cloudflare:worker ${CF_SEED.worker.id}`)).toMatchObject({ adoptable: true, terraformType: "cloudflare_workers_script" });
    expect(rows.get(`cloudflare:pages_project ${CF_SEED.pagesProject.name}`)).toMatchObject({ adoptable: true, terraformType: "cloudflare_pages_project" });
    expect(body.total).toBe(5);
    expect(body.backendDefaults.cloudflareAccounts).toEqual([{ id: CF_SEED.account.id, name: CF_SEED.account.name }]);
  });

  it("adopts the zone, its record and the bucket into a pull request of import blocks", async () => {
    const { status, body } = await api("POST", `/connections/${cloudflareId}/adopt`, {
      resources: [
        { type: "cloudflare:zone", providerId: CF_SEED.zone.id },
        { type: "cloudflare:dns_record", providerId: CF_SEED.dnsRecord.id },
        { type: "cloudflare:r2_bucket", providerId: CF_SEED.r2Bucket.name },
      ],
      target: {
        kind: "new",
        name: "cloudflare-e2e",
        repo: REPO,
        gitConnectionId: githubId,
        path: "infra/cloudflare",
        backend: { kind: "r2", bucket: "e2e-tofu-state", key: "infra/cloudflare/terraform.tfstate", accountId: CF_SEED.account.id },
      },
    });
    expect(status, JSON.stringify(body)).toBe(202);
    const projectId = body.projectId;
    const pending = await db.managedResource.findMany({ where: { projectId }, select: { status: true } });
    expect(pending.map((r) => r.status)).toEqual(["pending", "pending", "pending"]);

    const check = await until("the adoption pull request", async () => (await api("GET", `/tf/imports/${projectId}/check`)).body, (c) => c.state !== "no-pr");
    expect(check.state).toBe("waiting");
    const [pr] = await gh<any[]>("GET", `/repos/${REPO}/pulls?state=open`);
    const files = await branchFiles(REPO, pr.head.ref);
    const imports = files.get("infra/cloudflare/imports.tf")!;
    expect(imports).toContain(`id = "${CF_SEED.zone.id}"`);
    expect(imports).toContain(`id = "${CF_SEED.zone.id}/${CF_SEED.dnsRecord.id}"`);
    expect(imports).toContain(`id = "${CF_SEED.account.id}/${CF_SEED.r2Bucket.name}/default"`);
    expect(files.get("infra/cloudflare/versions.tf")).toContain(`https://${CF_SEED.account.id}.r2.cloudflarestorage.com`);
    expect(files.get("infra/cloudflare/versions.tf")).toContain('source  = "cloudflare/cloudflare"');
  });

  it("the GitHub fake saw only requests and answers GitHub documents", async () => {
    expect(await violations()).toEqual([]);
  });
});
