import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, errorMessageFor, errorText, siteUrl } from "./api";

// Each body with a file named beside it is one the API sends, copied from
// where that file builds it. The last four cases have no source: they are the
// guard's edges (empty, JSON text, no body, an unmapped status).

const SERVER = "Something went wrong on our side, try again.";

describe("errorMessageFor shows the API's sentence or a status message, never detail", () => {
  const BAD_REQUEST = "Something in that request wasn't right. Check the form and try again.";
  const RUNNING = "An assessment of this account is already running. Wait for it to finish, then try again.";
  const cases: [string, number, unknown, string][] = [
    ["a 404 sentence (lib/errors.ts NotFound)", 404, { error: "Connection not found" }, "Connection not found"],
    ["a 409 with an id beside it (services/assessments.ts)", 409, { error: RUNNING, assessmentId: "asm_1" }, RUNNING],
    ["a 400 whose detail is zod's JSON (routes/connections.ts)", 400,
      { error: "Invalid request", detail: '[\n  {\n    "code": "too_small",\n    "path": ["label"]\n  }\n]' }, "Invalid request"],
    ["a 400 whose error is zod's flatten() (lib/errors.ts InvalidBody)", 400,
      { error: { formErrors: [], fieldErrors: { token: ["Required"] } } }, "Check the form. token: Required"],
    ["a 422 list of sentences (routes/workspaces.ts Unprocessable)", 422,
      { error: ["a base workspace is listed more than once"] }, "Check the form. a base workspace is listed more than once"],
    ["a 401 in Cloudflare Access's words (lib/cf-auth.ts)", 401,
      { error: "Invalid access token", code: "ERR_JWT_EXPIRED", detail: "Invalid access token (ERR_JWT_EXPIRED)" },
      "You're not signed in. Sign in again, then retry."],
    ["the last error handler's 500 (lib/async-errors.ts)", 500, { error: "internal error" }, SERVER],
    ["a 502 that used to carry the connector's message (routes/assessments.ts, before)", 502,
      { error: "Assessment failed", detail: "Netlify API /sites -> 500", assessmentId: "asm_1" }, SERVER],
    ["a 502 quoting a git host's body (lib/git/github.ts GitCommitError)", 502,
      { error: 'GitHub commit failed (422) for acme/infra/main.tf: {"message":"Invalid request"}' }, SERVER],
    ["a non-JSON body", 503, null, SERVER],
    ["an empty error string", 400, { error: "" }, BAD_REQUEST],
    ["an error that is itself JSON text", 409, { error: '{"message":"conflict"}' },
      "That clashes with something already in progress. Refresh and try again."],
    ["a status with no message of its own", 418, {}, BAD_REQUEST],
  ];

  for (const [label, status, body, expected] of cases) {
    it(label, () => {
      const message = errorMessageFor(status, body);
      expect(message).toBe(expected);
      // Never a bare status code.
      expect(message).not.toMatch(/^\d{3}$/);
    });
  }
});

describe("api() throws an ApiError carrying the human message", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a failed response through errorMessageFor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "internal error" }), { status: 500 }))
    );
    const err = await api("/connections").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect(errorText(err)).toBe(SERVER);
  });

  it("says the network is the problem when no response arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const err = await api("/connections").catch((e: unknown) => e);
    expect((err as ApiError).status).toBeNull();
    expect(errorText(err)).toMatch(/couldn't reach infralift/);
  });

  it("returns the body of a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "c1" }]), { status: 200 })));
    await expect(api("/connections")).resolves.toEqual([{ id: "c1" }]);
  });
});

describe("errorText never shows a thrown error's own message", () => {
  it("uses the network sentence for anything that is not an ApiError", () => {
    expect(errorText(new TypeError("Cannot read properties of undefined"))).not.toMatch(/Cannot read/);
  });
});

describe("siteUrl builds a stack project's URL only from settings it has", () => {
  // The settings shape a stack project stores, as in
  // apps/api/src/lib/stacks/index.test.ts (zone_name "acme.io", subdomain "app").
  const cases: [string, Record<string, unknown>, string | null][] = [
    ["subdomain and zone", { name: "acme-web", zone_name: "acme.io", subdomain: "app" }, "https://app.acme.io"],
    ["no subdomain: the apex", { zone_name: "acme.io", subdomain: "" }, "https://acme.io"],
    ["neither key (what printed https://undefined.undefined)", { name: "acme-web", backend: "tfc" }, null],
    ["a subdomain without a zone", { subdomain: "app" }, null],
    ["a blank zone", { zone_name: "  ", subdomain: "app" }, null],
    ["a non-string zone", { zone_name: 42, subdomain: "app" }, null],
  ];
  it.each(cases)("%s", (_name, settings, expected) => {
    expect(siteUrl(settings)).toBe(expected);
  });
});
