import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The version sweep and the fleet view against a stubbed Prisma and a stubbed
// fetch, through the real GitHub client, so GitHub's bodies are parsed as in
// production. The tree listing is GitHub's GET /git/trees/{ref}?recursive=1
// cut to the fields read; file contents come back raw, as the client asks for
// (Accept: application/vnd.github.raw+json). The lock file is a real one
// (lib/tf/__fixtures__, see versions.test.ts there).

process.env.TOKEN_ENCRYPTION_KEY ??= "a".repeat(64);

const projectFindMany = vi.fn();
const projectFindFirst = vi.fn();
const projectUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const connFindFirst = vi.fn();
const connUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const stackVersionFindMany = vi.fn(async (_args: unknown): Promise<unknown[]> => []);

vi.mock("../lib/db.js", () => ({
  prisma: {
    tfProject: { findMany: projectFindMany, findFirst: projectFindFirst, updateMany: projectUpdateMany },
    providerConnection: { findFirst: connFindFirst, updateMany: connUpdateMany },
    stackVersion: { findMany: stackVersionFindMany },
  },
}));

const { encryptToken } = await import("../lib/crypto.js");
const { resetRateLimits } = await import("../lib/rate-limit.js");
const { getStack } = await import("../lib/stacks/index.js");
const svc = await import("./versions.js");

const LOCK = readFileSync(join(import.meta.dirname, "../lib/tf/__fixtures__/lock-terraform-three-providers.hcl"), "utf8");
const MAIN_TF = `terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.41"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
`;

const NOW = new Date("2026-11-16T12:00:00Z");
const PROJECT = {
  id: "proj_1",
  orgId: "org_mine",
  source: "imported",
  stackSlug: null,
  destRepo: "acme/web",
  destBranch: "main",
  destPath: "infra",
  gitHost: "github",
  gitConnectionId: "conn_1",
  versionCheckedAt: null as Date | null,
  stackVersion: null,
};
const CONN = { id: "conn_1", orgId: "org_mine", provider: "github", status: "valid", encryptedToken: encryptToken("tok") };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** GitHub holding `files` on main. */
function github(files: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/repos/acme/web/git/trees/main") {
      return json({
        sha: "9fb037999f264ba9a7fc6274d15fa3ae2ab98312",
        tree: Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob", sha: "e69de29", size: files[path]!.length })),
        truncated: false,
      });
    }
    const m = /^\/repos\/acme\/web\/contents\/(.+)$/.exec(u.pathname);
    if (m && u.searchParams.get("ref") === "main") {
      const path = m[1]!.split("/").map(decodeURIComponent).join("/");
      if (path in files) return new Response(files[path]);
    }
    return json({ message: "Not Found" }, 404);
  });
}

const readPaths = (f: ReturnType<typeof github>) =>
  f.mock.calls.map((c) => new URL(String(c[0])).pathname).filter((p) => p.includes("/contents/")).map((p) => p.split("/contents/")[1]).sort();

const writes = () => projectUpdateMany.mock.calls.map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  projectUpdateMany.mockResolvedValue({ count: 1 });
  connFindFirst.mockResolvedValue({ ...CONN });
  stackVersionFindMany.mockResolvedValue([]);
  await resetRateLimits();
});

