import { beforeEach, describe, expect, it, vi } from "vitest";

// The drift sweep against a stubbed Prisma and a stubbed fetch, through the
// real GitHub client, so the GitHub bodies are parsed as in production. Their
// shapes are GitHub's REST responses (commits list, check-runs for a ref,
// check-run annotations) cut to the fields read; the annotation messages are
// the ones the workflows write (lib/import/contract.ts, and the stack's
// infra.yml, whose script lib/stacks/ci.test.ts runs over real plan output).

process.env.TOKEN_ENCRYPTION_KEY ??= "a".repeat(64);

const projectFindMany = vi.fn();
const projectUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const workspaceUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const connFindFirst = vi.fn();
const connUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

vi.mock("../lib/db.js", () => ({
  prisma: {
    tfProject: { findMany: projectFindMany, updateMany: projectUpdateMany },
    workspace: { updateMany: workspaceUpdateMany },
    providerConnection: { findFirst: connFindFirst, updateMany: connUpdateMany },
  },
}));

const { encryptToken } = await import("../lib/crypto.js");
const { DRIFT, OUTCOME } = await import("../lib/import/contract.js");
const svc = await import("./drift.js");

const NOW = new Date("2026-11-10T12:00:00Z");
const PROJECT = {
  id: "proj_1",
  source: "imported",
  destPath: "infra/app",
  orgId: "org_mine",
  destRepo: "acme/web",
  destBranch: "main",
  gitConnectionId: "conn_1",
  driftCheckedAt: null as Date | null,
};
const CONN = { id: "conn_1", orgId: "org_mine", provider: "github", status: "valid", encryptedToken: encryptToken("tok") };

const STACK_DRIFT = `${DRIFT.foundPrefix} 0 to add, 1 to change, 1 to destroy. Something changed outside Terraform, or a merged change is not applied yet.`;

const APP = "infra drift: infra-app";

const run = (o: { conclusion: string | null; status?: string; annotations?: number; id?: number }) => ({
  total_count: 1,
  check_runs: [
    {
      id: o.id ?? 991,
      status: o.status ?? "completed",
      conclusion: o.conclusion,
      html_url: `https://github.com/acme/web/runs/${o.id ?? 991}`,
      started_at: "2026-11-10T06:41:12Z",
      completed_at: o.status && o.status !== "completed" ? null : "2026-11-10T06:43:40Z",
      output: { title: null, annotations_count: o.annotations ?? 1 },
    },
  ],
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

type Annotation = { annotation_level: string; message: string };
type Body = { total_count?: number; check_runs: { id: number }[] };

/** GitHub with two commits on main and drift runs on the older one, filtered
 *  by exact check_name as GitHub filters them. */
function githubRuns(byName: Record<string, { body: Body; annotations: Annotation[] }>) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/repos/acme/web/commits") return json([{ sha: "c2" }, { sha: "c1" }]);
    const commit = /^\/repos\/acme\/web\/commits\/(c\d)\/check-runs$/.exec(u.pathname);
    if (commit) {
      const hit = commit[1] === "c1" ? byName[u.searchParams.get("check_name") ?? ""] : undefined;
      return json(hit?.body ?? { total_count: 0, check_runs: [] });
    }
    const ann = /^\/repos\/acme\/web\/check-runs\/(\d+)\/annotations$/.exec(u.pathname);
    if (ann) return json(Object.values(byName).find((r) => r.body.check_runs[0]?.id === Number(ann[1]))?.annotations ?? []);
    return json({ message: "Not Found" }, 404);
  });
}
const github = (body: Body, annotations: Annotation[]) => githubRuns({ [APP]: { body, annotations } });

const projectWrites = () =>
  projectUpdateMany.mock.calls.map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  projectUpdateMany.mockResolvedValue({ count: 1 });
  connFindFirst.mockResolvedValue({ ...CONN });
});

