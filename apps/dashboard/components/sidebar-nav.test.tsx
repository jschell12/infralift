import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppNav, SidebarNav } from "./sidebar-nav";
import SettingsPage from "../app/settings/page";

/** [label, aria-current] for each link, in order. */
function links(html: string): [string, boolean][] {
  return [...html.matchAll(/<a ([^>]*)><span>([^<]+)<\/span>/g)].map((m) => [
    m[2],
    m[1].includes('aria-current="page"'),
  ]);
}

describe("SidebarNav", () => {
  it("lists Settings fourth, after Dashboard, Projects and Connections", () => {
    const html = renderToStaticMarkup(<SidebarNav pathname="/" />);
    expect(links(html).map(([label]) => label)).toEqual([
      "Dashboard",
      "Projects",
      "Connections",
      "Settings",
    ]);
    expect(html).toContain('href="/settings"');
  });

  it.each([
    ["/settings", "Settings"],
    ["/", "Dashboard"],
    ["/projects", "Projects"],
    ["/connections", "Connections"],
  ])("on %s only %s is the current page", (pathname, expected) => {
    const active = links(renderToStaticMarkup(<SidebarNav pathname={pathname} />))
      .filter(([, current]) => current)
      .map(([label]) => label);
    expect(active).toEqual([expected]);
  });
});

describe("AppNav", () => {
  it("no longer carries the theme control", () => {
    const html = renderToStaticMarkup(<AppNav />);
    expect(html).toContain("Settings");
    expect(html).not.toMatch(/aria-pressed|>Auto<|>Theme</);
  });
});

describe("/settings", () => {
  const html = renderToStaticMarkup(<SettingsPage />);

  it("shows the theme control under a Theme heading that labels it", () => {
    expect(html).toMatch(/<h2 id="settings-theme"[^>]*>Theme<\/h2>/);
    expect(html).toContain('role="group" aria-labelledby="settings-theme"');
    for (const label of ["Auto", "Light", "Dark"]) expect(html).toContain(`>${label}</button>`);
  });

  it("explains Auto in one line and does not repeat the Theme label", () => {
    expect(html).toContain("light from 07:00 to 19:00");
    expect(html.match(/>Theme</g)).toHaveLength(1);
  });
});
