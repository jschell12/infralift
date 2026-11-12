import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdoptSelectedResult, UnmanagedPage, UnmanagedResource } from "@infralift/shared";
import {
  adoptFormProblem,
  adoptProblemFor,
  AdoptRequestError,
  appendPage,
  buildAdoptRequest,
  defaultAdoptForm,
  fetchUnmanagedPage,
  groupByType,
  groupSelection,
  keepLoadedPicks,
  postAdopt,
  resourceKey,
  toggleGroup,
  toggleResource,
  unmanagedPath,
  type AdoptForm,
} from "./adopt-account";

// Bodies are __fixtures__/unmanaged-api.json: what apps/api's real router
// answered for GET /connections/:id/unmanaged and POST /connections/:id/adopt
// over the Cloudflare connector fixture. Its _source says how it was captured
// and that the Cloudflare data is the provider's documented examples.
const fx = JSON.parse(readFileSync(new URL("./__fixtures__/unmanaged-api.json", import.meta.url), "utf8")) as {
  full: { body: UnmanagedPage };
  page1: { body: UnmanagedPage; nextCursor: string };
  page2: { body: UnmanagedPage; nextCursor: string };
  accepted: { status: number; body: AdoptSelectedResult };
  missing: { status: number; body: unknown };
  conflict: { status: number; body: unknown };
  refusedRows: UnmanagedResource[];
};

const all = fx.full.body.resources;
const withRefused = [...all, ...fx.refusedRows];
const ZONE_1 = all.find((r) => r.type === "cloudflare:zone")!;
const RECORD_1 = all.find((r) => r.type === "cloudflare:dns_record")!;

describe("resourceKey", () => {
  it("tells apart two resources that share a provider id but not a type", () => {
    // The fixture's first DNS record and first zone have the same id.
    expect(RECORD_1.providerId).toBe(ZONE_1.providerId);
    expect(resourceKey(RECORD_1)).not.toBe(resourceKey(ZONE_1));
  });
});

describe("groupByType", () => {
  it("groups by inventory type in alphabetical order, keeping the API's order inside a group", () => {
    const groups = groupByType(all);
    expect(groups.map((g) => [g.type, g.resources.length])).toEqual([
      ["cloudflare:dns_record", 2],
      ["cloudflare:r2_bucket", 1],
      ["cloudflare:zone", 2],
    ]);
    expect(groups[2]!.resources.map((r) => r.name)).toEqual(["example.com", "example.org"]);
  });

  it("lists only adoptable resources as pickable, and keeps the rest in the group", () => {
    const groups = groupByType(withRefused);
    const worker = groups.find((g) => g.type === "cloudflare:worker")!;
    expect(worker.resources).toHaveLength(1);
    expect(worker.adoptableKeys).toEqual([]);
    expect(groups.find((g) => g.type === "cloudflare:zone")!.adoptableKeys).toHaveLength(2);
  });

  it("is empty for an empty page", () => {
    expect(groupByType([])).toEqual([]);
  });
});

describe("appendPage (Load more)", () => {
  it("merges pages that split a type into one group per type", () => {
    // page2 ends on the first zone; the second zone is on the next page.
    const loaded = appendPage(fx.page1.body.resources, fx.page2.body.resources);
    const third = all.filter((r) => !loaded.some((l) => resourceKey(l) === resourceKey(r)));
    const merged = appendPage(loaded, third);
    expect(merged).toHaveLength(all.length);
    expect(groupByType(merged).map((g) => g.type)).toEqual(["cloudflare:dns_record", "cloudflare:r2_bucket", "cloudflare:zone"]);
  });

  it("skips a resource that is already loaded", () => {
    expect(appendPage(fx.page1.body.resources, fx.page1.body.resources)).toHaveLength(2);
  });
});

