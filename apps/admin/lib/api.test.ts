import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, errorMessageFor, errorText } from "./api";

// Bodies named with a file are ones the API sends, copied from where that file
// builds them. The rest are the guard's edges.

describe("errorMessageFor gives the admin a sentence, never a bare status", () => {
  const cases: [string, number, unknown, string][] = [
    ["a 404 sentence (routes/leads.ts NotFound)", 404, { error: "Lead not found" }, "Lead not found"],
    ["a 400 sentence (routes/leads.ts InvalidInput)", 400,
      { error: "status must be one of: new, contacted, qualified, dismissed, converted" },
      "status must be one of: new, contacted, qualified, dismissed, converted"],
    ["a 400 whose error is zod's flatten() (lib/errors.ts InvalidBody)", 400,
      { error: { formErrors: [], fieldErrors: { status: ["Required"] } } },
      "That request wasn't accepted. Check it and try again."],
    ["a 401 in Cloudflare Access's words (lib/cf-auth.ts)", 401,
      { error: "Invalid access token", detail: "Invalid access token (ERR_JWT_EXPIRED)" },
      "You're signed out. Sign in again, then retry."],
    ["the last error handler's 500 (lib/async-errors.ts)", 500, { error: "internal error" },
      "Something went wrong on the server. Try again."],
    ["a non-JSON 502", 502, null, "Something went wrong on the server. Try again."],
    ["an empty error string", 404, { error: "  " }, "That wasn't found. It may have been deleted."],
    ["JSON text in error", 400, { error: '{"message":"bad"}' }, "That request wasn't accepted. Check it and try again."],
    ["an unmapped 4xx with no body", 418, null, "That request wasn't accepted. Check it and try again."],
  ];
  it.each(cases)("%s", (_name, status, body, expected) => {
    expect(errorMessageFor(status, body)).toBe(expected);
  });
});

describe("api() throws ApiError with a readable message", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the 4xx body's sentence and keeps the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Lead not found" }), { status: 404 })));
    const err = await api("/leads/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Lead not found");
    expect((err as ApiError).status).toBe(404);
  });

  it("does not show a 500's body, or the number alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 500 })));
    const err = await api("/leads/report").catch((e: unknown) => e);
    expect(errorText(err)).toBe("Something went wrong on the server. Try again.");
    expect(errorText(err)).not.toMatch(/500/);
  });

  it("reports a fetch that never got a response as a connection problem", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await api("/leads").catch((e: unknown) => e);
    expect((err as ApiError).status).toBeNull();
    expect(errorText(err)).toBe("Couldn't reach the API. Check your connection and try again.");
    expect(errorText(new Error("raw stack text"))).toBe(errorText(err));
  });
});
