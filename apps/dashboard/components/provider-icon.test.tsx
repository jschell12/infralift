import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PROVIDERS } from "@infralift/shared";
import { CONNECTION_TYPES, TFC } from "../lib/connections";
import { PROVIDER_ICONS } from "../lib/provider-icons";
import { ProviderIcon, providerIconData } from "./provider-icon";

// Every connection type the dashboard can add, read from the same lists the
// type picker reads, so a new type without a mark fails here.
const ALL_TYPES = [...new Set([...CONNECTION_TYPES.map((t) => t.type), ...PROVIDERS, TFC])];

const render = (provider: string, size?: number) => renderToStaticMarkup(<ProviderIcon provider={provider} size={size} />);

/** The d attributes of the paths in a rendered icon. */
const pathData = (html: string) => [...html.matchAll(/<path [^>]*d="([^"]*)"/g)].map((m) => m[1]);

describe("provider icons", () => {
  it("covers every connection type", () => {
    expect(ALL_TYPES.length).toBeGreaterThanOrEqual(15);
    for (const type of ALL_TYPES) expect(providerIconData(type), type).not.toBeNull();
  });

  it("has no entry for a type the dashboard does not offer", () => {
    expect(Object.keys(PROVIDER_ICONS).sort()).toEqual([...ALL_TYPES].sort());
  });

  it.each(ALL_TYPES)("%s renders one decorative 24x24 svg in currentColor", (type) => {
    const html = render(type);
    expect(html).toMatch(/^<svg [^>]*viewBox="0 0 24 24"[^>]*>.*<\/svg>$/);
    expect(html.match(/<svg /g)).toHaveLength(1);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`data-provider-icon="${type}"`);
    expect(html).toContain("currentColor");
    // Monochrome: no color of its own, which would also escape the palette.
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|accent/i);
    // Not an empty svg either: at least one real path.
    const paths = pathData(html);
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(d, type).toMatch(/^[Mm][\d\s.,\-MmLlHhVvCcSsQqTtAaZz]+$/);
  });

  it("gives every mark a different drawing", () => {
    const drawings = ALL_TYPES.map((t) => pathData(render(t)).join("|"));
    expect(new Set(drawings).size).toBe(drawings.length);
  });

  it("draws initials, not a logo, where Simple Icons has none", () => {
    for (const type of ["aws", "azure", "heroku"]) {
      expect(providerIconData(type)?.source, type).toBe("drawn");
      expect(render(type), type).toContain("<rect");
    }
  });

  it("sizes in CSS pixels, 20 by default", () => {
    expect(render("aws")).toMatch(/width="20" height="20"/);
    expect(render("aws", 28)).toMatch(/width="28" height="28"/);
  });

  it("keeps the slot for a type it does not know, with no path inside", () => {
    const html = render("some-new-provider");
    expect(html).toContain('data-provider-icon="unknown"');
    expect(html).toContain("<rect");
    expect(pathData(html)).toEqual([]);
    expect(providerIconData("toString")).toBeNull();
  });
});