describe("selection", () => {
  const zones = groupByType(all).find((g) => g.type === "cloudflare:zone")!;

  it("toggles one resource in and out without changing the Set it was given", () => {
    const empty = new Set<string>();
    const one = toggleResource(empty, resourceKey(ZONE_1));
    expect(empty.size).toBe(0);
    expect([...one]).toEqual([resourceKey(ZONE_1)]);
    expect(toggleResource(one, resourceKey(ZONE_1)).size).toBe(0);
  });

  it.each([
    ["none", [] as string[]],
    ["some", ["first"]],
    ["all", ["first", "second"]],
  ])("reads a group as %s", (expected, which) => {
    const picked = new Set(which.map((w) => zones.adoptableKeys[w === "first" ? 0 : 1]!));
    expect(groupSelection(zones, picked)).toBe(expected);
  });

  it("select all fills a mixed group, and clears a full one", () => {
    const some = new Set([zones.adoptableKeys[0]!]);
    const full = toggleGroup(zones, some);
    expect(groupSelection(zones, full)).toBe("all");
    expect(groupSelection(zones, toggleGroup(zones, full))).toBe("none");
  });

  it("select all leaves other groups' picks alone", () => {
    const other = new Set([resourceKey(RECORD_1)]);
    const out = toggleGroup(zones, other);
    expect(out.has(resourceKey(RECORD_1))).toBe(true);
    expect(toggleGroup(zones, out).has(resourceKey(RECORD_1))).toBe(true);
  });

  it("never picks a resource that cannot be adopted", () => {
    const worker = groupByType(withRefused).find((g) => g.type === "cloudflare:worker")!;
    expect(toggleGroup(worker, new Set()).size).toBe(0);
    expect(groupSelection(worker, new Set())).toBe("none");
  });

  it("drops picks that a refresh no longer lists", () => {
    const picked = new Set([resourceKey(ZONE_1), resourceKey(RECORD_1), resourceKey(fx.refusedRows[0]!)]);
    const after = all.filter((r) => resourceKey(r) !== resourceKey(ZONE_1));
    expect([...keepLoadedPicks(picked, [...after, ...fx.refusedRows])]).toEqual([resourceKey(RECORD_1)]);
  });
});

// -- the request -----------------------------------------------------------------

const filled = (over: Partial<AdoptForm> = {}): AdoptForm => ({
  ...defaultAdoptForm("cloudflare"),
  name: "acme-cf",
  repo: "acme/infra",
  path: "infra/cf",
  gitConnectionId: "gh-conn",
  bucket: "acme-state",
  stateKey: "cf/terraform.tfstate",
  accountId: "0123456789abcdef0123456789abcdef",
  ...over,
});

describe("defaultAdoptForm", () => {
  it("starts from the provider, within the API's name rule", () => {
    const f = defaultAdoptForm("cloudflare");
    expect(f).toMatchObject({ name: "cloudflare-adopted", path: "infra/cloudflare", backendKind: "r2", branch: "main" });
    expect(adoptFormProblem({ ...filled(), name: f.name }, 1)).toBeNull();
  });
});

describe("adoptFormProblem", () => {
  it("passes a complete form", () => {
    expect(adoptFormProblem(filled(), 2)).toBeNull();
    expect(adoptFormProblem(filled({ backendKind: "s3", accountId: "", region: "us-east-1" }), 2)).toBeNull();
  });

  it.each([
    ["no picks", filled(), 0, /at least one/],
    ["too many picks", filled(), 201, /at most 200/],
    ["a name with capitals", filled({ name: "Acme" }), 1, /Project name/],
    ["a name too short", filled({ name: "ab" }), 1, /Project name/],
    ["no GitHub connection", filled({ gitConnectionId: "" }), 1, /Connect GitHub/],
    ["a repository without an owner", filled({ repo: "infra" }), 1, /owner\/name/],
    ["a directory that climbs out", filled({ path: "infra/../etc" }), 1, /Directory/],
    ["a directory with spaces", filled({ path: "my infra" }), 1, /Directory/],
    ["no bucket", filled({ bucket: "  " }), 1, /bucket/],
    ["R2 with no account id", filled({ accountId: "" }), 1, /Cloudflare account id/],
    ["S3 with no region", filled({ backendKind: "s3", region: "" }), 1, /Region/],
  ])("stops %s", (_label, form, picked, message) => {
    expect(adoptFormProblem(form, picked)).toMatch(message);
  });
});

