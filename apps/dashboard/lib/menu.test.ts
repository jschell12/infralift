import { describe, expect, it } from "vitest";
import { menuKey, type MenuState } from "./menu";

const closed: MenuState = { open: false, active: -1 };
const at = (active: number): MenuState => ({ open: true, active });

// Verify now, Replace credential, Remove.
const N = 3;

describe("menuKey on the closed button", () => {
  it.each(["Enter", " ", "ArrowDown"])("%j opens on the first item and focuses it", (key) => {
    expect(menuKey(key, closed, N)).toEqual({ open: true, active: 0, focus: "item", choose: false, handled: true });
  });

  it("ArrowUp opens on the last item", () => {
    expect(menuKey("ArrowUp", closed, N)).toMatchObject({ open: true, active: 2, focus: "item" });
  });

  it("leaves every other key to the browser", () => {
    expect(menuKey("Tab", closed, N)).toMatchObject({ open: false, handled: false, focus: null });
    expect(menuKey("a", closed, N)).toMatchObject({ open: false, handled: false });
  });
});

describe("menuKey in the open menu", () => {
  it("moves with the arrows and wraps at both ends", () => {
    expect(menuKey("ArrowDown", at(0), N)).toMatchObject({ active: 1, focus: "item", handled: true });
    expect(menuKey("ArrowDown", at(2), N)).toMatchObject({ active: 0 });
    expect(menuKey("ArrowUp", at(1), N)).toMatchObject({ active: 0 });
    expect(menuKey("ArrowUp", at(0), N)).toMatchObject({ active: 2 });
  });

  it("jumps with Home and End", () => {
    expect(menuKey("Home", at(2), N)).toMatchObject({ active: 0, open: true });
    expect(menuKey("End", at(0), N)).toMatchObject({ active: 2, open: true });
  });

  it("Escape closes and sends focus back to the button", () => {
    expect(menuKey("Escape", at(1), N)).toEqual({ open: false, active: -1, focus: "button", choose: false, handled: true });
  });

  it.each(["Enter", " "])("%j chooses the active item, closes, and returns focus to the button", (key) => {
    expect(menuKey(key, at(2), N)).toEqual({ open: false, active: -1, focus: "button", choose: true, handled: true });
  });

  it("Tab closes without taking over the focus move", () => {
    expect(menuKey("Tab", at(1), N)).toEqual({ open: false, active: -1, focus: null, choose: false, handled: false });
  });

  it("ignores letters", () => {
    expect(menuKey("x", at(1), N)).toMatchObject({ open: true, active: 1, handled: false });
  });
});

describe("menuKey with no items", () => {
  it("does nothing", () => {
    expect(menuKey("Enter", closed, 0)).toMatchObject({ open: false, handled: false });
  });
});
