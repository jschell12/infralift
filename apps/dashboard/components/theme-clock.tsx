"use client";

// Keeps the page's theme in step with the saved override and, in Auto, with
// the clock. Mounted once in each root layout so it runs on every page, with
// or without a ThemeControl on it. Copied byte for byte into apps/dashboard
// and apps/admin (components/theme-clock.tsx); apps/web/lib/theme.test.ts
// fails if the copies drift. The logic lives in ../lib/theme.ts.
//
// The inline head script has already set <html data-theme> before this
// renders, so it draws nothing and only takes over afterwards.

import { useEffect, useState } from "react";

import {
  applyTheme,
  readStoredOverride,
  startAutoThemeClock,
  subscribeToOverride,
  type ThemeOverride,
} from "../lib/theme";

export function ThemeClock() {
  // null until mounted: nothing is applied before storage has been read, or a
  // stored Dark would flash to the clock's Light.
  const [override, setOverride] = useState<ThemeOverride | null>(null);

  useEffect(() => {
    setOverride(readStoredOverride());
    return subscribeToOverride(setOverride);
  }, []);

  useEffect(() => {
    if (override === null) return;
    applyTheme(override);
    if (override !== "auto") return;
    return startAutoThemeClock();
  }, [override]);

  return null;
}