describe("checkProjectVersions", () => {
  it("claims, reads only the root module's .tf and lock file, and stores the facts", async () => {
    const fetchMock = github({
      "infra/main.tf": MAIN_TF,
      "infra/.terraform.lock.hcl": LOCK,
      "infra/modules/db/main.tf": "this is never read",
      "README.md": "# web",
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await svc.checkProjectVersions({ ...PROJECT }, NOW)).toBe(true);

    expect(readPaths(fetchMock)).toEqual(["infra/.terraform.lock.hcl", "infra/main.tf"]);
    const [claim, write] = writes();
    expect(claim).toEqual({ where: { id: "proj_1", orgId: "org_mine", versionCheckedAt: null }, data: { versionCheckedAt: NOW } });
    expect(write!.where).toEqual({ id: "proj_1", orgId: "org_mine" });
    expect(write!.data.versionFacts).toMatchObject({
      ok: true,
      ref: "main",
      path: "infra",
      lockFound: true,
      requiredVersion: ">= 1.5",
      locked: [
        { source: "cloudflare/cloudflare", version: "5.22.0" },
        { source: "hashicorp/random", version: "3.9.0" },
        { source: "hetznercloud/hcloud", version: "1.66.0" },
      ],
      notes: [],
    });
    expect(connFindFirst.mock.calls[0]![0].where).toEqual({ orgId: "org_mine", provider: "github", id: "conn_1" });
  });

  it("stores lockFound false, and does not ask for the lock file, when there is none", async () => {
    const fetchMock = github({ "infra/main.tf": MAIN_TF });
    vi.stubGlobal("fetch", fetchMock);
    await svc.checkProjectVersions({ ...PROJECT }, NOW);
    expect(readPaths(fetchMock)).toEqual(["infra/main.tf"]);
    expect(writes()[1]!.data.versionFacts).toMatchObject({ ok: true, lockFound: false, locked: [] });
  });

  it("does nothing when another read claimed the project first", async () => {
    const fetchMock = github({});
    vi.stubGlobal("fetch", fetchMock);
    projectUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.checkProjectVersions({ ...PROJECT }, NOW)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it("backs off on a rate-limited 403 without marking the connection or overwriting the last facts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" })));
    expect(await svc.checkProjectVersions({ ...PROJECT }, NOW)).toBe(true);
    expect(writes()).toHaveLength(1); // the claim only
    expect(connUpdateMany).not.toHaveBeenCalled();
  });

  it("marks the connection invalid on a 401 and records the problem in words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Bad credentials" }, 401)));
    await svc.checkProjectVersions({ ...PROJECT }, NOW);
    expect(connUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "conn_1" }, data: expect.objectContaining({ status: "invalid" }) }));
    const facts = writes()[1]!.data.versionFacts as { ok: boolean; problem: string };
    expect(facts.ok).toBe(false);
    expect(facts.problem).toBe("GitHub refused the connection; reconnect it under Connections to read versions.");
    expect(facts.problem).not.toContain("Bad credentials");
  });

  it("names a missing branch without the host's body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Not Found" }, 404)));
    await svc.checkProjectVersions({ ...PROJECT }, NOW);
    expect(writes()[1]!.data.versionFacts).toMatchObject({
      ok: false,
      problem: "acme/web@main was not found. Check the repository and branch in the project's settings.",
    });
  });

  it("records a problem, and reads nothing, without a usable connection", async () => {
    const fetchMock = github({});
    vi.stubGlobal("fetch", fetchMock);
    connFindFirst.mockResolvedValueOnce({ ...CONN, status: "invalid" });
    await svc.checkProjectVersions({ ...PROJECT }, NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes()[1]!.data.versionFacts).toMatchObject({ ok: false, problem: expect.stringContaining("invalid") });
  });

  it("reads a catalog stack project in the stack's root module directory", async () => {
    const fetchMock = github({ "infra/network-baseline/main.tf": MAIN_TF, "infra/network-baseline/modules/vpc/main.tf": "x" });
    vi.stubGlobal("fetch", fetchMock);
    await svc.checkProjectVersions({ ...PROJECT, source: "stack", stackSlug: "network-baseline", destPath: "" }, NOW);
    expect(readPaths(fetchMock)).toEqual(["infra/network-baseline/main.tf"]);
  });
});

describe("stackRootDir", () => {
  it.each([
    ["network-baseline", "infra/network-baseline"],
    ["postgres-with-backups", "infra/postgres-with-backups"],
    ["static-site-cdn", "infra/static-site-cdn"],
    ["app-foundry-hetzner", "deploy/infra"],
  ])("finds %s's root module at %s", (slug, dir) => {
    expect(svc.stackRootDir(getStack(slug))).toBe(dir);
  });

  it("is null for a manifest with no root main.tf", () => {
    expect(svc.stackRootDir({ rendered: [{ path: "infra/x/modules/a/main.tf", template: "" }] })).toBeNull();
  });
});

