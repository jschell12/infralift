import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The connection service against a stubbed Prisma and a stubbed fetch, so the
// assertions are about what is written (or not) and what the provider was
// asked. Provider bodies are the shapes the connector tests use.

process.env.TOKEN_ENCRYPTION_KEY ??= "a".repeat(64);

const findFirst = vi.fn();
const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
  ...ROW,
  ...args.data,
}));
const updateMany = vi.fn(async () => ({ count: 1 }));
const del = vi.fn(async () => ({}));
const assessmentCount = vi.fn(async () => 0);
const projectFindMany = vi.fn(async (): Promise<{ name: string }[]> => []);
const stackCount = vi.fn(async () => 0);

vi.mock("../lib/db.js", () => ({
  prisma: {
    providerConnection: { findFirst, update, updateMany, delete: del },
    assessment: { count: assessmentCount },
    tfProject: { findMany: projectFindMany },
    stackSource: { count: stackCount },
  },
}));

// The TFC hostname check resolves DNS; that is tested in extensions.test.ts.
vi.mock("../lib/tf/extensions.js", async (orig) => ({
  ...(await orig<typeof import("../lib/tf/extensions.js")>()),
  assertPublicHost: vi.fn(async () => undefined),
}));

const { encryptToken, decryptToken } = await import("../lib/crypto.js");
const { ProviderHttpError } = await import("../connectors/types.js");
const { GitCommitError } = await import("../lib/git/errors.js");
const svc = await import("./connections.js");

const OLD = encryptToken("old-token");
const ROW = {
  id: "conn_1",
  orgId: "org_mine",
  provider: "github",
  label: "deploy bot",
  encryptedToken: OLD,
  status: "valid",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  lastVerifiedAt: new Date("2026-11-01T00:00:00Z"),
  lastCheckedAt: new Date("2026-11-01T00:00:00Z") as Date | null,
  verifyingSince: null as Date | null,
  lastError: null as string | null,
  expiresAt: null as Date | null,
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ ...ROW });
});

describe("rotateConnection", () => {
  it("keeps the old credential and returns GitHub's reason when the new one fails verify", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }), { status: 401 })
    );
    const err = await svc.rotateConnection("org_mine", "conn_1", { token: "new-bad" }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.body()).toMatchObject({ reason: "GitHub answered 401: Bad credentials" });
    expect(err.message).not.toContain("new-bad");
    expect(update).not.toHaveBeenCalled();
  });

  it("replaces the credential when the new one verifies, and never returns it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC" } })
    );
    const out = await svc.rotateConnection("org_mine", "conn_1", { token: "new-good" });
    const data = update.mock.calls[0][0].data as { encryptedToken: string; expiresAt: Date };
    expect(decryptToken(data.encryptedToken)).toBe("new-good");
    expect(data.expiresAt).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(out).toMatchObject({ status: "valid", lastError: null, expiresAt: "2026-12-01T00:00:00.000Z" });
    expect(JSON.stringify(out)).not.toContain("new-good");
    expect(JSON.stringify(out)).not.toContain(data.encryptedToken);
  });

  it("does not replace on a network error either", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(svc.rotateConnection("org_mine", "conn_1", { token: "x" })).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });
});

/** One connection row that updateMany writes to and findFirst reads back,
 *  honoring the check claim's condition (verifyingSince null or older than
 *  the cutoff), as Postgres would. Returns a reader for the row. */
function statefulRow(initial: typeof ROW) {
  let row = { ...initial };
  findFirst.mockImplementation(async () => ({ ...row }));
  updateMany.mockImplementation((async (args: {
    where: { OR?: { verifyingSince: null | { lt: Date } }[]; verifyingSince?: Date };
    data: Record<string, unknown>;
  }) => {
    const cutoff = (args.where.OR?.[1]?.verifyingSince as { lt: Date } | undefined)?.lt;
    if (cutoff && row.verifyingSince !== null && row.verifyingSince >= cutoff) return { count: 0 };
    // A write held to one claim: only while verifyingSince is still that time.
    if (args.where.verifyingSince && row.verifyingSince?.getTime() !== args.where.verifyingSince.getTime()) return { count: 0 };
    row = { ...row, ...args.data } as typeof row;
    return { count: 1 };
  }) as never);
  return () => row;
}

describe("Terraform Cloud connections re-verify through the org read", () => {
  const tfc = {
    ...ROW,
    provider: "tfc",
    encryptedToken: encryptToken(JSON.stringify({ hostname: "app.terraform.io", organization: "acme", token: "t" })),
  };

  it("valid when the organization reads", async () => {
    statefulRow(tfc);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "acme" } }), { status: 200 }));
    const out = await svc.verifyConnection("org_mine", "conn_1");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://app.terraform.io/api/v2/organizations/acme");
    expect(out).toMatchObject({ status: "valid", lastError: null });
  });

  it("invalid with a reason when it answers 401", async () => {
    statefulRow(tfc);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ status: "401", title: "unauthorized" }] }), { status: 401 }));
    const out = await svc.verifyConnection("org_mine", "conn_1");
    expect(out).toMatchObject({ status: "invalid", lastError: "this token cannot read the organization acme" });
  });
});

