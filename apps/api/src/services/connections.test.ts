import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("Terraform Cloud connections re-verify through the org read", () => {
  const tfc = {
    ...ROW,
    provider: "tfc",
    encryptedToken: encryptToken(JSON.stringify({ hostname: "app.terraform.io", organization: "acme", token: "t" })),
  };

  it("valid when the organization reads", async () => {
    findFirst.mockResolvedValue(tfc);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "acme" } }), { status: 200 }));
    const out = await svc.verifyConnection("org_mine", "conn_1");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://app.terraform.io/api/v2/organizations/acme");
    expect(out).toMatchObject({ status: "valid", lastError: null });
  });

  it("invalid with a reason when it answers 401", async () => {
    findFirst.mockResolvedValue(tfc);
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

  it("deletes an unused connection", async () => {
    await svc.deleteConnection("org_mine", "conn_1");
    expect(del).toHaveBeenCalledWith({ where: { id: "conn_1" } });
  });
});
