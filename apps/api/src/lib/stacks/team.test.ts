import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GitHostClient, TreeEntry } from "../git/hosts.js";
import { getStack, renderStack } from "./index.js";
import { GitFileTooLarge } from "../git/errors.js";
import { checkInputSchema, checkManifest, isStackPath, loadTeamStack, selectStackEntries, TEAM_STACK_LIMITS } from "./team.js";

// A team stack is checked without running anything: path and size limits on
// the tree, the manifest against its schema, and a render of its example.
// The "team" repository here serves the catalog's own app-foundry-hetzner
// files from disk, so the valid case is a real stack, not an invented one.

const CATALOG = fileURLToPath(new URL("../../../stacks/app-foundry-hetzner/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );
}

/** A manifest's input schema without `pattern`, which team stacks may not use
 *  (checkInputSchema). The catalog's own schema has seven. */
function withoutPatterns<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutPatterns) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([k]) => k !== "pattern").map(([k, v]) => [k, withoutPatterns(v)])
  ) as T;
}

/** The catalog stack as a repository holding it at `dir`, with GitHub's tree
 *  entry shape (mode, type, size), and its input schema made team-legal. */
function catalogRepo(dir: string) {
  const files = new Map<string, { content: string; mode: string }>();
  for (const full of walk(CATALOG)) {
    const path = relative(CATALOG, full).split(sep).join("/");
    files.set(`${dir}/${path}`, {
      content: readFileSync(full, "utf8"),
      mode: statSync(full).mode & 0o111 ? "100755" : "100644",
    });
  }
  const manifest = JSON.parse(files.get(`${dir}/stack.json`)!.content);
  manifest.inputSchema = withoutPatterns(manifest.inputSchema);
  files.set(`${dir}/stack.json`, { content: JSON.stringify(manifest, null, 2), mode: "100644" });
  return files;
}

/** A host where `refs` maps a ref to a commit and each commit has a tree. */
function fakeHost(commits: Record<string, Map<string, { content: string; mode: string }>>, refs: Record<string, string>) {
  const reads: string[] = [];
  const client = {
    resolveRef: async ({ ref }: { ref: string }) => refs[ref] ?? (commits[ref] ? ref : null),
    listTree: async ({ ref }: { ref: string }) => ({
      entries: [...commits[ref]!].map(
        ([path, f]): TreeEntry => ({ path, type: "blob", mode: f.mode, size: Buffer.byteLength(f.content) })
      ),
      truncated: false,
    }),
    readFile: async ({ path, ref }: { path: string; ref: string }) => {
      reads.push(ref);
      return commits[ref]?.get(path)?.content ?? null;
    },
  } as unknown as GitHostClient;
  return { client, reads };
}

const blob = (path: string, mode = "100644", size = 10): TreeEntry => ({ path, type: "blob", mode, size });

describe("isStackPath", () => {
  it("accepts relative paths, dot-directories included", () => {
    for (const p of ["stack.json", "files/.github/workflows/deploy.yml", "templates/main.tf.tmpl"]) {
      expect(isStackPath(p), p).toBe(true);
    }
  });
  it("refuses absolute paths, traversal, backslashes and empty segments", () => {
    for (const p of ["", "/etc/passwd", "files/../../x", "files/./x", "files\\x", "files//x", "files/x/", "a b"]) {
      expect(isStackPath(p), p).toBe(false);
    }
  });
});