describe("buildAdoptRequest", () => {
  it("sends the picked keys in list order, and an R2 backend with its account id", () => {
    // Picked out of order; the body follows the list.
    const picked = new Set([resourceKey(all[4]!), resourceKey(all[3]!)]);
    expect(buildAdoptRequest(filled(), picked, all)).toEqual({
      resources: [
        { type: "cloudflare:zone", providerId: all[3]!.providerId },
        { type: "cloudflare:zone", providerId: all[4]!.providerId },
      ],
      target: {
        kind: "new",
        name: "acme-cf",
        repo: "acme/infra",
        ref: "main",
        gitConnectionId: "gh-conn",
        path: "infra/cf",
        backend: { kind: "r2", bucket: "acme-state", key: "cf/terraform.tfstate", accountId: "0123456789abcdef0123456789abcdef" },
      },
    });
  });

  it("sends an S3 backend with a region and no account id, trims fields and drops a blank branch", () => {
    const body = buildAdoptRequest(
      filled({ backendKind: "s3", region: " us-west-2 ", repo: " acme/infra ", path: "/infra/cf/", branch: " " }),
      new Set([resourceKey(ZONE_1)]),
      all
    );
    expect(body.target).toEqual({
      kind: "new",
      name: "acme-cf",
      repo: "acme/infra",
      gitConnectionId: "gh-conn",
      path: "infra/cf",
      backend: { kind: "s3", bucket: "acme-state", key: "cf/terraform.tfstate", region: "us-west-2" },
    });
  });

  it("leaves out a key that is not in the loaded list", () => {
    const body = buildAdoptRequest(filled(), new Set([resourceKey(ZONE_1), "cloudflare:zone\ngone"]), all);
    expect(body.resources).toEqual([{ type: "cloudflare:zone", providerId: ZONE_1.providerId }]);
  });
});

// -- errors ------------------------------------------------------------------------

