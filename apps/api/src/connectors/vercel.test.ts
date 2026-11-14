import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collect, MAX_PROJECT_PAGES } from "@infralift/collectors/vercel";

// The collector lists projects at GET /v10/projects (vercel/sdk@fe01b47
// vercel-spec.json), following pagination.next. Before #153 finding 1 it
// asked /v9/projects, which the description does not have.
//
// The recorded body is the /v9/projects response captured live on 2026-08-31
// (__fixtures__/vercel-api.json). Every field the collector reads is declared
// by v10 too; e2e/specs/fixtures-match-specs.test.ts checks the whole body
// against the v10 schema.

const RECORDED = JSON.parse(readFileSync(new URL("./__fixtures__/vercel-api.json", import.meta.url), "utf8"));
const project = (id: string) => ({ id, name: id, nodeVersion: "22.x" });

/** A fetch that answers /v10/projects from `pages`, keyed by the `from` it was
 *  sent ("" for the first page), and records every projects URL. */
function pagedFetch(pages: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/v5/domains") return { ok: true, status: 200, json: async () => ({ domains: [] }) };
    asked.push(`${url.pathname}${url.search}`);
    const key = url.searchParams.get("from") ?? "";
    if (!(key in pages)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => pages[key] };
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

describe("Vercel collector: GET /v10/projects", () => {
  it("reads the recorded v9 body at v10 with every field the collector keeps", async () => {
    const { fetchImpl } = pagedFetch({ "": RECORDED["/v9/projects"] });
    const snapshot = await collect({ token: "tok", fetchImpl });
    expect(snapshot.projects).toHaveLength(RECORDED["/v9/projects"].projects.length);
    const recorded = RECORDED["/v9/projects"].projects[0];
    expect(snapshot.projects[0]).toMatchObject({
      id: recorded.id,
      name: recorded.name,
      framework: recorded.framework ?? null,
      nodeVersion: recorded.nodeVersion,
      envVarCount: recorded.env.length,
    });
  });

  it("follows a continuation token (a string) as `from` until next is null", async () => {
    const { fetchImpl, asked } = pagedFetch({
      "": { projects: [project("a")], pagination: { count: 1, next: "JBSWY3DPEHPK3PXP" } },
      JBSWY3DPEHPK3PXP: { projects: [project("b")], pagination: { count: 1, next: null } },
    });
    const snapshot = await collect({ token: "tok", fetchImpl });
    expect(snapshot.projects.map((p) => p.id)).toEqual(["a", "b"]);
    expect(asked).toEqual(["/v10/projects?limit=100", "/v10/projects?limit=100&from=JBSWY3DPEHPK3PXP"]);
  });

  it("follows a timestamp (a number) as `from` too", async () => {
    const { fetchImpl, asked } = pagedFetch({
      "": { projects: [project("a")], pagination: { count: 1, next: 1540095775951, prev: null } },
      "1540095775951": { projects: [project("b")], pagination: { count: 1, next: null, prev: 1540095775951 } },
    });
    expect((await collect({ token: "tok", fetchImpl })).projects.map((p) => p.id)).toEqual(["a", "b"]);
    expect(asked[1]).toBe("/v10/projects?limit=100&from=1540095775951");
  });

  it("takes the bare-array form of the response as one page", async () => {
    const { fetchImpl, asked } = pagedFetch({ "": [project("a"), project("b")] });
    expect((await collect({ token: "tok", fetchImpl })).projects.map((p) => p.id)).toEqual(["a", "b"]);
    expect(asked).toHaveLength(1);
  });

  it("stops on an empty page even if it names a next one", async () => {
    const { fetchImpl, asked } = pagedFetch({ "": { projects: [], pagination: { count: 0, next: "more" } } });
    expect((await collect({ token: "tok", fetchImpl })).projects).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("fails rather than looping when the next page is the one just asked for", async () => {
    const { fetchImpl } = pagedFetch({
      "": { projects: [project("a")], pagination: { count: 1, next: "t1" } },
      t1: { projects: [project("b")], pagination: { count: 1, next: "t1" } },
    });
    await expect(collect({ token: "tok", fetchImpl })).rejects.toThrow(/same next page \(t1\) twice/);
  });

  it(`gives up with an error after ${MAX_PROJECT_PAGES} pages, never returning a silently short list`, async () => {
    let n = 0;
    const fetchImpl = (async (input: string) => {
      if (new URL(input).pathname === "/v5/domains") return { ok: true, status: 200, json: async () => ({ domains: [] }) };
      n++;
      return { ok: true, status: 200, json: async () => ({ projects: [project(`p${n}`)], pagination: { count: 1, next: `t${n}` } }) };
    }) as unknown as typeof fetch;
    await expect(collect({ token: "tok", fetchImpl })).rejects.toThrow(`still had more pages after ${MAX_PROJECT_PAGES}`);
    expect(n).toBe(MAX_PROJECT_PAGES);
  });

  it("passes the provider's status on a refused page, so a 403 still reads as a refused credential", async () => {
    const { fetchImpl } = pagedFetch({});
    await expect(collect({ token: "tok", fetchImpl })).rejects.toMatchObject({ status: 404, message: "Vercel API /v10/projects?limit=100 -> 404" });
  });
});
