import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHostClient } from "../lib/git/hosts.js";
import type { ClientFor } from "./team-stacks.js";

// Team stack rules over a small in-memory Prisma that evaluates the same
// `where` clauses the service sends (equality, `in`, `not`, OR), so the
// visibility filter is exercised, not just asserted on. The repository behind
// the client is mocked at loadTeamStack: its own tests cover reading a tree.

type Row = Record<string, any>;
const db: { providerConnection: Row[]; stackSource: Row[]; stackVersion: Row[] } = {
  providerConnection: [],
  stackSource: [],
  stackVersion: [],
};
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 10, 0, 0, clock++));
const id = (p: string) => `${p}_${clock++}`;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
    }
    return row[k] === v;
  });
}
// Prisma writes DbNull as SQL NULL and reads it back as null.
const stored = (data: Row) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === Prisma.DbNull ? null : v]));
const dup = () => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
const withVersions = (s: Row, include?: Row) => {
  if (!include?.versions) return { ...s };
  const vs = db.stackVersion.filter((v) => v.stackSourceId === s.id).sort((a, b) => a.createdAt - b.createdAt);
  const ordered = include.versions.orderBy?.createdAt === "desc" ? vs.reverse() : vs;
  return { ...s, versions: include.versions.take ? ordered.slice(0, include.versions.take) : ordered };
};