describe("sweepVersions", () => {
  it("selects readable projects not read in a day, never-read first, bounded", async () => {
    projectFindMany.mockResolvedValueOnce([]);
    await svc.sweepVersions(NOW);
    const args = projectFindMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      destRepo: { not: "" },
      createRepo: false,
      OR: [{ versionCheckedAt: null }, { versionCheckedAt: { lt: new Date(NOW.getTime() - svc.VERSION_INTERVAL_MS) } }],
    });
    expect(args.orderBy).toEqual({ versionCheckedAt: { sort: "asc", nulls: "first" } });
    expect(args.take).toBe(svc.VERSION_BATCH);
  });

  it("keeps going past one project's failure and counts the rest", async () => {
    vi.stubGlobal("fetch", github({ "infra/main.tf": MAIN_TF }));
    projectFindMany.mockResolvedValueOnce([{ ...PROJECT }, { ...PROJECT, id: "proj_2" }]);
    connFindFirst.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ ...CONN });
    expect(await svc.sweepVersions(NOW)).toBe(1);
  });
});

// -- the fleet view ------------------------------------------------------------

const FACTS = {
  ok: true,
  ref: "main",
  path: "infra",
  lockFound: true,
  locked: [
    { source: "cloudflare/cloudflare", registry: "registry.terraform.io", version: "5.22.0" },
    { source: "hetznercloud/hcloud", registry: "registry.terraform.io", version: "1.70.2" },
  ],
  constraints: [],
  requiredVersion: ">= 1.6",
  notes: [],
};
const row = (o: Record<string, unknown> = {}) => ({
  id: "proj_1",
  name: "web",
  source: "imported",
  orgId: "org_mine",
  destRepo: "acme/web",
  stackSlug: null,
  stackRelease: null,
  stackVersionId: null,
  versionFacts: FACTS,
  versionCheckedAt: NOW,
  stackVersion: null,
  ...o,
});