describe("selectStackEntries", () => {
  const ok = [blob("s/stack.json"), blob("s/files/a.txt"), blob("s/templates/main.tf.tmpl")];

  it("keeps the declared tree under the directory and ignores everything else", () => {
    const { files, errors } = selectStackEntries([...ok, blob("s/README.md"), blob(".github/workflows/ci.yml")], "s");
    expect(errors).toEqual([]);
    expect(files.map((f) => f.path)).toEqual(["stack.json", "files/a.txt", "templates/main.tf.tmpl"]);
  });

  it("refuses traversal inside the declared tree", () => {
    const { errors } = selectStackEntries([...ok, blob("s/files/../../etc/passwd")], "s");
    expect(errors.join()).toMatch(/not a safe relative path/);
  });

  // Entries as GitHub's tree API returned them (jschell12/shopping-mawl and a
  // submodule from schellout-engineering-team), moved under files/.
  it("refuses symlinks and submodules", () => {
    const symlink: TreeEntry = { path: "s/files/cooler.glb", type: "blob", mode: "120000", size: 36 };
    const submodule: TreeEntry = { path: "s/files/todo-app-benchmark", type: "commit", mode: "160000", size: null };
    const { errors } = selectStackEntries([...ok, symlink, submodule], "s");
    expect(errors).toEqual(["files/cooler.glb is a symlink", "files/todo-app-benchmark is a submodule"]);
  });

  it("refuses too many files, one file too big, and too much in total", () => {
    const many = Array.from({ length: TEAM_STACK_LIMITS.maxFiles }, (_, i) => blob(`s/files/f${i}.txt`));
    expect(selectStackEntries([...ok, ...many], "s").errors.join()).toMatch(/files; the limit is 300/);

    const big = blob("s/files/big.bin", "100644", TEAM_STACK_LIMITS.maxFileBytes + 1);
    expect(selectStackEntries([...ok, big], "s").errors.join()).toMatch(/big.bin is \d+ bytes/);

    const heavy = Array.from({ length: 9 }, (_, i) => blob(`s/files/h${i}`, "100644", TEAM_STACK_LIMITS.maxFileBytes));
    expect(selectStackEntries([...ok, ...heavy], "s").errors.join()).toMatch(/bytes in total/);
  });

  it("needs a stack.json, and an empty directory is not a stack", () => {
    expect(selectStackEntries([blob("s/files/a.txt")], "s").errors).toEqual(["no stack.json in s"]);
    expect(selectStackEntries([], "").errors).toEqual(["no stack.json in the repository root"]);
  });
});

describe("checkManifest", () => {
  const catalog = JSON.parse(readFileSync(join(CATALOG, "stack.json"), "utf8"));
  const paths = new Set<string>(catalog.rendered.map((r: { template: string }) => `templates/${r.template}`));

  it("accepts the catalog manifest's shape, with and without modules, refusing only its patterns", () => {
    const refused = checkManifest(catalog, paths);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((e) => e.includes('uses "pattern"'))).toBe(true);
    const teamLegal = { ...catalog, inputSchema: withoutPatterns(catalog.inputSchema) };
    expect(checkManifest(teamLegal, paths)).toEqual([]);
    const withModules = {
      ...teamLegal,
      modules: [{ name: "server", path: "deploy/infra", anchor: "hcloud_server", outputs: ["ipv4"] }],
    };
    expect(checkManifest(withModules, paths)).toEqual([]);
  });

  it("refuses a manifest missing what rendering needs", () => {
    const { deliveries: _d, ...noDeliveries } = catalog;
    expect(checkManifest(noDeliveries, paths).join()).toMatch(/must have required property 'deliveries'/);
  });

  it("refuses a template outside templates/ and an absolute output path", () => {
    const escape = { ...catalog, rendered: [{ path: "deploy/x.tf", template: "../stack.json" }] };
    expect(checkManifest(escape, paths).join()).toMatch(/not a file in templates/);
    const absolute = { ...catalog, rendered: [{ path: "/etc/cron.d/x", template: catalog.rendered[0].template }] };
    expect(checkManifest(absolute, paths).join()).toMatch(/unsafe path/);
  });
});

