// ---------------------------------------------------------------------------
// A git object store in memory, with git's own hashing.
//
// Blobs, trees and commits get the SHA-1 git would give them, so the fake
// answers the questions infralift asks the way GitHub does: an identical tree
// has an identical sha (deliverChangeRequest's "nothing changed" check), and
// a blob's sha is git's blob id (what the GitLab client compares against).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export type FileMode = "100644" | "100755" | "120000" | "160000";
export interface TreeEntry {
  mode: FileMode | "040000";
  name: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}
export interface Commit {
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
}
export type GitObject =
  | { type: "blob"; content: Buffer }
  | { type: "tree"; entries: TreeEntry[] }
  | { type: "commit"; commit: Commit };

/** A file at a path, as a flattened tree lists it. */
export interface FlatFile {
  path: string;
  mode: FileMode;
  sha: string;
}

function gitHash(type: string, body: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest("hex");
}

/** git sorts tree entries by name, comparing a subtree as if it ended in "/". */
function treeOrder(a: TreeEntry, b: TreeEntry): number {
  const key = (e: TreeEntry) => (e.type === "tree" ? `${e.name}/` : e.name);
  return Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b)));
}

export class GitObjectStore {
  private readonly objects = new Map<string, GitObject>();

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  putBlob(content: Buffer): string {
    const sha = gitHash("blob", content);
    this.objects.set(sha, { type: "blob", content });
    return sha;
  }

  putTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort(treeOrder);
    const body = Buffer.concat(
      sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode === "040000" ? "40000" : e.mode} ${e.name}\0`), Buffer.from(e.sha, "hex")]))
    );
    const sha = gitHash("tree", body);
    this.objects.set(sha, { type: "tree", entries: sorted });
    return sha;
  }

  putCommit(commit: Commit): string {
    const seconds = Math.floor(new Date(commit.author.date).getTime() / 1000);
    const who = `${commit.author.name} <${commit.author.email}> ${seconds} +0000`;
    const text = [`tree ${commit.tree}`, ...commit.parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, "", commit.message].join("\n");
    const sha = gitHash("commit", Buffer.from(text));
    this.objects.set(sha, { type: "commit", commit });
    return sha;
  }

  blob(sha: string): Buffer | null {
    const o = this.objects.get(sha);
    return o?.type === "blob" ? o.content : null;
  }

  commit(sha: string): Commit | null {
    const o = this.objects.get(sha);
    return o?.type === "commit" ? o.commit : null;
  }

  tree(sha: string): TreeEntry[] | null {
    const o = this.objects.get(sha);
    return o?.type === "tree" ? o.entries : null;
  }

  /** Every file under a tree, with its full path. */
  flatten(treeSha: string, prefix = ""): FlatFile[] {
    const out: FlatFile[] = [];
    for (const e of this.tree(treeSha) ?? []) {
      const path = `${prefix}${e.name}`;
      if (e.type === "tree") out.push(...this.flatten(e.sha, `${path}/`));
      else out.push({ path, mode: e.mode as FileMode, sha: e.sha });
    }
    return out;
  }

  /** Every entry under a tree, subtrees included, as GitHub's recursive
   *  tree listing returns them. */
  walk(treeSha: string, prefix = ""): { path: string; entry: TreeEntry }[] {
    const out: { path: string; entry: TreeEntry }[] = [];
    for (const e of this.tree(treeSha) ?? []) {
      const path = `${prefix}${e.name}`;
      out.push({ path, entry: e });
      if (e.type === "tree") out.push(...this.walk(e.sha, `${path}/`));
    }
    return out;
  }

  /** A nested tree built from a flat list of files; returns the root sha. */
  buildTree(files: FlatFile[]): string {
    const here: TreeEntry[] = [];
    const dirs = new Map<string, FlatFile[]>();
    for (const f of files) {
      const slash = f.path.indexOf("/");
      if (slash === -1) {
        here.push({ mode: f.mode, name: f.path, type: f.mode === "160000" ? "commit" : "blob", sha: f.sha });
      } else {
        const dir = f.path.slice(0, slash);
        dirs.set(dir, [...(dirs.get(dir) ?? []), { ...f, path: f.path.slice(slash + 1) }]);
      }
    }
    for (const [name, inner] of dirs) here.push({ mode: "040000", name, type: "tree", sha: this.buildTree(inner) });
    return this.putTree(here);
  }

  /** The object at `path` under a tree, or null. */
  lookup(treeSha: string, path: string): TreeEntry | null {
    let entries = this.tree(treeSha);
    const parts = path.split("/").filter(Boolean);
    for (const [i, part] of parts.entries()) {
      const e = entries?.find((x) => x.name === part);
      if (!e) return null;
      if (i === parts.length - 1) return e;
      if (e.type !== "tree") return null;
      entries = this.tree(e.sha);
    }
    return null;
  }
}
