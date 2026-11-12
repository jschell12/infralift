import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnmanagedResource } from "@infralift/shared";
import { groupByType, resourceKey } from "../lib/adopt-account";
import { UnmanagedPicker } from "./unmanaged-picker";

// Rows from lib/__fixtures__/unmanaged-api.json (the API's real answer over
// the Cloudflare connector fixture; see its _source).
const fx = JSON.parse(readFileSync(new URL("../lib/__fixtures__/unmanaged-api.json", import.meta.url), "utf8")) as {
  full: { body: { resources: UnmanagedResource[] } };
  refusedRows: UnmanagedResource[];
};
const rows = [...fx.full.body.resources, ...fx.refusedRows];
const noop = () => {};
const render = (selected: Set<string> = new Set()) =>
  renderToStaticMarkup(<UnmanagedPicker groups={groupByType(rows)} selected={selected} onToggle={noop} onToggleGroup={noop} />);

describe("UnmanagedPicker", () => {
  it("shows each type as its own tile with name, provider id and Terraform type", () => {
    const html = render();
    expect(html.match(/<li class="bg-surface/g)).toHaveLength(5);
    expect(html).toContain("353c0d2783a8ac9da8fece4f501e320c");
    expect(html).toContain("cloudflare_r2_bucket");
  });

  it("disables a resource that cannot be adopted and says why, and no adoptable row carries a reason", () => {
    const html = render();
    expect(html).toContain("no Terraform import mapping for this kind yet");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html.match(/Can&#x27;t adopt yet/g)).toHaveLength(2);
    // A type with nothing adoptable gets no select-all.
    expect(html.match(/Select all/g)).toHaveLength(3);
  });

  it("checks picked rows and counts them in the group's select-all", () => {
    const zone = fx.full.body.resources.find((r) => r.type === "cloudflare:zone")!;
    const html = render(new Set([resourceKey(zone)]));
    expect(html).toContain("Select all 2 (1 selected)");
    expect(html.match(/checked=""/g)).toHaveLength(1);
    // Mixed is the indeterminate property, set after mount; a native checkbox
    // carries no aria-checked.
    expect(html).not.toContain("aria-checked");
  });

  it("heads each tile with the type's name, not its inventory id", () => {
    const html = render();
    const headings = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(headings).toEqual(["DNS records", "Load balancers", "R2 buckets", "Workers", "Zones"]);
    expect(html).not.toMatch(/cloudflare:[a-z_]+/);
  });

  it("names each tile's list by its heading, and not the tile's list item too", () => {
    const html = render();
    expect(html.match(/<li[^>]*aria-labelledby/g)).toBeNull();
    expect(html.match(/<ul aria-labelledby/g)).toHaveLength(5);
  });
});