describe("loadTeamStack", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  it("reads a real stack at the pinned commit and renders its example as the catalog does", async () => {
    const { client, reads } = fakeHost({ [SHA_A]: catalogRepo("infra/stack") }, { v1: SHA_A });
    const loaded = await loadTeamStack(client, { repo: "acme/stacks", dir: "infra/stack", ref: "v1" });
    expect(loaded.valid).toBe(true);
    if (!loaded.valid) return;
    expect(loaded.sha).toBe(SHA_A);
    expect(new Set(reads)).toEqual(new Set([SHA_A]));
    const stack = getStack("app-foundry-hetzner")!;
    expect(loaded.renderedFiles).toBe(renderStack(stack, stack.example).length);
    expect(loaded.files.find((f) => f.path === "stack.json")?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins what the ref pointed at: a moved tag loads the new commit, never a mix", async () => {
    const before = catalogRepo("s");
    const after = new Map(before);
    after.set("s/files/deploy/NOTE.txt", { content: "moved\n", mode: "100644" });
    const refs: Record<string, string> = { v1: SHA_A };
    const { client } = fakeHost({ [SHA_A]: before, [SHA_B]: after }, refs);

    const first = await loadTeamStack(client, { repo: "acme/stacks", dir: "s", ref: "v1" });
    refs.v1 = SHA_B;
    const second = await loadTeamStack(client, { repo: "acme/stacks", dir: "s", ref: "v1" });
    expect([first.sha, second.sha]).toEqual([SHA_A, SHA_B]);
    expect(first.files.some((f) => f.path === "files/deploy/NOTE.txt")).toBe(false);
    expect(second.files.some((f) => f.path === "files/deploy/NOTE.txt")).toBe(true);
  });

  it("records a manifest that does not render as invalid, with the reason", async () => {
    const repo = catalogRepo("s");
    const manifest = JSON.parse(repo.get("s/stack.json")!.content);
    repo.set("s/stack.json", { content: JSON.stringify({ ...manifest, example: { name: "X" } }), mode: "100644" });
    const { client } = fakeHost({ [SHA_A]: repo }, { main: SHA_A });
    const loaded = await loadTeamStack(client, { repo: "acme/stacks", dir: "s", ref: "main" });
    expect(loaded.valid).toBe(false);
    if (loaded.valid) return;
    expect(loaded.errors.join()).toMatch(/^example /);
  });

  it("refuses a catastrophic pattern before any regex runs, and quickly", async () => {
    // ^(a+)+$ against "aaaa…!" doubles in time per character in a
    // backtracking engine; at 40 characters it would hold the event loop for hours.
    const repo = catalogRepo("s");
    const manifest = JSON.parse(repo.get("s/stack.json")!.content);
    manifest.inputSchema.properties.name = { type: "string", pattern: "^(a+)+$" };
    manifest.example = { ...manifest.example, name: `${"a".repeat(40)}!` };
    repo.set("s/stack.json", { content: JSON.stringify(manifest), mode: "100644" });
    const { client } = fakeHost({ [SHA_A]: repo }, { main: SHA_A });
    const started = performance.now();
    const loaded = await loadTeamStack(client, { repo: "acme/stacks", dir: "s", ref: "main" });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(loaded.valid).toBe(false);
    if (loaded.valid) return;
    expect(loaded.errors.join("\n")).toMatch(/inputSchema\/properties\/name uses "pattern"/);
  });

  it("refuses patternProperties and format anywhere, but not a property named pattern", async () => {
    const schema = {
      type: "object",
      properties: { pattern: { type: "string", enum: ["format"] }, tags: { type: "object", patternProperties: { "^x": {} } } },
      $defs: { email: { type: "string", format: "email" } },
    };
    expect(checkInputSchema(schema)).toEqual([
      'stack.json inputSchema/properties/tags uses "patternProperties", which team stacks may not use (regexes run on infralift\'s servers)',
      'stack.json inputSchema/$defs/email uses "format", which team stacks may not use (regexes run on infralift\'s servers)',
    ]);
  });

  it("compiles each team schema on its own, so another org's $id cannot break a registration", async () => {
    const withId = () => {
      const repo = catalogRepo("s");
      const manifest = JSON.parse(repo.get("s/stack.json")!.content);
      manifest.inputSchema.$id = "https://example.com/taken";
      repo.set("s/stack.json", { content: JSON.stringify(manifest), mode: "100644" });
      return fakeHost({ [SHA_A]: repo }, { main: SHA_A }).client;
    };
    const first = await loadTeamStack(withId(), { repo: "org-a/stacks", dir: "s", ref: "main" });
    const second = await loadTeamStack(withId(), { repo: "org-b/stacks", dir: "s", ref: "main" });
    expect([first.valid, second.valid]).toEqual([true, true]);
  });

  it("records a file the host reports as too big while reading it", async () => {
    const { client } = fakeHost({ [SHA_A]: catalogRepo("s") }, { main: SHA_A });
    const capped = {
      ...client,
      readFile: async (o: { path: string; maxBytes?: number }) => {
        if (o.path === "s/stack.json") throw new GitFileTooLarge(o.path, o.maxBytes!);
        return client.readFile(o as never);
      },
    } as GitHostClient;
    const loaded = await loadTeamStack(capped, { repo: "acme/stacks", dir: "s", ref: "main" });
    expect(loaded.valid).toBe(false);
    if (loaded.valid) return;
    expect(loaded.errors).toEqual([`stack.json is over ${TEAM_STACK_LIMITS.maxFileBytes} bytes`]);
  });

  it("throws when the ref does not exist, rather than recording a version", async () => {
    const { client } = fakeHost({}, {});
    await expect(loadTeamStack(client, { repo: "acme/stacks", dir: "", ref: "nope" })).rejects.toThrow(/not a branch, tag or commit/);
  });
});