const prisma = {
  providerConnection: { findFirst: async ({ where }: Row) => db.providerConnection.find((r) => matches(r, where)) ?? null },
  stackSource: {
    findFirst: async ({ where, include }: Row) => {
      const s = db.stackSource.find((r) => matches(r, where));
      return s ? withVersions(s, include) : null;
    },
    findMany: async ({ where, include }: Row) => db.stackSource.filter((r) => matches(r, where)).map((s) => withVersions(s, include)),
    create: async ({ data, include }: Row) => {
      const { versions, ...rest } = data;
      if (db.stackSource.some((r) => ["orgId", "gitHost", "repo", "path"].every((k) => r[k] === rest[k]))) throw dup();
      const s = { visibility: "private", publishedVersionId: null, publishedAt: null, reviewedBy: null, reviewedAt: null, ...rest, id: id("src"), createdAt: now() };
      db.stackSource.push(s);
      db.stackVersion.push({ ...stored(versions.create), id: id("ver"), stackSourceId: s.id, createdAt: now() });
      return withVersions(s, include);
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = db.stackSource.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  },
  stackVersion: {
    create: async ({ data }: Row) => {
      if (db.stackVersion.some((v) => v.stackSourceId === data.stackSourceId && v.resolvedSha === data.resolvedSha)) throw dup();
      const v = { ...stored(data), id: id("ver"), createdAt: now() };
      db.stackVersion.push(v);
      return v;
    },
    count: async ({ where }: Row) => db.stackVersion.filter((r) => matches(r, where)).length,
    findMany: async ({ where }: Row) => db.stackVersion.filter((r) => matches(r, where)),
    findFirst: async ({ where }: Row) =>
      db.stackVersion.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
  },
};
vi.mock("../lib/db.js", () => ({ prisma }));
vi.mock("../lib/crypto.js", () => ({ decryptToken: (t: string) => t }));

// What each ref of the team's repository points at right now.
const refs: Record<string, string> = {};
vi.mock("../lib/stacks/team.js", async (orig) => ({
  ...(await orig<object>()),
  loadTeamStack: async (_c: unknown, { ref }: { ref: string }) => {
    const sha = refs[ref];
    if (ref === "broken") return { valid: false, sha: "f".repeat(40), manifest: null, files: [], errors: ["no stack.json in s"] };
    if (ref === "busy" || ref === "crashed") {
      const { StackCheckUnavailable } = await orig<typeof import("../lib/stacks/team.js")>();
      throw new StackCheckUnavailable("try again", ref === "busy" ? "busy" : "failed");
    }
    const manifest = { slug: "team-web", name: "Team web", description: "d", target: { slug: "aws", name: "AWS" }, runtime: { slug: "ecs", name: "ECS" }, deliveries: [{ slug: "gha", name: "GitHub Actions", gitHost: "github" }] };
    return { valid: true, sha, manifest, files: [{ path: "stack.json", mode: "100644", bytes: 2, sha256: "0".repeat(64) }], contents: { "stack.json": "{}" }, renderedFiles: 3 };
  },
}));

const svc = await import("./team-stacks.js");
const client: ClientFor = () => ({}) as GitHostClient;
const ACME = "org_acme";
const OTHER = "org_other";

async function acmeStack(ref = "v1") {
  return svc.registerStack(ACME, { connectionId: "conn_acme", repo: "acme/stacks", ref, path: "web" }, client);
}
/** The version the admin queue shows for a stack (or a stale id when none). */
const pendingVersion = (sourceId: string) =>
  db.stackSource.find((s) => s.id === sourceId)?.publishedVersionId ?? db.stackVersion[0]?.id ?? "ver_none";
const otherSees = async () => (await svc.listVisibleStacks(OTHER)).filter((s) => s.origin !== "infralift");

beforeEach(() => {
  db.providerConnection = [
    { id: "conn_acme", orgId: ACME, provider: "github", encryptedToken: "t" },
    { id: "conn_acme_aws", orgId: ACME, provider: "aws", encryptedToken: "t" },
    { id: "conn_other", orgId: OTHER, provider: "github", encryptedToken: "t" },
  ];
  db.stackSource = [];
  db.stackVersion = [];
  Object.assign(refs, { v1: "a".repeat(40), v2: "b".repeat(40) });
});

describe("registering a stack", () => {
  it("stores the source and a version pinned to the commit the ref resolved to", async () => {
    const s = await acmeStack();
    expect(s).toMatchObject({ origin: "org", repo: "acme/stacks", path: "web", visibility: "private" });
    expect(s.versions).toMatchObject([{ ref: "v1", resolvedSha: "a".repeat(40), valid: true }]);
  });

  it("uses only the caller's own git connections", async () => {
    const other = svc.registerStack(OTHER, { connectionId: "conn_acme", repo: "x/y", ref: "v1", path: "" }, client);
    await expect(other).rejects.toThrow("connection not found");
    const aws = svc.registerStack(ACME, { connectionId: "conn_acme_aws", repo: "x/y", ref: "v1", path: "" }, client);
    await expect(aws).rejects.toThrow(/not a git host/);
  });

  it("refuses traversal and absolute paths before reading anything", async () => {
    for (const path of ["../x", "a/../../b"]) {
      await expect(svc.registerStack(ACME, { connectionId: "conn_acme", repo: "acme/stacks", ref: "v1", path }, client)).rejects.toThrow(/relative/);
    }
    await expect(svc.registerStack(ACME, { connectionId: "conn_acme", repo: "../etc", ref: "v1", path: "" }, client)).rejects.toThrow(/owner\/name/);
  });

  it("records an invalid version with its errors, and it cannot be published", async () => {
    const s = await acmeStack("broken");
    expect(s.versions[0]).toMatchObject({ valid: false, validation: { errors: ["no stack.json in s"] } });
    await expect(svc.requestPublish(ACME, s.id, {})).rejects.toThrow(/no valid version/);
  });
});

describe("SHA pinning", () => {
  it("a moved tag adds a new version and leaves the existing one on its commit", async () => {
    const s = await acmeStack();
    refs.v1 = "c".repeat(40);
    const v = await svc.addStackVersion(ACME, s.id, { ref: "v1" }, client);
    expect(v.resolvedSha).toBe("c".repeat(40));
    const all = (await svc.getTeamStack(ACME, s.id)).versions.map((x) => x.resolvedSha);
    expect(all).toEqual(["c".repeat(40), "a".repeat(40)]);
    await expect(svc.addStackVersion(ACME, s.id, { ref: "v1" }, client)).rejects.toThrow(/already a version/);
  });
});

describe("visibility", () => {
  it("private and pending stacks are invisible to other orgs; public shows the reviewed version; revoked hides it", async () => {
    const s = await acmeStack();
    expect(await otherSees()).toEqual([]);

    await svc.requestPublish(ACME, s.id, {});
    expect(await otherSees()).toEqual([]);

    await svc.approveStack(s.id, pendingVersion(s.id), "admin@example.com");
    // A version added after review is the owner's, not the community's.
    await svc.addStackVersion(ACME, s.id, { ref: "v2" }, client);
    const seen = await otherSees();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: "community", version: { resolvedSha: "a".repeat(40) } });
    expect(seen[0]).not.toHaveProperty("visibility");
    expect((await svc.getTeamStack(OTHER, s.id)).versions.map((v) => v.resolvedSha)).toEqual(["a".repeat(40)]);

    await svc.revokeStack(s.id, pendingVersion(s.id), "admin@example.com");
    expect(await otherSees()).toEqual([]);
    await expect(svc.getTeamStack(OTHER, s.id)).rejects.toThrow("stack not found");
    // The owner keeps it.
    expect((await svc.listVisibleStacks(ACME)).find((x) => x.id === s.id)).toMatchObject({ origin: "org", visibility: "revoked" });
  });

  it("withdrawing takes a public stack back to private", async () => {
    const s = await acmeStack();
    await svc.requestPublish(ACME, s.id, {});
    await svc.approveStack(s.id, pendingVersion(s.id), "admin@example.com");
    await svc.withdrawStack(ACME, s.id);
    expect(await otherSees()).toEqual([]);
    expect(db.stackSource[0]).toMatchObject({ visibility: "private", publishedVersionId: null });
  });

  it("lists the catalog for every org", async () => {
    const catalog = (await svc.listVisibleStacks(OTHER)).filter((s) => s.origin === "infralift");
    expect(catalog.map((s) => s.id)).toContain("catalog:app-foundry-hetzner");
  });
});

