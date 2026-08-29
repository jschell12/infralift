import { describe, expect, it } from "vitest";
import { parseCookies } from "./cf-auth.js";

describe("parseCookies", () => {
  it("returns nothing without a Cookie header", () => {
    expect(parseCookies(undefined, "CF_Authorization")).toEqual([]);
  });

  it("reads a single value", () => {
    expect(parseCookies("CF_Authorization=abc", "CF_Authorization")).toEqual([
      "abc",
    ]);
  });

  it("ignores other cookies and leading whitespace", () => {
    const header = "CF_AppSession=xyz; CF_Authorization=abc; other=1";
    expect(parseCookies(header, "CF_Authorization")).toEqual(["abc"]);
  });

  it("does not match a cookie whose name merely ends with the target", () => {
    const header = "NOT_CF_Authorization=wrong; CF_Authorization=right";
    expect(parseCookies(header, "CF_Authorization")).toEqual(["right"]);
  });

  // A browser holds one CF_Authorization per Access application that has
  // issued a session — a host-scoped app and a wildcard app both set the
  // cookie, and only one of the two carries the AUD the API verifies against.
  it("returns every value when the header repeats the cookie", () => {
    const header = "CF_Authorization=host-scoped; CF_Authorization=wildcard";
    expect(parseCookies(header, "CF_Authorization")).toEqual([
      "host-scoped",
      "wildcard",
    ]);
  });
});
