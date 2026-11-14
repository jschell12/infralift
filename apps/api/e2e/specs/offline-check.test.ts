// `extract.ts --check --offline` compares the pin each committed subset
// records with the one in sources.ts, without the network. Both directions:
// every committed subset passes as it is, and a subset recording another
// commit, or a missing file, fails.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { committedPinProblem } from "./extract.js";
import { SOURCES } from "./sources.js";

const committed = (out: string) => readFileSync(new URL(`./${out}`, import.meta.url), "utf8");

describe("the offline check", () => {
  it.each(SOURCES.filter((s) => s.license).map((s) => [s.name, s] as const))("%s: the committed subset names its pin", (_, source) => {
    expect(committedPinProblem(source, committed(source.out))).toBeNull();
  });

  it("fails a subset recording a different commit, in JSON and in SDL, and a missing one", () => {
    const vercel = SOURCES.find((s) => s.name === "vercel")!;
    const json = committed(vercel.out).replace(/"commit": "[0-9a-f]{40}"/, '"commit": "0000000000000000000000000000000000000000"');
    expect(committedPinProblem(vercel, json)).toMatch(/records commit "0{40}", sources.ts has "fe01b47/);
    const railway = SOURCES.find((s) => s.name === "railway")!;
    expect(committedPinProblem(railway, committed(railway.out).replace(/7da7f0d4/, "deadbeef"))).toMatch(/does not name railwayapp\/cli@7da7f0d4/);
    expect(committedPinProblem(vercel, "")).toBe("vercel.openapi.json is not committed");
  });
});