describe("markInvalidOnAuthFailure", () => {
  const conn = { id: "conn_1", provider: "cloudflare" };

  it("marks on a provider 401 or 403", async () => {
    expect(await svc.markInvalidOnAuthFailure(conn, new ProviderHttpError("Cloudflare API /accounts -> 401", 401), "connector", "an assessment")).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "conn_1" },
      data: { status: "invalid", lastError: "Cloudflare refused the credential (401) during an assessment" },
    });
    expect(await svc.markInvalidOnAuthFailure(conn, Object.assign(new Error("Vercel API /v9/projects -> 403"), { status: 403 }), "connector", "an assessment")).toBe(true);
  });

  it("does not mark on a 500, a network error, or a 404", async () => {
    for (const err of [
      new ProviderHttpError("Cloudflare API /accounts -> 500", 500),
      new TypeError("fetch failed"),
      new ProviderHttpError("Cloudflare API /zones -> 404", 404),
    ]) {
      expect(await svc.markInvalidOnAuthFailure(conn, err, "connector", "an assessment")).toBe(false);
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("reads a git host's status from GitCommitError, not the error's own 502", async () => {
    const gh = { id: "conn_1", provider: "github" };
    expect(await svc.markInvalidOnAuthFailure(gh, new GitCommitError("GitHub repo lookup failed (500) for a/b"), "git", "a git job")).toBe(false);
    expect(await svc.markInvalidOnAuthFailure(gh, new GitCommitError("GitHub repo lookup failed (401) for a/b"), "git", "a git job")).toBe(true);
    // A git error is not a connector's, and the reverse.
    expect(svc.authFailureStatus(new GitCommitError("x (401)"), "connector")).toBeNull();
    expect(svc.authFailureStatus(new ProviderHttpError("x", 401), "git")).toBeNull();
  });
});

describe("deleteConnection", () => {
  it("refuses with the connection's name while assessments or projects use it", async () => {
    assessmentCount.mockResolvedValueOnce(2);
    projectFindMany.mockResolvedValueOnce([{ name: "shop" }]);
    const err = await svc.deleteConnection("org_mine", "conn_1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toContain('"deploy bot" is still used by 2 assessments and project shop');
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses while a team stack reads through it, scoped to the org", async () => {
    stackCount.mockResolvedValueOnce(1);
    const err = await svc.deleteConnection("org_mine", "conn_1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toContain('"deploy bot" is still used by 1 stack');
    expect(stackCount).toHaveBeenCalledWith({ where: { orgId: "org_mine", connectionId: "conn_1" } });
    expect(del).not.toHaveBeenCalled();
  });

  it("counts a project that manages the connection's account as a use", async () => {
    projectFindMany.mockResolvedValueOnce([{ name: "aws-prod" }]);
    const err = await svc.deleteConnection("org_mine", "conn_1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(projectFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      orgId: "org_mine",
      OR: [{ gitConnectionId: "conn_1" }, { tfcConnectionId: "conn_1" }, { providerConnectionId: "conn_1" }],
    } }));
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes an unused connection", async () => {
    await svc.deleteConnection("org_mine", "conn_1");
    expect(del).toHaveBeenCalledWith({ where: { id: "conn_1" } });
  });
});

describe("a provider that does not answer in time", () => {
  // The real deadline is 15s; AbortSignal.timeout is shortened so the test
  // does not wait it out. fetch hangs until its signal aborts, as Node's does
  // for a server that accepts the connection and never answers.
  beforeEach(() => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 20);
      return c.signal;
    });
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("fails the connector call with an error naming the host, and does not mark the connection invalid", async () => {
    const { cloudflareConnector } = await import("../connectors/cloudflare.js");
    const { HttpTimeoutError } = await import("../lib/http.js");
    const err = await cloudflareConnector.assess("tok").catch((e) => e);
    expect(err).toBeInstanceOf(HttpTimeoutError);
    expect(err.message).toBe("api.cloudflare.com did not answer within 15s");
    expect(await svc.markInvalidOnAuthFailure({ id: "conn_1", provider: "cloudflare" }, err, "connector", "an assessment")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("re-verify records the timeout but keeps the connection's status", async () => {
    findFirst.mockResolvedValue({ ...ROW, provider: "cloudflare", encryptedToken: encryptToken("tok") });
    await svc.verifyConnection("org_mine", "conn_1");
    const record = updateMany.mock.calls.at(-1) as unknown as [{ where: unknown; data: Record<string, unknown> }];
    expect(record[0].where).toEqual({ id: "conn_1", verifyingSince: expect.any(Date) });
    expect(record[0].data).toEqual({
      lastCheckedAt: expect.any(Date),
      verifyingSince: null,
      lastError: "Cloudflare did not answer in time; try again",
    });
  });
});

describe("a connection's status", () => {
  it("reports any word but the three as unverified, as production's \"connected\" rows", () => {
    expect(svc.normalizeStatus("connected")).toBe("unverified");
    expect(svc.normalizeStatus("")).toBe("unverified");
    expect(svc.normalizeStatus("valid")).toBe("valid");
    expect(svc.normalizeStatus("invalid")).toBe("invalid");
    expect(svc.normalizeStatus("unverified")).toBe("unverified");
    const summary = svc.toSummary({ ...ROW, status: "connected", lastVerifiedAt: null, lastCheckedAt: null });
    expect(summary).toMatchObject({ status: "unverified", lastVerifiedAt: null, lastCheckedAt: null, checking: false });
  });

  it("reads checking only while the claim is live", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(svc.isChecking({ verifyingSince: null }, now)).toBe(false);
    expect(svc.isChecking({ verifyingSince: new Date(now - 1000) }, now)).toBe(true);
    expect(svc.isChecking({ verifyingSince: new Date(now - svc.CHECK_CLAIM_MS) }, now)).toBe(false);
  });
});

