import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A review panel's sharpest criticism was not the engineering, it was that the
// site promised things the code did not do: "zero downtime", "instant
// rollback". The buyer for this product is a staff engineer who will check,
// and a claim they can disprove costs more than a claim never made.
//
// The honest version, which the assessment's migration plan now generates per
// account: no downtime while we build, traffic cutover reversible in seconds
// at the edge, and a write pause of minutes to move the database, after which
// reversibility ends. All three are defensible. "Zero downtime" is not,
// because moving a database is not free.
//
// This is a ratchet. Copy is easy to write and nobody diffs it against what
// the product does, so the phrases that were wrong once are banned by name.

const WEB = join(process.cwd());
const DOCS = join(process.cwd(), "..", "..", "docs");

/** Phrases that overstate what the product does, and what to say instead. */
const BANNED: { pattern: RegExp; why: string }[] = [
  // The point is not that "downtime" is unsayable, it is that the claim has to
  // name what it covers. "No downtime while we build" is true and allowed;
  // "no downtime", full stop, is not. Hence the lookahead for a qualifier
  // rather than a ban on the phrase. "zero read downtime" already names its
  // scope and never matches.
  {
    pattern: /\b(zero|no) downtime\b(?!\s+(while|during|on|for|to)\b)/i,
    why: 'unqualified — moving a database needs a write pause. Say what has no downtime (the build), or name the window.',
  },
  {
    pattern: /instant rollback/i,
    why: 'rollback is fast for traffic and not available at all once the new database has taken writes. Scope it.',
  },
  {
    pattern: /reversible in seconds(?!,? for)/i,
    why: 'true of a traffic swap, false after the first write to the new database. Qualify it.',
  },
];

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "out") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe("customer-facing copy does not outrun the product", () => {
  const targets = [
    ...filesUnder(join(WEB, "app"), [".tsx", ".ts"]),
    ...filesUnder(join(WEB, "lib"), [".ts"]).filter((f) => !f.endsWith(".test.ts")),
    ...filesUnder(DOCS, [".md"]),
  ];

  it("has files to check, so a path change cannot silently pass this", () => {
    expect(targets.length).toBeGreaterThan(5);
  });

  for (const { pattern, why } of BANNED) {
    it(`never says ${pattern.source}`, () => {
      const hits: string[] = [];
      for (const file of targets) {
        const text = readFileSync(file, "utf8");
        for (const [i, line] of text.split("\n").entries()) {
          if (pattern.test(line)) {
            hits.push(`${file.replace(process.cwd(), ".")}:${i + 1}  ${line.trim()}`);
          }
        }
      }
      expect(hits, `${why}\n\n${hits.join("\n")}`).toEqual([]);
    });
  }
});
