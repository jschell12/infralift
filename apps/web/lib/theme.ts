// Light or dark, chosen by the viewer's own clock.
//
// This file is copied byte for byte into apps/web, apps/dashboard and
// apps/admin. They are separate Next builds and the marketing site deploys on
// its own without building packages/shared, so a shared import would break
// that deploy. apps/web/lib/theme.test.ts fails if the copies drift.
//
// Three pieces use it:
//   - THEME_BOOT_SCRIPT runs inline in each root layout's <head>, before the
//     first paint, and sets <html data-theme>. It is built from the constants
//     below, and the test runs it against themeForHour for every hour.
//   - ThemeControl (the Auto / Light / Dark buttons) persists the override and,
//     in Auto, re-applies the theme at the next boundary and when a tab that
//     was left open becomes visible again.
//   - globals.css keys the palette on :root[data-theme], falling back to the
//     OS setting when the script never ran (JavaScript off).

export type Theme = "light" | "dark";
export type ThemeOverride = "auto" | Theme;

/**
 * Local hours that count as day. Light from 07:00 up to (not including)
 * 19:00, dark the rest of the time. "Local" is whatever timezone the browser
 * reports, because Date#getHours already reads it, so a viewer in Tokyo and
 * one in Connecticut each get their own daytime.
 */
export const DAYTIME_HOURS = { start: 7, end: 19 } as const;

/** localStorage key for the override. Absent or unrecognised means Auto. */
export const THEME_STORAGE_KEY = "infralift-theme";

export const THEME_OVERRIDES: readonly ThemeOverride[] = ["auto", "light", "dark"];

/** Anything that is not "light" or "dark" (null, junk, an old value) is Auto. */
export function parseOverride(raw: string | null | undefined): ThemeOverride {
  return raw === "light" || raw === "dark" ? raw : "auto";
}

/** The theme for a local hour (0-23), unless the viewer chose one. */
export function themeForHour(hour: number, override: ThemeOverride = "auto"): Theme {
  if (override !== "auto") return override;
  return hour >= DAYTIME_HOURS.start && hour < DAYTIME_HOURS.end ? "light" : "dark";
}

/**
 * Milliseconds from `now` until the next 07:00 or 19:00 local, whichever
 * comes first. Built with the Date setters, so a daylight-saving change in
 * between lands on the wall-clock hour rather than an hour off.
 */
export function msUntilNextBoundary(now: Date): number {
  const candidates = [DAYTIME_HOURS.start, DAYTIME_HOURS.end].flatMap((hour) => {
    const today = new Date(now);
    today.setHours(hour, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [today, tomorrow];
  });
  const next = Math.min(
    ...candidates.map((d) => d.getTime()).filter((t) => t > now.getTime()),
  );
  return next - now.getTime();
}

/**
 * Inline <head> script. Plain ES5 and wrapped in try/catch: if storage is
 * blocked it falls back to the clock, and if anything else throws it leaves
 * data-theme unset so the CSS falls back to the OS setting. Keep the logic
 * identical to parseOverride + themeForHour; the test enforces it.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var o=null;try{o=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}if(o!=="light"&&o!=="dark"){var h=new Date().getHours();o=h>=${DAYTIME_HOURS.start}&&h<${DAYTIME_HOURS.end}?"light":"dark"}document.documentElement.dataset.theme=o}catch(e){}})();`;

/** Reads the stored override. Storage can be blocked or throw; that is Auto. */
export function readStoredOverride(): ThemeOverride {
  try {
    return parseOverride(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

/** Saves the override (Auto removes the key). Silently does nothing if storage is blocked. */
export function writeStoredOverride(override: ThemeOverride): void {
  try {
    if (override === "auto") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, override);
  } catch {
    // Private windows and blocked site data: the choice lasts this page view.
  }
}

/** Sets <html data-theme> from the override and the current local hour. */
export function applyTheme(override: ThemeOverride, now: Date = new Date()): Theme {
  const theme = themeForHour(now.getHours(), override);
  document.documentElement.dataset.theme = theme;
  return theme;
}
