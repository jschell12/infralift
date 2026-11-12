"use client";

// Auto / Light / Dark. Copied byte for byte into apps/dashboard and apps/admin
// (components/theme-control.tsx); apps/web/lib/theme.test.ts fails if the
// copies drift. The logic lives in ../lib/theme.ts.
//
// The inline head script has already set <html data-theme> before this
// renders. This component only takes over afterwards: it saves a choice, and
// in Auto it keeps an open tab in step with the clock.

import { useEffect, useId, useState } from "react";

import {
  THEME_CHANGE_EVENT,
  THEME_OVERRIDES,
  THEME_STORAGE_KEY,
  applyTheme,
  msUntilNextBoundary,
  parseOverride,
  readStoredOverride,
  writeStoredOverride,
  type ThemeOverride,
} from "../lib/theme";

const LABELS: Record<ThemeOverride, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
};

export function ThemeControl({ className = "" }: { className?: string }) {
  // null until mounted, so the server render and the first client render
  // match (neither can see localStorage). The page is already in the right
  // theme by then; only the pressed button catches up. Nothing is applied
  // while it is null, or a stored Dark would flash to the clock's Light.
  const [override, setOverride] = useState<ThemeOverride | null>(null);
  const labelId = useId();

  useEffect(() => {
    setOverride(readStoredOverride());
    // Another tab changed the choice.
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setOverride(parseOverride(e.newValue));
    };
    // Another ThemeControl in this tab changed it (works with storage blocked).
    const onChange = (e: Event) => {
      setOverride(parseOverride((e as CustomEvent<string>).detail));
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    };
  }, []);

  useEffect(() => {
    if (override === null) return;
    applyTheme(override);
    if (override !== "auto") return;

    // In Auto, switch at the next 07:00 or 19:00, then schedule the one after.
    // Timers are paused or throttled in background tabs and across sleep, so
    // the visibility check is what actually catches a laptop opened at 08:00.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        applyTheme("auto");
        schedule();
      }, msUntilNextBoundary(new Date()) + 1000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") applyTheme("auto");
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [override]);

  const choose = (next: ThemeOverride) => {
    writeStoredOverride(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  };

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      <span id={labelId} className="text-muted">
        Theme
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
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
              onClick={() => choose(value)}
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