describe("review transitions", () => {
  it("approve and revoke only move from states they may", async () => {
    const s = await acmeStack();
    await expect(svc.approveStack(s.id, pendingVersion(s.id), "a@x")).rejects.toThrow(/private, so it cannot be approved/);
    await expect(svc.revokeStack(s.id, pendingVersion(s.id), "a@x")).rejects.toThrow(/cannot be revoked/);
    await expect(svc.approveStack("src_missing", "ver_x", "a@x")).rejects.toThrow("stack not found");
    await svc.requestPublish(ACME, s.id, {});
    expect(await svc.listPendingStacks()).toMatchObject([{ id: s.id, orgId: ACME, version: { ref: "v1" } }]);
    await svc.revokeStack(s.id, pendingVersion(s.id), "a@x");
    await expect(svc.requestPublish(ACME, s.id, {})).rejects.toThrow(/revoked, so it cannot be published/);
    expect(db.stackSource[0]).toMatchObject({ reviewedBy: "a@x" });
  });
});

describe("approval is bound to the version reviewed", () => {
  it("an owner who withdraws and re-requests with another version voids the open review", async () => {
    const s = await acmeStack();
    await svc.requestPublish(ACME, s.id, {});
    const [queued] = await svc.listPendingStacks();
    expect(queued.versionId).toBe(s.versions[0].id);

    // Between the admin opening the queue and clicking approve:
    const v2 = await svc.addStackVersion(ACME, s.id, { ref: "v2" }, client);
    await svc.withdrawStack(ACME, s.id);
    await svc.requestPublish(ACME, s.id, { versionId: v2.id });

    await expect(svc.approveStack(s.id, queued.versionId!, "a@x")).rejects.toThrow(/version under review changed/);
    await expect(svc.revokeStack(s.id, queued.versionId!, "a@x")).rejects.toThrow(/version under review changed/);
    expect(db.stackSource[0]).toMatchObject({ visibility: "pending_public", publishedVersionId: v2.id, reviewedBy: null });
    expect(await otherSees()).toEqual([]);

    await svc.approveStack(s.id, v2.id, "a@x");
    expect((await otherSees())[0]).toMatchObject({ version: { id: v2.id } });
  });
});

describe("version cap", () => {
  it("refuses a version past the cap before reading the repository", async () => {
    const s = await acmeStack();
    for (let i = 1; i < svc.MAX_VERSIONS_PER_STACK; i++) {
      db.stackVersion.push({ ...db.stackVersion[0], id: `ver_fill_${i}`, resolvedSha: `${i}`.padStart(40, "0") });
    }
    await expect(svc.addStackVersion(ACME, s.id, { ref: "v2" }, client)).rejects.toThrow(/50 versions/);
  });
});

describe("tenant isolation", () => {
  it("another org cannot read, version, publish or withdraw a stack it does not own", async () => {
    const s = await acmeStack();
    await expect(svc.getTeamStack(OTHER, s.id)).rejects.toThrow("stack not found");
    await expect(svc.addStackVersion(OTHER, s.id, { ref: "v2" }, client)).rejects.toThrow("stack not found");
    await expect(svc.requestPublish(OTHER, s.id, {})).rejects.toThrow("stack not found");
    await svc.requestPublish(ACME, s.id, {});
    await svc.approveStack(s.id, pendingVersion(s.id), "a@x");
    await expect(svc.withdrawStack(OTHER, s.id)).rejects.toThrow("stack not found");
    await expect(svc.requestPublish(OTHER, s.id, { versionId: db.stackVersion[0].id })).rejects.toThrow("stack not found");
    expect(db.stackSource[0].visibility).toBe("public");
    expect(db.stackVersion).toHaveLength(1);
  });
});

describe("a check that could not run", () => {
  it("records nothing and answers 429 or 503, so the same commit can be tried again", async () => {
    await expect(acmeStack("busy")).rejects.toMatchObject({ status: 429 });
    await expect(acmeStack("crashed")).rejects.toMatchObject({ status: 503 });
    expect(db.stackSource).toHaveLength(0);
    expect(db.stackVersion).toHaveLength(0);
    refs.v1 = "a".repeat(40);
    const s = await acmeStack("v1");
    await expect(svc.addStackVersion(ACME, s.id, { ref: "busy" }, client)).rejects.toMatchObject({ status: 429 });
    expect(db.stackVersion).toHaveLength(1);
  });
});
