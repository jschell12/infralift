import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_RUN_CONCURRENCY, gcpConnector } from "./gcp.js";

// Cloud Run's services.list refuses the "locations/-" wildcard: the run v2
// discovery document (googleapis/google-api-go-client@2a50de2) says the
// location "cannot be the \"-\" wildcard". The connector sent it until #153
// finding 6. It now lists locations with the Cloud Run v1 locations API
// (run.projects.locations.list) and asks each one. Cloud Functions v2 does
// accept "-", so functions are still listed in one call.
//
// Response shapes follow those discovery documents (ListLocationsResponse,
// GoogleCloudRunV2ListServicesResponse); e2e/providers.e2e.test.ts serves the
// same operations through Prism from the pinned description.

const PROJECT = "acme-prod";
const KEY = JSON.stringify({
  type: "service_account",
  project_id: PROJECT,
  client_email: `infralift@${PROJECT}.iam.gserviceaccount.com`,
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
});
const RUN = "https://run.googleapis.com";
const location = (id: string) => ({ name: `projects/${PROJECT}/locations/${id}`, locationId: id });
const service = (loc: string, name: string) => ({ name: `projects/${PROJECT}/locations/${loc}/services/${name}`, uri: `https://${name}.run.app` });

let asked: string[];
let inFlight = 0;
let peak = 0;

/** Google over fetch: the token endpoint, Cloud Run as `run` says, and 403 for
 *  every other API (not enabled), which the connector skips. */
function google(run: (url: URL) => { status: number; body: unknown } | null) {
  asked = [];
  inFlight = 0;
  peak = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      asked.push(`${url.origin}${url.pathname}${url.search}`);
      if (url.href === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
      if (url.origin === RUN) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        const answer = run(url);
        if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status });
      }
      return new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } }), { status: 403 });
    })
  );
}

const runCalls = () => asked.filter((u) => u.startsWith(RUN));

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("GCP Cloud Run inventory", () => {
  it("lists locations with the v1 API, then services per location, never locations/-", async () => {
    const regions = Array.from({ length: 13 }, (_, i) => `region-${i}`);
    google((url) => {
      if (url.pathname === `/v1/projects/${PROJECT}/locations`) return { status: 200, body: { locations: regions.map(location) } };
      const m = url.pathname.match(/^\/v2\/projects\/acme-prod\/locations\/([^/]+)\/services$/);
      if (m) return { status: 200, body: m[1] === "region-3" ? { services: [service("region-3", "api"), service("region-3", "web")] } : {} };
      return null;
    });
    const result = await gcpConnector.assess(KEY);
    expect(runCalls().filter((u) => u.includes("locations/-"))).toEqual([]);
    expect(runCalls()[0]).toBe(`${RUN}/v1/projects/${PROJECT}/locations`);
    expect(runCalls()).toHaveLength(1 + regions.length);
    expect(new Set(runCalls())).toEqual(new Set([`${RUN}/v1/projects/${PROJECT}/locations`, ...regions.map((r) => `${RUN}/v2/projects/${PROJECT}/locations/${r}/services`)]));
    expect(peak).toBeLessThanOrEqual(CLOUD_RUN_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    const run = result.inventory.filter((i) => i.type === "gcp:cloud_run_service");
    expect(run.map((i) => [i.name, i.region])).toEqual([
      ["api", "region-3"],
      ["web", "region-3"],
    ]);
    expect(result.findings.some((f) => f.title.startsWith("Cloud Run not read"))).toBe(false);
    // Cloud Functions v2 does accept the wildcard, so it is still one call.
    expect(asked).toContain(`https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/-/functions`);
  });

  it("follows nextPageToken on the locations list", async () => {
    google((url) => {
      if (url.pathname === `/v1/projects/${PROJECT}/locations`) {
        return url.searchParams.get("pageToken") === "p2"
          ? { status: 200, body: { locations: [location("europe-west1")] } }
          : { status: 200, body: { locations: [location("us-central1")], nextPageToken: "p2" } };
      }
      if (url.pathname.endsWith("/services")) return { status: 200, body: { services: [service(url.pathname.split("/")[5]!, "svc")] } };
      return null;
    });
    const result = await gcpConnector.assess(KEY);
    expect(result.inventory.filter((i) => i.type === "gcp:cloud_run_service").map((i) => i.region).sort()).toEqual(["europe-west1", "us-central1"]);
    expect(runCalls()).toContain(`${RUN}/v1/projects/${PROJECT}/locations?pageToken=p2`);
  });

  it("says which regions did not answer instead of returning a silently short list", async () => {
    google((url) => {
      if (url.pathname === `/v1/projects/${PROJECT}/locations`) return { status: 200, body: { locations: [location("a"), location("b"), location("c")] } };
      if (url.pathname.includes("/locations/b/")) return { status: 503, body: {} };
      if (url.pathname.endsWith("/services")) return { status: 200, body: { services: [service(url.pathname.split("/")[5]!, "svc")] } };
      return null;
    });
    const result = await gcpConnector.assess(KEY);
    expect(result.inventory.filter((i) => i.type === "gcp:cloud_run_service").map((i) => i.region).sort()).toEqual(["a", "c"]);
    expect(result.findings).toContainEqual(expect.objectContaining({ category: "inventory", title: "Cloud Run not read in 1 region(s)" }));
  });

  it("skips Cloud Run, as before, when the API is not readable at all", async () => {
    google(() => null);
    const result = await gcpConnector.assess(KEY);
    expect(result.inventory.filter((i) => i.type === "gcp:cloud_run_service")).toEqual([]);
    expect(runCalls()).toEqual([`${RUN}/v1/projects/${PROJECT}/locations`]);
    expect(result.inventory.map((i) => i.type)).toEqual(["gcp:project"]);
  });
});