describe("outcomeData", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  it("records a valid check, clears the error and releases the claim", () => {
    expect(svc.outcomeData({ valid: true, reason: null, expiresAt: null }, now)).toEqual({
      lastCheckedAt: now,
      verifyingSince: null,
      status: "valid",
      lastVerifiedAt: now,
      lastError: null,
      expiresAt: null,
    });
  });
  it("marks a refused credential invalid with its reason", () => {
    expect(svc.outcomeData({ valid: false, reason: "GitHub answered 401", expiresAt: null }, now)).toEqual({
      lastCheckedAt: now,
      verifyingSince: null,
      status: "invalid",
      lastError: "GitHub answered 401",
    });
  });
  it("keeps the status on a timeout and does not touch lastVerifiedAt", () => {
    const data = svc.outcomeData({ valid: false, reason: "slow", expiresAt: null, timedOut: true }, now);
    expect(data).toEqual({ lastCheckedAt: now, verifyingSince: null, lastError: "slow" });
  });
});

describe("one check of a connection at a time", () => {
  const github = { ...ROW, provider: "github", encryptedToken: encryptToken("ghp_x"), lastCheckedAt: null };
  const ok = () => new Response(JSON.stringify({ login: "bot" }), { status: 200 });

  it("two Verify now calls at once make one provider call, and both get the result", async () => {
    const read = statefulRow(github);
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    const a = svc.verifyConnection("org_mine", "conn_1");
    const b = svc.verifyConnection("org_mine", "conn_1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    answer(ok());
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra).toMatchObject({ status: "valid", checking: false });
    expect(rb).toMatchObject({ status: "valid", checking: false });
    expect(read().verifyingSince).toBeNull();
    expect(read().lastCheckedAt).toBeInstanceOf(Date);
  });

  it("leaves a connection another process is checking alone and says it is checking", async () => {
    const read = statefulRow({ ...github, verifyingSince: new Date(Date.now() - 5_000) });
    const out = await svc.verifyConnection("org_mine", "conn_1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ checking: true });
    expect(read().verifyingSince).not.toBeNull();
  });

  it("takes over a claim older than CHECK_CLAIM_MS, whose process is gone", async () => {
    statefulRow({ ...github, verifyingSince: new Date(Date.now() - svc.CHECK_CLAIM_MS - 1_000) });
    fetchMock.mockResolvedValueOnce(ok());
    const out = await svc.verifyConnection("org_mine", "conn_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ status: "valid", checking: false });
  });

  it("drops a queued check whose claim could lapse before the provider answers, without calling it", async () => {
    const claimedAt = new Date(Date.now() - svc.CHECK_CLAIM_MS + 5_000);
    const read = statefulRow({ ...github, verifyingSince: claimedAt });
    expect(await svc.runClaimedCheck(read() as never, claimedAt, { timeoutMs: 20_000 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a claim another check took over meanwhile", async () => {
    const mineAt = new Date(Date.now() - 1_000);
    const theirs = new Date();
    const read = statefulRow({ ...github, verifyingSince: theirs });
    fetchMock.mockResolvedValueOnce(ok());
    expect(await svc.runClaimedCheck(read() as never, mineAt)).toBeNull();
    expect(read().verifyingSince).toEqual(theirs);
    expect(read().lastCheckedAt).toBeNull();
  });

  it("records a timeout when the provider runs past the check's deadline", async () => {
    const read = statefulRow(github);
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const out = await svc.runCheck(read() as never, { timeoutMs: 10 });
    expect(out).toMatchObject({ status: "valid", lastError: "GitHub did not answer in time; try again", verifyingSince: null });
  });
});