describe("checkProjectDrift", () => {
  it("records drift from the newest run on the branch, on the project and its workspaces", async () => {
    const fetchMock = github(run({ conclusion: "failure" }), [{ annotation_level: "failure", message: STACK_DRIFT }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await svc.checkProjectDrift({ ...PROJECT }, NOW)).toBe(true);
    // Looked past the head commit, which had no run yet.
    expect(fetchMock.mock.calls.some((c) => new URL(String(c[0])).searchParams.get("check_name") === APP)).toBe(true);
    const [claim, write] = projectWrites();
    expect(claim).toEqual({ where: { id: "proj_1", orgId: "org_mine", driftCheckedAt: null }, data: { driftCheckedAt: NOW } });
    expect(write.where).toEqual({ id: "proj_1", orgId: "org_mine" });
    expect(write.data).toMatchObject({
      driftState: "drift",
      driftMessage: STACK_DRIFT,
      driftCheckUrl: "https://github.com/acme/web/runs/991",
      driftRanAt: new Date("2026-11-10T06:43:40Z"),
    });
    expect(workspaceUpdateMany).toHaveBeenCalledWith({
      where: { projectId: "proj_1", orgId: "org_mine" },
      data: { driftDetected: true },
    });
    expect(connFindFirst.mock.calls[0][0].where).toMatchObject({ orgId: "org_mine", provider: "github", id: "conn_1" });
  });

  it("records no drift from the import check's own passing notice", async () => {
    vi.stubGlobal("fetch", github(run({ conclusion: "success" }), [{ annotation_level: "notice", message: OUTCOME.passed("4") }]));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(projectWrites()[1].data).toMatchObject({ driftState: "none" });
    expect(workspaceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { driftDetected: false } }));
  });

  it("records unknown, and leaves workspaces alone, when the run says nothing about drift", async () => {
    const missing = `${OUTCOME.missingPrefix} Add these repository secrets, then re-run: HCLOUD_TOKEN.`;
    vi.stubGlobal("fetch", github(run({ conclusion: "failure" }), [{ annotation_level: "failure", message: missing }]));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(projectWrites()[1].data).toMatchObject({ driftState: "unknown", driftMessage: missing });
    expect(workspaceUpdateMany).not.toHaveBeenCalled();
  });

  it("does not take a green run without the no-drift notice as no drift", async () => {
    vi.stubGlobal("fetch", github(run({ conclusion: "success", annotations: 0 }), []));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(projectWrites()[1].data).toMatchObject({ driftState: "unknown" });
  });

  it("records unknown when no recent commit has a drift run", async () => {
    vi.stubGlobal("fetch", github({ total_count: 0, check_runs: [] }, []));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(projectWrites()[1].data).toMatchObject({
      driftState: "unknown",
      driftMessage: "The drift check has not run on main yet.",
      driftCheckUrl: null,
    });
  });

  it("does nothing when another sweep claimed the project first", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    projectUpdateMany.mockResolvedValueOnce({ count: 0 });
    const last = new Date("2026-11-10T01:00:00Z");
    expect(await svc.checkProjectDrift({ ...PROJECT, driftCheckedAt: last }, NOW)).toBe(false);
    expect(projectWrites()[0].where).toMatchObject({ driftCheckedAt: last });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(projectUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("marks the connection invalid on a 401 and says so on the project", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Bad credentials" }, 401)));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(connUpdateMany).toHaveBeenCalledWith({
      where: { id: "conn_1" },
      data: { status: "invalid", lastError: expect.stringContaining("(401) during the drift check") },
    });
    expect(projectWrites()[1].data).toMatchObject({ driftState: "unknown" });
  });

  it("keeps the last state, and the connection, when GitHub is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Server Error" }, 502)));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(connUpdateMany).not.toHaveBeenCalled();
    expect(projectWrites()).toHaveLength(1); // the claim only
  });

  it("does not call GitHub with a connection already marked invalid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    connFindFirst.mockResolvedValue({ ...CONN, status: "invalid" });
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(projectWrites()[1].data).toMatchObject({ driftState: "unknown" });
  });
});

