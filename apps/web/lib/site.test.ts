import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { NAV_LINKS } from "../app/site-chrome";
import { ADOPTION_PROVIDERS, ASSESSED_PROVIDERS, listProviders } from "./providers";

// Guards for the marketing-site audit fixes. Each reads the real file it is
// about (the page source, the stylesheet, the _headers Cloudflare parses), so
// a regression in that file is what fails, not a copy of it.

const WEB = process.cwd();
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxUnder(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("provider list", () => {
  it("is the only source of the count", () => {
    // The home page once said "12 providers" over a list of eleven.
    const page = read("app/page.tsx");
    expect(page).toContain("{ASSESSED_PROVIDERS.length} providers");
    expect(page).not.toMatch(/\b\d+ providers\b/);
    expect(read("app/layout.tsx")).toContain("listProviders()");
  });

  it("does not offer AWS until production can connect it", () => {
    expect(ASSESSED_PROVIDERS as readonly string[]).not.toContain("AWS");
    expect(ADOPTION_PROVIDERS as readonly string[]).not.toContain("AWS");
  });

  it("lists in prose at both ends of the length range", () => {
    expect(listProviders(["A"])).toBe("A");
    expect(listProviders(["A", "B"])).toBe("A and B");
    expect(listProviders(["A", "B", "C"])).toBe("A, B, and C");
    expect(listProviders().split(", ").length).toBe(ASSESSED_PROVIDERS.length);
  });
});

describe("site header", () => {
  it("points every in-page link at an id the home page has", () => {
    const page = read("app/page.tsx");
    const anchors = NAV_LINKS.filter((l) => l.href.startsWith("/#"));
    expect(anchors.length).toBeGreaterThan(0);
    for (const l of anchors) {
      expect(page, l.href).toContain(`id="${l.href.slice(2)}"`);
    }
  });

  it("is the one header every page uses", () => {
    for (const p of ["app/page.tsx", "app/estimate/page.tsx", "app/leaving/[provider]/page.tsx", "app/docs/layout.tsx"]) {
      const src = read(p);
      expect(src, p).toContain("<SiteHeader />");
      expect(src, p).toContain("<SiteFooter />");
      expect(src, p).not.toMatch(/<header|<footer/);
    }
  });
});

describe("design tokens", () => {
  const css = read("app/globals.css");
  const token = (name: string) => {
    const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i"));
    if (!m) throw new Error(`no --color-${name}`);
    return m[1];
  };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("keeps small grey text at WCAG AA on both backgrounds", () => {
    for (const fg of ["faint", "muted"]) {
      for (const bg of ["bg", "surface"]) {
        expect(ratio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("has no purple accents or all-caps eyebrow labels", () => {
    expect(css).not.toMatch(/--color-(info|tag-heroku)/);
    for (const f of tsxUnder(join(WEB, "app"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\buppercase\b/);
    }
  });
});

describe("public/_headers", () => {
  const rules = read("public/_headers")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));

  it("caches hashed build output for a year, immutably", () => {
    const i = rules.indexOf("/_next/static/*");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(rules[i + 1].trim()).toBe("Cache-Control: public, max-age=31536000, immutable");
  });

  it("has no catch-all rule, which Cloudflare would comma-join onto the hashed assets", () => {
    const paths = rules.filter((l) => !/^\s/.test(l));
    expect(paths).toEqual(["/_next/static/*"]);
  });
});