describe("adoptProblemFor", () => {
  it("names each resource another project manages, from the API's 409", () => {
    const p = adoptProblemFor(fx.conflict.status, fx.conflict.body, all);
    expect(p.message).toMatch(/already managed by another project/);
    expect(p.resources).toEqual([{ label: "example.com (cloudflare:zone)", detail: null }]);
  });

  it("says which project when the ledger race named it", () => {
    // services/managed-resources.ts alreadyManaged(): a unique-index loss
    // carries the winning project's name on each key.
    const body = {
      error: "a resource you picked is already managed by project acme-dns",
      managed: [{ type: "cloudflare:zone", providerId: ZONE_1.providerId, project: "acme-dns" }],
    };
    expect(adoptProblemFor(409, body, all).resources).toEqual([
      { label: "example.com (cloudflare:zone)", detail: "managed by acme-dns" },
    ]);
  });

  it("falls back to the provider id for a resource not in the loaded list", () => {
    expect(adoptProblemFor(409, fx.conflict.body, []).resources[0]!.label).toBe(`${ZONE_1.providerId} (cloudflare:zone)`);
  });

  it("uses the API's own sentence for a 409 that names no resources (a project name in use)", () => {
    const p = adoptProblemFor(409, { error: "a project named acme-cf already exists" });
    expect(p).toEqual({ message: "a project named acme-cf already exists", resources: [] });
  });

  it("asks for a refresh when picked resources left the account", () => {
    const p = adoptProblemFor(fx.missing.status, fx.missing.body, all);
    expect(p.message).toMatch(/no longer in the account/);
    expect(p.resources).toEqual([{ label: "gone (cloudflare:zone)", detail: null }]);
  });

  it("gives each refused resource its reason", () => {
    const body = {
      error: "some picked resources cannot be adopted yet",
      refused: [{ type: "cloudflare:load_balancer", providerId: "lb", reason: fx.refusedRows[0]!.reason }],
    };
    expect(adoptProblemFor(400, body, withRefused).resources).toEqual([
      { label: "lb (cloudflare:load_balancer)", detail: "no Terraform import mapping for this kind yet" },
    ]);
  });

  it("turns a 429 into try again in a few minutes, whatever the body", () => {
    // TooManyRequests in services/unmanaged.ts.
    for (const body of [{ error: "Too many reads of your cloud accounts. Wait a few minutes and try again." }, null]) {
      expect(adoptProblemFor(429, body).message).toMatch(/Try again in a few minutes/);
    }
  });

  it("never shows a server error's body, and says so when the network failed", () => {
    expect(adoptProblemFor(502, { error: "Could not read the account's resources", requestId: "r1" }).message).toBe(
      "Something went wrong on our side, try again."
    );
    expect(adoptProblemFor(null, null).message).toMatch(/couldn't reach infralift/);
  });

  it("ignores a list field that is not a list", () => {
    expect(adoptProblemFor(409, { error: "a project named x already exists", managed: "oops" }).resources).toEqual([]);
  });
});

// -- requests ----------------------------------------------------------------------

describe("unmanagedPath", () => {
  it("adds the cursor and refresh only when asked", () => {
    expect(unmanagedPath("cf-conn")).toBe("/connections/cf-conn/unmanaged");
    expect(unmanagedPath("cf-conn", { cursor: fx.page1.nextCursor })).toBe(
      `/connections/cf-conn/unmanaged?cursor=${encodeURIComponent(fx.page1.nextCursor)}`
    );
    expect(unmanagedPath("cf-conn", { refresh: true })).toBe("/connections/cf-conn/unmanaged?refresh=1");
  });
});

describe("fetchUnmanagedPage and postAdopt", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));

  it("reads the next cursor from X-Next-Cursor, and null on the last page", async () => {
    vi.stubGlobal("fetch", answer(200, fx.page1.body, { "X-Next-Cursor": fx.page1.nextCursor }));
    const first = await fetchUnmanagedPage("cf-conn");
    expect(first.nextCursor).toBe(fx.page1.nextCursor);
    expect(first.page.resources).toHaveLength(2);

    vi.stubGlobal("fetch", answer(200, fx.full.body));
    expect((await fetchUnmanagedPage("cf-conn")).nextCursor).toBeNull();
  });

  it("treats a 202 and a 200 replay as the same success", async () => {
    vi.stubGlobal("fetch", answer(202, fx.accepted.body));
    expect((await postAdopt("cf-conn", buildAdoptRequest(filled(), new Set(), all), all)).projectId).toBe("p-new");

    vi.stubGlobal("fetch", answer(200, { ...fx.accepted.body, replayed: true }));
    const replay = await postAdopt("cf-conn", buildAdoptRequest(filled(), new Set(), all), all);
    expect(replay).toMatchObject({ projectId: "p-new", replayed: true });
  });

  it("throws the page-ready problem for a 409, keeping the resource list", async () => {
    vi.stubGlobal("fetch", answer(fx.conflict.status, fx.conflict.body));
    const err = await postAdopt("cf-conn", buildAdoptRequest(filled(), new Set(), all), all).catch((e) => e);
    expect(err).toBeInstanceOf(AdoptRequestError);
    expect(err.status).toBe(409);
    expect(err.problem.resources).toHaveLength(1);
  });

  it("throws the network message when fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = await fetchUnmanagedPage("cf-conn").catch((e) => e);
    expect(err).toBeInstanceOf(AdoptRequestError);
    expect(err.status).toBeNull();
  });

  it("sends the body as JSON to the connection's adopt route", async () => {
    const fetchMock = answer(202, fx.accepted.body);
    vi.stubGlobal("fetch", fetchMock);
    const body = buildAdoptRequest(filled(), new Set([resourceKey(ZONE_1)]), all);
    await postAdopt("cf-conn", body, all);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/connections/cf-conn/adopt");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
});
