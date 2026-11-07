// ---------------------------------------------------------------------------
// Just enough HCL to read the structure of a customer's Terraform: blocks with
// their labels and bodies, and attributes with their raw expression text (and
// the string value when the expression is a plain string literal).
//
// It is not an evaluator. Interpolations, function calls and references are
// kept as raw text, which is all an import scan needs: where state lives, which
// providers are pinned, and how many resources each directory declares.
// ---------------------------------------------------------------------------

export interface HclAttr {
  raw: string;
  /** Set when the whole expression is one string literal with no interpolation. */
  str?: string;
}

export interface HclBlock {
  type: string;
  labels: string[];
  body: HclBody;
}

export interface HclBody {
  attrs: Record<string, HclAttr>;
  blocks: HclBlock[];
}

export class HclParseError extends Error {}

const IDENT = /[A-Za-z_][A-Za-z0-9_-]*/y;

export function parseHcl(src: string): HclBody {
  const p = new Parser(src);
  const body = p.body(false);
  return body;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  body(nested: boolean): HclBody {
    const out: HclBody = { attrs: {}, blocks: [] };
    for (;;) {
      this.skipSpaceAndComments(true);
      if (this.i >= this.s.length) {
        if (nested) throw new HclParseError("unexpected end of file inside a block");
        return out;
      }
      const c = this.s[this.i];
      if (c === "}") {
        if (!nested) throw new HclParseError(`unexpected } at offset ${this.i}`);
        this.i++;
        return out;
      }
      const name = this.ident();
      if (!name) throw new HclParseError(`expected a name at offset ${this.i}`);
      this.skipSpaceAndComments(false);
      if (this.s[this.i] === "=" && this.s[this.i + 1] !== "=") {
        this.i++;
        const raw = this.expression().trim();
        out.attrs[name] = { raw, ...stringLiteral(raw) };
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        this.skipSpaceAndComments(false);
        const ch = this.s[this.i];
        if (ch === "{") {
          this.i++;
          out.blocks.push({ type: name, labels, body: this.body(true) });
          break;
        }
        if (ch === '"') {
          const start = this.i;
          this.skipString();
          const lit = stringLiteral(this.s.slice(start, this.i));
          labels.push(lit.str ?? this.s.slice(start + 1, this.i - 1));
          continue;
        }
        const label = this.ident();
        if (label) {
          labels.push(label);
          continue;
        }
        throw new HclParseError(`expected = or { after "${name}" at offset ${this.i}`);
      }
    }
  }

  ident(): string | null {
    IDENT.lastIndex = this.i;
    const m = IDENT.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  /** Skips whitespace and comments, and newlines too when `newlines` is set. */
  skipSpaceAndComments(newlines: boolean) {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) {
        this.i++;
      } else if (c === "#" || (c === "/" && s[this.i + 1] === "/")) {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
      } else {
        return;
      }
    }
  }

  /** Raw text of an attribute's expression, comments removed: up to the
   *  newline (or the enclosing block's closing brace) at bracket depth zero. */
  expression(): string {
    const s = this.s;
    let raw = "";
    let seg = this.i;
    let depth = 0;
    const take = () => {
      raw += s.slice(seg, this.i);
    };
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        this.skipString();
        continue;
      }
      if (c === "<" && s[this.i + 1] === "<" && /[-A-Za-z_]/.test(s[this.i + 2] ?? "")) {
        if (this.skipHeredoc()) continue;
      }
      if (c === "#" || (c === "/" && (s[this.i + 1] === "/" || s[this.i + 1] === "*"))) {
        take();
        this.skipSpaceAndComments(false);
        seg = this.i;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) {
          take(); // stop before the block's own }
          return raw;
        }
        depth--;
      } else if (c === "\n" && depth === 0) {
        take();
        this.i++;
        seg = this.i;
        // A trailing operator continues the expression on the next line.
        if (/(\?|:|&&|\|\||[-+*/%,=<>!])\s*$/.test(raw)) {
          raw += "\n";
          continue;
        }
        return raw;
      }
      this.i++;
    }
    take();
    return raw;
  }

  skipString() {
    const s = this.s;
    this.i++; // opening quote
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "\\") {
        this.i += 2;
      } else if (c === '"') {
        this.i++;
        return;
      } else if ((c === "$" || c === "%") && s[this.i + 1] === "{") {
        this.i += 2;
        this.skipTemplate();
      } else if (c === "\n") {
        throw new HclParseError(`unterminated string at offset ${this.i}`);
      } else {
        this.i++;
      }
    }
    throw new HclParseError("unterminated string at end of file");
  }

  /** Inside ${ ... }: balanced braces, nested strings. */
  skipTemplate() {
    const s = this.s;
    let depth = 1;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        this.skipString();
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        this.i++;
        return;
      }
      this.i++;
    }
  }

  /** <<EOF or <<-EOF through the closing marker line. False if not a heredoc. */
  skipHeredoc(): boolean {
    const m = /<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/y;
    m.lastIndex = this.i;
    const hit = m.exec(this.s);
    if (!hit) return false;
    const marker = hit[1];
    const close = new RegExp(`^[ \\t]*${marker}[ \\t]*$`, "m");
    const rest = this.s.slice(this.i + hit[0].length);
    const end = close.exec(rest);
    this.i = end ? this.i + hit[0].length + end.index + end[0].length : this.s.length;
    return true;
  }
}

function stringLiteral(raw: string): { str?: string } {
  if (!/^"(?:[^"\\$%]|\\.|\$(?!\{)|%(?!\{))*"$/.test(raw)) return {};
  try {
    return { str: JSON.parse(raw) as string };
  } catch {
    return {};
  }
}