describe("listProjectVersions", () => {
  it("scopes the read to the org, pages by name, and classifies against the baseline", async () => {
    projectFindMany.mockResolvedValueOnce([row(), row({ id: "proj_2", name: "zz" })]);
    const page = await svc.listProjectVersions("org_mine", { limit: 1 });
    const args = projectFindMany.mock.calls[0]![0];
    expect(args.where).toEqual({ orgId: "org_mine" });
    expect(args.take).toBe(2);
    expect(page.nextCursor).toBe("proj_1");
    expect(page.projects).toHaveLength(1);
    const p = page.projects[0]!;
    expect(p.status).toBe("behind-minor");
    expect(p.terraform).toMatchObject({ have: ">= 1.6", want: ">= 1.5", status: "current" });
    expect(p.providers.map((i) => [i.name, i.status])).toEqual([
      ["cloudflare/cloudflare", "behind-minor"],
      ["hetznercloud/hcloud", "current"],
    ]);
    expect(p.stack).toBeNull();
  });

  it("passes the cursor through and has no next page at the end", async () => {
    projectFindMany.mockResolvedValueOnce([row()]);
    const page = await svc.listProjectVersions("org_mine", { limit: 5, cursor: "proj_0" });
    expect(projectFindMany.mock.calls[0]![0]).toMatchObject({ cursor: { id: "proj_0" }, skip: 1 });
    expect(page.nextCursor).toBeNull();
  });

  it("compares a catalog stack project's release, and leaves a pre-release project unknown", async () => {
    const current = getStack("network-baseline")!.version!;
    projectFindMany.mockResolvedValueOnce([
      row({ source: "stack", stackSlug: "network-baseline", stackRelease: current }),
      row({ id: "proj_2", source: "stack", stackSlug: "network-baseline", stackRelease: null }),
    ]);
    const [a, b] = (await svc.listProjectVersions("org_mine", { limit: 10 })).projects;
    expect(a!.stack).toMatchObject({ have: current, want: current, status: "current" });
    expect(b!.stack).toMatchObject({ have: null, status: "unknown", note: "Created before stack releases were recorded." });
  });

  it("is unknown, never current, for a project not read yet, and shows a failed read's problem", async () => {
    projectFindMany.mockResolvedValueOnce([
      row({ versionFacts: null, versionCheckedAt: null }),
      row({ id: "proj_2", versionFacts: { ok: false, ref: "main", path: "infra", problem: "No GitHub connection to read the repository with." } }),
    ]);
    const [a, b] = (await svc.listProjectVersions("org_mine", { limit: 10 })).projects;
    expect(a).toMatchObject({ status: "unknown", terraform: null, providers: [], checkedAt: null, problem: null });
    expect(b).toMatchObject({ status: "unknown", problem: "No GitHub connection to read the repository with." });
  });

  it("compares a team stack only with the newest version of the org's own source", async () => {
    const own = { id: "sv_1", manifest: { version: "1.0.0" }, stackSourceId: "src_1", source: { orgId: "org_mine" } };
    const foreign = { id: "sv_9", manifest: { version: "1.0.0" }, stackSourceId: "src_9", source: { orgId: "org_other" } };
    projectFindMany.mockResolvedValueOnce([
      row({ source: "stack", stackVersionId: "sv_1", stackVersion: own }),
      row({ id: "proj_2", source: "stack", stackVersionId: "sv_9", stackVersion: foreign }),
    ]);
    stackVersionFindMany.mockResolvedValueOnce([{ id: "sv_2", stackSourceId: "src_1", manifest: { version: "2.0.0" } }]);
    const [a, b] = (await svc.listProjectVersions("org_mine", { limit: 10 })).projects;
    expect(stackVersionFindMany.mock.calls[0]![0]).toMatchObject({
      where: { stackSourceId: { in: ["src_1"] }, valid: true, source: { orgId: "org_mine" } },
      distinct: ["stackSourceId"],
    });
    expect(a!.stack).toMatchObject({ have: "1.0.0", want: "2.0.0", status: "behind-major" });
    expect(b!.stack).toMatchObject({ status: "unknown", note: "Not compared: the stack belongs to another organization." });
  });
});

describe("getProjectVersions and checkProjectVersionsNow", () => {
  it("404s another org's project", async () => {
    projectFindFirst.mockResolvedValueOnce(null);
    await expect(svc.getProjectVersions("org_mine", "proj_theirs")).rejects.toMatchObject({ status: 404 });
    expect(projectFindFirst.mock.calls[0]![0].where).toEqual({ id: "proj_theirs", orgId: "org_mine" });
  });

  it("404s another org's project before spending the org's rate limit", async () => {
    projectFindFirst.mockResolvedValue(null);
    for (let i = 0; i < 12; i++) {
      await expect(svc.checkProjectVersionsNow("org_mine", "proj_theirs", NOW)).rejects.toMatchObject({ status: 404 });
    }
    expect(projectFindFirst.mock.calls[0]![0].where).toMatchObject({ id: "proj_theirs", orgId: "org_mine" });
  });

  it("reads now, and refuses with 429 past ten checks in ten minutes for one org", async () => {
    vi.stubGlobal("fetch", github({ "infra/main.tf": MAIN_TF, "infra/.terraform.lock.hcl": LOCK }));
    projectFindFirst.mockImplementation(async (args: { select: Record<string, unknown> }) =>
      "versionFacts" in args.select ? row() : { ...PROJECT }
    );
    for (let i = 0; i < 10; i++) {
      const v = await svc.checkProjectVersionsNow("org_mine", "proj_1", NOW);
      expect(v.projectId).toBe("proj_1");
    }
    await expect(svc.checkProjectVersionsNow("org_mine", "proj_1", NOW)).rejects.toMatchObject({ status: 429 });
    // Another org has its own allowance.
    await expect(svc.checkProjectVersionsNow("org_other", "proj_1", NOW)).resolves.toMatchObject({ projectId: "proj_1" });
  });
});
