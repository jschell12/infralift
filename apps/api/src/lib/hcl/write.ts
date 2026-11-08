// ---------------------------------------------------------------------------
// HCL writer: build Terraform files as data, then print them.
//
// Callers describe blocks and attributes; quoting, escaping and layout are
// done here once. Output matches `terraform fmt` (two-space indent, `=`
// aligned within a run of attributes), so a customer's formatter leaves
// generated files alone.
//
//   file([
//     comment("Managed by infralift."),
//     block("provider", ["digitalocean"], []),
//   ])
//
// Strings are escaped, including `${` and `%{`, so a value can never become
// an interpolation. Expressions (references, function calls) go in through
// expr(), which is printed as written and must come from trusted code.
// ---------------------------------------------------------------------------

export type Value = string | number | boolean | Expr | Value[] | { [key: string]: Value };

export interface Expr {
  kind: "expr";
  text: string;
}

export interface Attr {
  kind: "attr";
  name: string;
  value: Value;
}

export interface Block {
  kind: "block";
  type: string;
  labels: string[];
  body: Node[];
}

export interface Comment {
  kind: "comment";
  text: string;
}

export interface Blank {
  kind: "blank";
}

export type Node = Attr | Block | Comment | Blank;

export const expr = (text: string): Expr => ({ kind: "expr", text });
export const attr = (name: string, value: Value): Attr => ({ kind: "attr", name, value });
export const block = (type: string, labels: string[], body: Node[]): Block => ({ kind: "block", type, labels, body });
export const comment = (text: string): Comment => ({ kind: "comment", text });
export const blank: Blank = { kind: "blank" };

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A quoted HCL string. Newlines and control characters are escaped, and
 *  template sequences are doubled so they stay literal. */
export function quote(s: string): string {
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    // A function, not a string: in a replacement string "$$" means one "$".
    .replace(/\$\{/g, () => "$${")
    .replace(/%\{/g, () => "%%{");
  return `"${body}"`;
}

function isExpr(v: Value): v is Expr {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as Expr).kind === "expr";
}

function name(key: string): string {
  if (!IDENT.test(key)) throw new Error(`not an HCL identifier: ${JSON.stringify(key)}`);
  return key;
}

function value(v: Value, indent: string): string {
  if (typeof v === "string") return quote(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isExpr(v)) return v.text;
  if (Array.isArray(v)) return `[${v.map((x) => value(x, indent)).join(", ")}]`;
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const inner = `${indent}  `;
  const width = Math.max(...entries.map(([k]) => name(k).length));
  const lines = entries.map(([k, x]) => `${inner}${k.padEnd(width)} = ${value(x, inner)}`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function nodes(list: Node[], indent: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < list.length) {
    const n = list[i];
    if (n.kind === "attr") {
      // Consecutive single-line attributes align their `=`, as terraform fmt
      // does. An attribute whose value spans lines is not padded and splits
      // the run in two.
      let j = i;
      while (j < list.length && list[j].kind === "attr") j++;
      const run = (list.slice(i, j) as Attr[]).map((a) => ({ name: name(a.name), text: value(a.value, indent) }));
      let k = 0;
      while (k < run.length) {
        if (run[k].text.includes("\n")) {
          out.push(`${indent}${run[k].name} = ${run[k].text}`);
          k++;
          continue;
        }
        let m = k;
        while (m < run.length && !run[m].text.includes("\n")) m++;
        const width = Math.max(...run.slice(k, m).map((a) => a.name.length));
        for (const a of run.slice(k, m)) out.push(`${indent}${a.name.padEnd(width)} = ${a.text}`);
        k = m;
      }
      i = j;
      continue;
    }
    if (n.kind === "comment") {
      for (const line of n.text.split("\n")) out.push(`${indent}#${line ? ` ${line}` : ""}`);
    } else if (n.kind === "blank") {
      out.push("");
    } else {
      const head = [name(n.type), ...n.labels.map(quote)].join(" ");
      if (!n.body.length) out.push(`${indent}${head} {}`);
      else out.push(`${indent}${head} {`, ...nodes(n.body, `${indent}  `), `${indent}}`);
    }
    i++;
  }
  return out;
}

/** A whole file, ending in a newline. */
export function file(list: Node[]): string {
  return `${nodes(list, "").join("\n")}\n`;
}
