"use client";

// A "..." button that opens a short menu of actions, used where a row of
// buttons would crowd a tile (the connection tiles on /connections). The
// keyboard rules are in lib/menu.ts; this file wires them to the DOM:
// focus, click outside, and where the menu sits.

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { menuKey, type MenuState } from "../lib/menu";

export interface MenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

/** Three vertical dots, drawn rather than typed so they center optically. */
function KebabIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="3.5" r="1.6" />
      <circle cx="9" cy="9" r="1.6" />
      <circle cx="9" cy="14.5" r="1.6" />
    </svg>
  );
}

/**
 * `label` is the button's accessible name ("Actions for AWS production"),
 * also used to name the menu. Pass `buttonRef` to move focus back to the
 * button from outside, for example when an inline confirm is cancelled.
 *
 * The menu opens below the button, aligned to its right edge, so on a tile
 * pinned to the right of a phone screen it grows leftward and stays on screen.
 */
export function ActionMenu({
  label,
  items,
  buttonRef,
}: {
  label: string;
  items: MenuAction[];
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [state, setState] = useState<MenuState>({ open: false, active: -1 });
  const ownButton = useRef<HTMLButtonElement | null>(null);
  const button = buttonRef ?? ownButton;
  const wrapper = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  // Focus follows the active item while the menu is open.
  useEffect(() => {
    if (state.open && state.active >= 0) itemRefs.current[state.active]?.focus();
  }, [state]);

  // A press anywhere outside closes the menu, leaving focus where it lands.
  useEffect(() => {
    if (!state.open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setState({ open: false, active: -1 });
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [state.open]);

  function choose(index: number) {
    const item = items[index];
    setState({ open: false, active: -1 });
    // Focus goes back to the button before the action runs, so an action
    // that opens a drawer restores focus here when the drawer closes, and an
    // action that moves focus itself (an inline confirm) still can.
    button.current?.focus();
    if (item && !item.disabled) item.onSelect();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const next = menuKey(e.key, state, items.length);
    if (next.handled) e.preventDefault();
    if (next.choose) {
      choose(state.active);
      return;
    }
    setState({ open: next.open, active: next.active });
    if (next.focus === "button") button.current?.focus();
  }

  return (
    <div ref={wrapper} className="relative -mr-2 -mt-2 shrink-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={state.open}
        aria-controls={state.open ? menuId : undefined}
        aria-label={label}
        onClick={() => setState(state.open ? { open: false, active: -1 } : { open: true, active: 0 })}
        onKeyDown={onKeyDown}
        className={`flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:bg-bg hover:text-text active:bg-border ${FOCUS}`}
      >
        <KebabIcon />
      </button>
      {state.open && (
        <ul
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="absolute right-0 top-full z-30 mt-1 w-max min-w-44 max-w-[calc(100vw-32px)] rounded-lg border border-control bg-surface py-1"
        >
          {items.map((item, i) => (
            <li key={item.label} role="none">
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                onClick={() => choose(i)}
                onMouseEnter={() => setState({ open: true, active: i })}
                className={`flex min-h-11 w-full cursor-pointer items-center border-0 bg-transparent px-4 text-left text-sm text-text hover:bg-bg focus:bg-bg focus:outline-none active:bg-border aria-disabled:cursor-default aria-disabled:text-faint`}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
