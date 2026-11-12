import { describe, expect, it } from "vitest";
import { trappedFocusTarget } from "./focus";

// Stand-ins for the Drawer's tabbable elements, in document order: the close
// button, a field, and the submit button.
const CLOSE = "close";
const FIELD = "field";
const SUBMIT = "submit";
const PANEL = "panel";
const ELEMENTS = [CLOSE, FIELD, SUBMIT];

describe("trappedFocusTarget keeps Tab inside the dialog", () => {
  it("wraps Tab from the last element to the first", () => {
    expect(trappedFocusTarget(ELEMENTS, SUBMIT, false)).toBe(CLOSE);
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    expect(trappedFocusTarget(ELEMENTS, CLOSE, true)).toBe(SUBMIT);
  });

  it("leaves Tab between inner elements to the browser", () => {
    expect(trappedFocusTarget(ELEMENTS, CLOSE, false)).toBeNull();
    expect(trappedFocusTarget(ELEMENTS, FIELD, true)).toBeNull();
  });

  it("sends focus on the panel itself (just opened) to the first or last element", () => {
    expect(trappedFocusTarget(ELEMENTS, PANEL, false)).toBe(CLOSE);
    expect(trappedFocusTarget(ELEMENTS, PANEL, true)).toBe(SUBMIT);
  });

  it("pulls focus that escaped behind the dialog back in", () => {
    expect(trappedFocusTarget(ELEMENTS, "page link", false)).toBe(CLOSE);
    expect(trappedFocusTarget(ELEMENTS, null, true)).toBe(SUBMIT);
  });

  it("wraps onto the only element when there is one", () => {
    expect(trappedFocusTarget([CLOSE], CLOSE, false)).toBe(CLOSE);
    expect(trappedFocusTarget([CLOSE], CLOSE, true)).toBe(CLOSE);
  });

  it("returns null with nothing tabbable, so the caller keeps focus on the panel", () => {
    expect(trappedFocusTarget([], PANEL, false)).toBeNull();
  });
});
