import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The palette guard for all three apps. The marketing site, the dashboard and
// the admin app each carry the same tokens in their own globals.css (each is a
// separate Next build), so this reads the real files and checks two things:
// every text/background pair meets WCAG AA in both color schemes, and the
// accent stays on the primary action. It lives here because this is the one
// app whose tests already read stylesheets.

const APPS = join(process.cwd(), "..");
const APP_NAMES = ["web", "dashboard", "admin"] as const;

type Palette = Record<string, string>;

function block(css: string, opener: RegExp): string {
  const m = opener.exec(css);
  if (!m) throw new Error(`no block for ${opener}`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(start, i - 1);
}

function tokens(body: string): Palette {
  const out: Palette = {};
  for (const m of body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

function palettes(app: string): { css: string; dark: Palette; light: Palette } {
  const css = readFileSync(join(APPS, app, "app/globals.css"), "utf8");
  const dark = tokens(block(css, /@theme\s*\{/));
  const media = block(css, /@media\s*\(prefers-color-scheme:\s*light\)\s*\{/);
  const light = tokens(block(media, /:root\s*\{/));
  return { css, dark, light };
}

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground, background, minimum]. Text pairs are 4.5 (AA, small text);
// the button against the page and a form field's border are 3 (WCAG 1.4.11).
const PAIRS: [string, string, number][] = [
  ...["text", "muted", "faint", "warn", "danger"].flatMap((fg) =>
    ["bg", "surface"].map((bg) => [fg, bg, 4.5] as [string, string, number]),
  ),
  ["on-accent", "accent", 4.5],
  ["muted", "border", 4.5], // the muted chip
  ["warn", "warn-dim", 4.5],
  ["danger", "danger-dim", 4.5],
  ["text", "warn-dim", 4.5],
  ["text", "danger-dim", 4.5],
  ["accent", "bg", 3],
  ["accent", "surface", 3],
  ["control", "bg", 3],
  ["control", "surface", 3],
];

describe.each(APP_NAMES)("%s palette", (app) => {
  const { css, dark, light } = palettes(app);

  it("defines a light value for every dark token, and no others", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });

  it("is the same palette as the marketing site", () => {
    const web = palettes("web");
    expect(dark).toEqual(web.dark);
    expect(light).toEqual(web.light);
  });

  it("drops the indigo, purple, amber and second-red tokens", () => {
    expect(css).not.toMatch(/--color-(info|tag-heroku|tag-both|danger-bright)\b/);
  });

  it("tells native controls which scheme each mode is", () => {
    expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*dark/);
    const media = block(css, /@media\s*\(prefers-color-scheme:\s*light\)\s*\{/);
    expect(media).toMatch(/color-scheme:\s*light/);
  });

  for (const [mode, p] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    it.each(PAIRS)(`${mode}: %s on %s is at least %s:1`, (fg, bg, min) => {
      expect(p[fg], `--color-${fg}`).toBeDefined();
      expect(p[bg], `--color-${bg}`).toBeDefined();
      expect(ratio(p[fg], p[bg])).toBeGreaterThanOrEqual(min);
    });
  }
});

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "out") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("accent use in components", () => {
  const files = APP_NAMES.flatMap((app) =>
    ["app", "components", "lib"].flatMap((d) => {
      try {
        return sourcesUnder(join(APPS, app, d));
      } catch {
        return [];
      }
    }),
  );

  it("finds the sources it guards", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("uses the accent only as the fill of a primary button", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Accent text, borders, rings and tints are all non-primary uses.
      expect(src, f).not.toMatch(
        /\b(text|border|ring|outline|fill|stroke|from|to|via|decoration|divide|shadow)-accent\b/,
      );
      expect(src, f).not.toMatch(/\bbg-accent(-dim)?\//);
      expect(src, f).not.toMatch(/\bbg-accent-dim\b/);
      // Every accent fill carries the token made for text on it.
      for (const line of src.split("\n")) {
        if (/\bbg-accent\b/.test(line)) expect(line, f).toContain("text-on-accent");
      }
    }
  });

  it("no longer references the removed tokens", () => {
    for (const f of files) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /-(info|tag-heroku|tag-both|danger-bright)\b|tone[=:]\s*"(accent|info)"/,
      );
    }
  });

  it("has no hard-coded hex or rgb colors", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/(?<![&\w])#[0-9a-f]{6}\b|rgba?\(/i);
    }
  });
});
