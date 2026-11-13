"use client";

// Auto / Light / Dark. Copied byte for byte into apps/dashboard and apps/admin
// (components/theme-control.tsx); apps/web/lib/theme.test.ts fails if the
// copies drift. The logic lives in ../lib/theme.ts.
//
// This only shows and saves the choice. ThemeClock, mounted in the root
// layout, hears the change and applies it, and keeps Auto on the clock on
// pages that have no control.

import { useEffect, useId, useState } from "react";

import {
  THEME_OVERRIDES,
  chooseOverride,
  readStoredOverride,
  subscribeToOverride,
  type ThemeOverride,
} from "../lib/theme";

const LABELS: Record<ThemeOverride, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
};

/**
 * `labelledBy` names an element that already labels the buttons, such as a
 * "Theme" heading on a settings page; the control then drops its own
 * visible "Theme" label rather than repeat it.
 */
export function ThemeControl({
  className = "",
  labelledBy,
}: {
  className?: string;
  labelledBy?: string;
}) {
  // null until mounted, so the server render and the first client render
  // match (neither can see localStorage). The page is already in the right
  // theme by then; only the pressed button catches up.
  const [override, setOverride] = useState<ThemeOverride | null>(null);
  const ownLabelId = useId();

  useEffect(() => {
    setOverride(readStoredOverride());
    return subscribeToOverride(setOverride);
  }, []);

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      {labelledBy ? null : (
        <span id={ownLabelId} className="text-muted">
          Theme
        </span>
      )}
      <div
        role="group"
        aria-labelledby={labelledBy ?? ownLabelId}
        className="inline-flex rounded-lg border border-border p-0.5"
      >
        {THEME_OVERRIDES.map((value) => {
          const pressed = override === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={pressed}
              title={value === "auto" ? "Light 07:00 to 19:00 your time, dark otherwise" : undefined}
              onClick={() => chooseOverride(value)}
              className={`min-h-11 min-w-11 cursor-pointer rounded-md border px-2.5 text-sm ${pressed ? "border-control bg-bg text-text" : "border-transparent bg-transparent text-muted hover:text-text active:bg-bg"}`}
            >
              {LABELS[value]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
