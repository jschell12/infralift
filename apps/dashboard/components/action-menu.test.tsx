import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionMenu } from "./action-menu";

// The closed button as it renders. Keyboard behaviour is lib/menu.ts, tested
// in lib/menu.test.ts; the open menu is exercised in a browser (see the PR).

const items = [
  { label: "Verify now", onSelect: () => {} },
  { label: "Replace credential", onSelect: () => {} },
  { label: "Remove", onSelect: () => {} },
];

describe("ActionMenu", () => {
  const html = renderToStaticMarkup(<ActionMenu label="Actions for AWS production" items={items} />);

  it("is a menu button named for the thing it acts on", () => {
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Actions for AWS production"');
  });

  it("is a 44px target with an icon hidden from screen readers", () => {
    expect(html).toContain("h-11 w-11");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("renders no menu until opened", () => {
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("Replace credential");
  });

  it("uses no accent color", () => {
    expect(html).not.toMatch(/accent/);
  });
});
