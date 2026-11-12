import { describe, expect, it } from "vitest";
import { legacyNewProjectUrl, STARTING_POINTS, startingPointOf } from "./new-project";

describe("/projects/new starting points", () => {
  it("are in the order ADR 0010 sets: adopt, stack, terraform", () => {
    expect(STARTING_POINTS.map((s) => s.key)).toEqual(["adopt", "stack", "terraform"]);
  });

  it("reads only a known starting point from the URL", () => {
    expect(startingPointOf("stack")).toBe("stack");
    for (const v of [null, "", "template", "existing", "ADOPT"]) expect(startingPointOf(v), String(v)).toBeNull();
  });
});

describe("links that used to open the new-project drawer on /projects", () => {
  // Each came from somewhere: ?start=existing (the dashboard's "Run your
  // assessment" button and the /assessments redirect), ?assess=<id> (a
  // connection's assess link), ?start=import and ?start=template (drawer tabs).
  const cases: [string, string, string | null][] = [
    ["?start=existing", "?start=existing", "/projects/new?start=adopt"],
    ["?assess=<connection id>", "?assess=c_123", "/projects/new?start=adopt&assess=c_123"],
    ["?assess wins over start", "?start=import&assess=c_1", "/projects/new?start=adopt&assess=c_1"],
    ["an id that needs escaping", "?assess=a%26b", "/projects/new?start=adopt&assess=a%26b"],
    ["?start=import", "?start=import", "/projects/new?start=terraform"],
    ["?start=template", "?start=template", "/projects/new?start=stack"],
    ["no query", "", null],
    ["an unrelated query", "?tab=runs", null],
  ];
  it.each(cases)("%s", (_name, search, expected) => {
    expect(legacyNewProjectUrl(search)).toBe(expected);
  });
});
