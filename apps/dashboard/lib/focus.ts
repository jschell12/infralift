/**
 * Focus trap for a modal dialog: where Tab (or Shift+Tab) should send focus,
 * or null to let the browser move it normally.
 *
 * `focusable` is the dialog's tabbable elements in document order. `active` is
 * whatever has focus now; when it is not one of them (the dialog panel itself,
 * or something behind the dialog) focus goes to the first element, or the last
 * for Shift+Tab. From the last element Tab wraps to the first, and from the
 * first Shift+Tab wraps to the last. Kept free of the DOM so it can be tested
 * without a browser; Drawer in components/ui.tsx is the caller.
 */
export function trappedFocusTarget<T>(
  focusable: readonly T[],
  active: T | null,
  backwards: boolean
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const index = active === null ? -1 : focusable.indexOf(active);
  if (index === -1) return backwards ? last : first;
  if (backwards && index === 0) return last;
  if (!backwards && index === focusable.length - 1) return first;
  return null;
}
