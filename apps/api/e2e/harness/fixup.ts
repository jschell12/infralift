import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInTofu } from "./tofu.js";

/**
 * The hand edit ADR 0003 says generated code sometimes needs, done the way a
 * person would do it from `tofu validate`'s errors: delete each attribute the
 * provider rejects whose generated value is empty ("", 0 or null), and
 * validate again, until it validates. Anything else it leaves alone and
 * reports, so a rejection that is not an empty value fails the test instead
 * of being edited away.
 *
 * Needs an initialised module (Init has run in `dir`). Returns the deleted
 * lines.
 */
export async function removeInvalidEmptyAttributes(dir: string, modulePath: string): Promise<string[]> {
  const file = join(dir, modulePath, "generated.tf");
  const removed: string[] = [];
  for (let round = 0; round < 8; round++) {
    const out = await runInTofu({ dir, cwd: modulePath, script: "tofu validate -json -no-color || true" });
    const json = JSON.parse(out.output.slice(out.output.indexOf("{")));
    if (json.valid) return removed;
    const lines = new Set<number>();
    for (const d of json.diagnostics as { summary: string; range?: { filename: string; start: { line: number } } }[]) {
      if (d.range?.filename === "generated.tf") lines.add(d.range.start.line);
    }
    const src = readFileSync(file, "utf8").split("\n");
    const before = removed.length;
    for (const n of [...lines].sort((a, b) => b - a)) {
      if (/=\s*(""|0|null)\s*$/.test(src[n - 1])) removed.push(...src.splice(n - 1, 1).map((l) => l.trim()));
    }
    writeFileSync(file, src.join("\n"));
    if (removed.length === before) {
      throw new Error(`generated.tf has errors that are not empty values:\n${json.diagnostics.map((d: any) => `${d.summary}: ${d.detail}`).join("\n")}`);
    }
  }
  throw new Error("generated.tf still does not validate after 8 rounds");
}
