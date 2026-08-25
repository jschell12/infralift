import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

// Docs live at the repo root; pages are statically generated at build time,
// so reading relative to the app's cwd during `next build` is safe.
const DOCS_DIR = path.join(process.cwd(), "..", "..", "docs");

export function listDocSlugs(): string[] {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export interface Doc {
  title: string;
  html: string;
}

export function readDoc(slug?: string): Doc | null {
  if (slug && !/^[a-z0-9-]+$/.test(slug)) return null;
  const file = path.join(DOCS_DIR, slug ? `${slug}.md` : "README.md");
  if (!fs.existsSync(file)) return null;

  let md = fs.readFileSync(file, "utf8");
  // Rewrite repo-relative markdown links to site routes.
  md = md
    .replace(/\]\(\.\/README\.md\)/g, "](/docs)")
    .replace(/\]\(\.\/([a-z0-9-]+)\.md\)/g, "](/docs/$1)")
    .replace(/\]\(docs\/README\.md\)/g, "](/docs)");

  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? "Documentation";
  const html = marked.parse(md, { async: false });
  return { title, html };
}
