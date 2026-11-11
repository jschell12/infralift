import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GitHostClient, TreeEntry } from "../git/hosts.js";
import { getStack, renderStack } from "./index.js";
import { checkManifest, isStackPath, loadTeamStack, selectStackEntries, TEAM_STACK_LIMITS } from "./team.js";

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

/** The catalog stack as a repository holding it at `dir`, with GitHub's tree
 *  entry shape (mode, type, size). */
function catalogRepo(dir: string) {
  const files = new Map<string, { content: string; mode: string }>();
  for (const full of walk(CATALOG)) {
    const path = relative(CATALOG, full).split(sep).join("/");
    files.set(`${dir}/${path}`, {
      content: readFileSync(full, "utf8"),
      mode: statSync(full).mode & 0o111 ? "100755" : "100644",
    });
  }
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

  it("accepts the catalog manifest as it is, with and without modules", () => {
    expect(checkManifest(catalog, paths)).toEqual([]);
    const withModules = {
      ...catalog,
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

  it("throws when the ref does not exist, rather than recording a version", async () => {
    const { client } = fakeHost({}, {});
    await expect(loadTeamStack(client, { repo: "acme/stacks", dir: "", ref: "nope" })).rejects.toThrow(/not a branch, tag or commit/);
  });
});