describe("several drift checks on one commit", () => {
  it("gives each imported module, and the stack, exactly its own result", async () => {
    // Two modules' workflows in one repository, both run at 06:23 on the same
    // commit; the clean one started last, so "newest infra drift run" would
    // have answered for both.
    const fetchMock = githubRuns({
      [APP]: {
        body: run({ conclusion: "failure", id: 991 }),
        annotations: [{ annotation_level: "failure", message: OUTCOME.changes("1", "9") }],
      },
      "infra drift: infra-network": {
        body: run({ conclusion: "success", id: 992 }),
        annotations: [{ annotation_level: "notice", message: OUTCOME.passed("4") }],
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    await svc.checkProjectDrift({ ...PROJECT, id: "proj_2", destPath: "infra/network" }, NOW);
    await svc.checkProjectDrift({ ...PROJECT, id: "proj_3", source: "stack", destPath: "" }, NOW);
    const states = Object.fromEntries(
      projectWrites()
        .filter((w) => "driftState" in w.data)
        .map((w) => [w.where.id, [w.data.driftState, w.data.driftCheckUrl]])
    );
    expect(states).toEqual({
      proj_1: ["drift", "https://github.com/acme/web/runs/991"],
      proj_2: ["none", "https://github.com/acme/web/runs/992"],
      // The stack asks for plain "infra drift", which neither module writes.
      proj_3: ["unknown", null],
    });
    const asked = fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("check_name")).filter(Boolean);
    expect(new Set(asked)).toEqual(new Set([APP, "infra drift: infra-network", "infra drift"]));
    expect(workspaceUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { projectId: "proj_1", orgId: "org_mine" }, data: { driftDetected: true } },
      { where: { projectId: "proj_2", orgId: "org_mine" }, data: { driftDetected: false } },
    ]);
  });
});

describe("GitHub rate limits are a back-off, not a refused credential", () => {
  const cases: [string, () => Response][] = [
    ["x-ratelimit-remaining 0", () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" })],
    ["retry-after", () => json({ message: "Forbidden" }, 403, { "retry-after": "60" })],
    ["a secondary-limit body", () => json({ message: "You have exceeded a secondary rate limit." }, 403)],
    ["429", () => json({ message: "Too Many Requests" }, 429)],
  ];
  for (const [what, answer] of cases) {
    it(`keeps the connection and the last state on a 403/429 with ${what}`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => answer()));
      expect(await svc.checkProjectDrift({ ...PROJECT }, NOW)).toBe(true);
      expect(connUpdateMany).not.toHaveBeenCalled();
      expect(projectWrites()).toHaveLength(1); // the claim, which is the back-off
    });
  }

  it("still marks the connection invalid on a 403 that is not a rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Resource not accessible by personal access token" }, 403)));
    await svc.checkProjectDrift({ ...PROJECT }, NOW);
    expect(connUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "invalid" }) }));
  });
});

describe("dueForDrift", () => {
  it("asks only for GitHub stack and imported projects not read within the interval", async () => {
    projectFindMany.mockResolvedValue([]);
    await svc.dueForDrift(NOW);
    const args = projectFindMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ source: { in: ["stack", "imported"] }, gitHost: "github", createRepo: false });
    expect(args.where.OR).toEqual([
      { driftCheckedAt: null },
      { driftCheckedAt: { lt: new Date(NOW.getTime() - svc.DRIFT_INTERVAL_MS) } },
    ]);
    expect(svc.DRIFT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(args.take).toBe(svc.DRIFT_BATCH);
  });

  it("a sweep reads each due project and survives one that throws", async () => {
    projectFindMany.mockResolvedValue([{ ...PROJECT }, { ...PROJECT, id: "proj_2" }]);
    connFindFirst.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ ...CONN });
    vi.stubGlobal("fetch", github({ total_count: 0, check_runs: [] }, []));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await svc.sweepDrift(NOW)).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
