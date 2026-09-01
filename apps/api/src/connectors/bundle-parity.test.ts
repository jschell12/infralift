import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { collect as collectVercel } from "@infralift/collectors/vercel";
import { collect as collectHeroku } from "@infralift/collectors/heroku";
import { vercelConnector } from "./vercel.js";
import { herokuConnector } from "./heroku.js";
import { parseBundle, analyzeBundle, BundleError } from "./bundle.js";

// The point of this file: a customer who runs the collector themselves must
// get the same assessment as a customer who hands over a token. If these two
// paths can disagree, the whole "run it yourself" offer becomes a second,
// worse product that quietly prices migrations differently.
//
// Fixtures are real API responses captured from the infralift-testenv account
// (3 Heroku apps, 2 Vercel projects), with env values replaced by SENTINEL and
// owner/creator blocks removed. They are deliberately un-trimmed otherwise —
// a Vercel project object carries ~50 fields, and part of what is being tested
// is that all but twelve of them are ignored.

const SENTINEL = "SENTINEL_ENV_VALUE_MUST_NOT_APPEAR_IN_SNAPSHOT";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")
  );
}

const VERCEL_API = fixture("vercel-api.json");
const HEROKU_API = fixture("heroku-api.json");

let fetchMock: Mock;
let requested: string[];

/** Serve a route map keyed by exact pathname, and record every URL asked for. */
function serve(routes: Record<string, unknown>) {
  requested = [];
  fetchMock = vi.fn(async (url: string) => {
    const pathname = new URL(url).pathname;
    requested.push(pathname);
    if (!(pathname in routes)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => routes[pathname] };
  });
  return fetchMock as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Simulate the real trip: the collector writes a file, a human uploads it,
 * and the server parses whatever arrived. Anything that survives in memory but
 * not through JSON (undefined, Date, NaN) dies here rather than in production. */
function roundTrip(snapshot: unknown) {
  return JSON.parse(JSON.stringify(snapshot));
}

describe("bundle path matches token path", () => {
  it("produces an identical Vercel assessment", async () => {
    // Token path: the connector calls the API itself.
    const viaToken = await (async () => {
      vi.stubGlobal("fetch", serve(VERCEL_API));
      return vercelConnector.assess("tok");
    })();

    // Bundle path: the customer's machine collects, the file is uploaded.
    const snapshot = await collectVercel({
      token: "tok",
      fetchImpl: serve(VERCEL_API),
    });
    const viaBundle = analyzeBundle(parseBundle(roundTrip(snapshot)));

    expect(viaBundle).toEqual(viaToken);
    // Guard against both paths being trivially empty.
    expect(viaToken.inventory.length).toBeGreaterThan(0);
  });

  it("produces an identical Heroku assessment, costs included", async () => {
    const viaToken = await (async () => {
      vi.stubGlobal("fetch", serve(HEROKU_API));
      return herokuConnector.assess("tok");
    })();

    const snapshot = await collectHeroku({
      token: "tok",
      fetchImpl: serve(HEROKU_API),
    });
    const viaBundle = analyzeBundle(parseBundle(roundTrip(snapshot)));

    expect(viaBundle).toEqual(viaToken);
    // The cost model is the part most likely to drift silently, so assert it
    // is actually exercised rather than null on both sides.
    expect(viaToken.estimatedMonthlyCostCents).toBeGreaterThan(0);
    expect(viaBundle.estimatedMonthlyCostCents).toBe(
      viaToken.estimatedMonthlyCostCents
    );
  });
});

describe("the snapshot cannot carry secrets", () => {
  it("keeps env var values out of the Vercel snapshot entirely", async () => {
    // The fixture's projects DO carry env[].value, exactly as the live API
    // returns them. Vercel encrypts those, so they are ciphertext rather than
    // plaintext, but a collector that shipped the raw response would still put
    // ~1KB of opaque data per variable into a file the customer sends us.
    const raw = JSON.stringify(VERCEL_API);
    expect(raw).toContain(SENTINEL);

    const snapshot = await collectVercel({
      token: "tok",
      fetchImpl: serve(VERCEL_API),
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"env"');

    // The count still survives, which is all the analyzer ever wanted.
    const counted = snapshot.projects.filter(
      (p) => (p.envVarCount ?? 0) > 0
    );
    expect(counted.length).toBeGreaterThan(0);
  });

  it("never asks Heroku for config vars", async () => {
    await collectHeroku({ token: "tok", fetchImpl: serve(HEROKU_API) });

    // /apps/{id}/config-vars returns config values in plaintext and a `read`
    // scoped key can reach it. The collector's value depends on not calling
    // it, so assert on the actual request log rather than on the source.
    expect(requested.some((p) => p.includes("config-vars"))).toBe(false);

    // Stronger: pin the entire request surface. A new endpoint added to the
    // collector fails here until it is deliberately added to this list.
    const shapes = [...new Set(requested)].map((p) =>
      p.replace(
        /\/apps\/[0-9a-f-]{36}\//,
        "/apps/{id}/"
      )
    );
    expect(new Set(shapes)).toEqual(
      new Set(["/apps", "/apps/{id}/formation", "/apps/{id}/addons"])
    );
  });

  it("pins the Vercel request surface too", async () => {
    await collectVercel({ token: "tok", fetchImpl: serve(VERCEL_API) });
    expect(new Set(requested)).toEqual(
      new Set(["/v9/projects", "/v5/domains"])
    );
  });
});

describe("uploaded snapshots are validated, not trusted", () => {
  it("rejects a file that is not a snapshot", () => {
    expect(() => parseBundle({ hello: "world" })).toThrow(BundleError);
  });

  it("rejects an unsupported schema version with an actionable message", async () => {
    const snapshot = await collectVercel({
      token: "tok",
      fetchImpl: serve(VERCEL_API),
    });
    const future = { ...roundTrip(snapshot), schemaVersion: 99 };
    expect(() => parseBundle(future)).toThrow(/schema version 99/i);
  });

  it("refuses an edited bundle that smuggles env contents into the count", async () => {
    const snapshot = await collectVercel({
      token: "tok",
      fetchImpl: serve(VERCEL_API),
    });
    const tampered = roundTrip(snapshot);
    tampered.projects[0].envVarCount = [{ key: "SECRET", value: "hunter2" }];
    expect(() => parseBundle(tampered)).toThrow(BundleError);
  });

  it("caps array sizes so an upload cannot become a million-row insert", async () => {
    const snapshot = await collectVercel({
      token: "tok",
      fetchImpl: serve(VERCEL_API),
    });
    const huge = roundTrip(snapshot);
    const one = huge.projects[0];
    huge.projects = Array.from({ length: 2001 }, () => ({ ...one }));
    expect(() => parseBundle(huge)).toThrow(BundleError);
  });
});
