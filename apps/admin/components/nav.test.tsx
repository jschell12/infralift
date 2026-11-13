import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminNav, NavLinks } from "./nav";
import SettingsPage from "../app/settings/page";

/** Labels of the links marked as the current page. */
function current(html: string): string[] {
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
}

describe("admin NavLinks", () => {
  it("ends with Settings, linking to /settings", () => {
    const html = renderToStaticMarkup(<NavLinks pathname="/" />);
    const labels = [...html.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(labels.at(-1)).toBe("Settings");
    expect(html).toContain('href="/settings"');
  });

  it.each([
    ["/settings", "Settings"],
    ["/", "Overview"],
    ["/analytics", "Analytics"],
  ])("on %s only %s is the current page", (pathname, expected) => {
    expect(current(renderToStaticMarkup(<NavLinks pathname={pathname} />))).toEqual([expected]);
  });
});

describe("AdminNav", () => {
  it("no longer carries the theme control", () => {
    const html = renderToStaticMarkup(<AdminNav />);
    expect(html).toContain("Settings");
    expect(html).not.toMatch(/aria-pressed|>Auto<|>Theme</);
  });
});

describe("admin /settings", () => {
  const html = renderToStaticMarkup(<SettingsPage />);

  it("shows the theme control under a Theme heading that labels it", () => {
    expect(html).toMatch(/<h2 id="settings-theme"[^>]*>Theme<\/h2>/);
    expect(html).toContain('role="group" aria-labelledby="settings-theme"');
    for (const label of ["Auto", "Light", "Dark"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("light from 07:00 to 19:00");
    expect(html.match(/>Theme</g)).toHaveLength(1);
  });
});
