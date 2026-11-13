// Keyboard behaviour of an actions menu (components/action-menu.tsx), as the
// WAI-ARIA menu button pattern describes it. Kept free of the DOM so it can be
// tested without a browser, the way lib/focus.ts keeps the drawer's focus trap.
//
//   on the button, closed   Enter, Space, ArrowDown open on the first item;
//                           ArrowUp opens on the last
//   in the open menu        ArrowDown / ArrowUp move, wrapping; Home / End jump;
//                           Enter / Space choose the item and close;
//                           Escape closes and returns focus to the button;
//                           Tab closes and lets focus move on as usual
//
// A disabled item can be focused (so it is read out) but not chosen.

export interface MenuState {
  open: boolean;
  /** The focused item while open; -1 when closed. */
  active: number;
}

export interface MenuStep extends MenuState {
  /** Where focus goes after this key: the button, the active item, or
   *  nowhere in particular (leave it to the browser). */
  focus: "button" | "item" | null;
  /** Choose the active item. */
  choose: boolean;
  /** Call preventDefault: the key was handled here. */
  handled: boolean;
}

const CLOSED: MenuState = { open: false, active: -1 };

function step(state: MenuState, focus: MenuStep["focus"], choose = false, handled = true): MenuStep {
  return { ...state, focus, choose, handled };
}

export function menuKey(key: string, state: MenuState, itemCount: number): MenuStep {
  if (itemCount === 0) return step(state, null, false, false);
  const last = itemCount - 1;

  if (!state.open) {
    if (key === "Enter" || key === " " || key === "ArrowDown") return step({ open: true, active: 0 }, "item");
    if (key === "ArrowUp") return step({ open: true, active: last }, "item");
    return step(state, null, false, false);
  }

  switch (key) {
    case "ArrowDown":
      return step({ open: true, active: state.active >= last ? 0 : state.active + 1 }, "item");
    case "ArrowUp":
      return step({ open: true, active: state.active <= 0 ? last : state.active - 1 }, "item");
    case "Home":
      return step({ open: true, active: 0 }, "item");
    case "End":
      return step({ open: true, active: last }, "item");
    case "Escape":
      return step(CLOSED, "button");
    case "Tab":
      // Close, but let Tab move focus on from the button as it would anyway.
      return step(CLOSED, null, false, false);
    case "Enter":
    case " ":
      return step(CLOSED, "button", true);
    default:
      return step(state, null, false, false);
  }
}
