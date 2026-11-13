import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import {
  DAYTIME_HOURS,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  chooseOverride,
  msUntilNextBoundary,
  parseOverride,
  startAutoThemeClock,
  subscribeToOverride,
  themeForHour,
  type Theme,
  type ThemeOverride,
} from "./theme";

const APPS = join(process.cwd(), "..");
const read = (p: string) => readFileSync(join(APPS, p), "utf8");

describe("themeForHour", () => {
  // [hour, override, expected]. The boundaries are the point: 07:00 is the
  // first light hour and 19:00 the first dark one.
  const CASES: [number, ThemeOverride, Theme][] = [
    [0, "auto", "dark"],
    [6, "auto", "dark"],
    [7, "auto", "light"],
    [12, "auto", "light"],
    [18, "auto", "light"],
    [19, "auto", "dark"],
    [23, "auto", "dark"],
    [12, "dark", "dark"],
    [3, "light", "light"],
    [7, "dark", "dark"],
    [19, "light", "light"],
  ];

  it.each(CASES)("hour %i with %s is %s", (hour, override, expected) => {
    expect(themeForHour(hour, override)).toBe(expected);
  });

  it("defaults to auto", () => {
    expect(themeForHour(12)).toBe("light");
    expect(themeForHour(2)).toBe("dark");
  });

  it("keeps the day window at 07:00 to 19:00", () => {
    expect(DAYTIME_HOURS).toEqual({ start: 7, end: 19 });
  });

  it("is light for exactly the twelve day hours", () => {
    const light = Array.from({ length: 24 }, (_, h) => themeForHour(h)).filter(
      (t) => t === "light",
    );
    expect(light).toHaveLength(12);
  });
});

describe("parseOverride", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["auto", "auto"],
    [null, "auto"],
    [undefined, "auto"],
    ["", "auto"],
    ["Dark", "auto"],
    ["system", "auto"],
  ] as const)("%j reads as %s", (raw, expected) => {
    expect(parseOverride(raw)).toBe(expected);
  });
});

describe("msUntilNextBoundary", () => {
  // Local times, built with the local-time Date constructor, so the cases
  // hold in whatever timezone the test runs in. 2026-03-03 and -04 are clear
  // of daylight-saving changes in every zone that has them.
  const at = (h: number, m = 0, s = 0, ms = 0) => new Date(2026, 2, 3, h, m, s, ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it.each([
    ["06:59 is one minute before 07:00", at(6, 59), MIN],
    ["07:00 waits for 19:00", at(7, 0), 12 * HOUR],
    ["18:59 is one minute before 19:00", at(18, 59), MIN],
    ["19:00 waits for tomorrow's 07:00", at(19, 0), 12 * HOUR],
    ["23:30 waits for tomorrow's 07:00", at(23, 30), 7.5 * HOUR],
    ["00:00 waits for 07:00", at(0, 0), 7 * HOUR],
    ["18:59:59.999 is one millisecond out", at(18, 59, 59, 999), 1],
  ] as const)("%s", (_label, now, expected) => {
    expect(msUntilNextBoundary(now)).toBe(expected);
  });

  it("lands on a boundary hour where the theme changes", () => {
    for (let h = 0; h < 24; h++) {
      const now = at(h, 17);
      const next = new Date(now.getTime() + msUntilNextBoundary(now));
      expect([7, 19]).toContain(next.getHours());
      expect(next.getMinutes()).toBe(0);
      expect(themeForHour(next.getHours())).not.toBe(themeForHour(now.getHours()));
    }
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  // Runs the real inline script in a bare context with a fake clock and
  // storage, and checks it reaches the same answer as themeForHour. This is
  // what keeps the head script and the module from drifting apart.
  function boot(hour: number, stored: string | null | "throws"): string | undefined {
    const dataset: Record<string, string> = {};
    const localStorage = {
      getItem(key: string) {
        if (stored === "throws") throw new Error("SecurityError");
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    };
    class FixedDate {
      getHours() {
        return hour;
      }
    }
    runInNewContext(THEME_BOOT_SCRIPT, {
      localStorage,
      Date: FixedDate,
      document: { documentElement: { dataset } },
    });
    return dataset.theme;
  }

  const STORED: (string | null)[] = [null, "light", "dark", "auto", "junk"];
  for (const stored of STORED) {
    it(`matches themeForHour for every hour with storage ${JSON.stringify(stored)}`, () => {
      for (let h = 0; h < 24; h++) {
        expect(boot(h, stored), `hour ${h}`).toBe(themeForHour(h, parseOverride(stored)));
      }
    });
  }

  it("falls back to the clock when storage throws", () => {
    expect(boot(6, "throws")).toBe("dark");
    expect(boot(7, "throws")).toBe("light");
    expect(boot(18, "throws")).toBe("light");
    expect(boot(19, "throws")).toBe("dark");
  });

  it("does not throw when the document is unusable (data-theme stays unset)", () => {
    expect(() =>
      runInNewContext(THEME_BOOT_SCRIPT, { localStorage: null, Date, document: null }),
    ).not.toThrow();
  });

  it("is in the head of each root layout, with hydration warnings suppressed", () => {
    for (const app of ["web", "dashboard", "admin"]) {
      const layout = read(`${app}/app/layout.tsx`);
      expect(layout, app).toContain('import { THEME_BOOT_SCRIPT } from "../lib/theme"');
      const head = /<head>([\s\S]*?)<\/head>/.exec(layout)?.[1] ?? "";
      expect(head, app).toContain("__html: THEME_BOOT_SCRIPT");
      expect(layout, app).toMatch(/<html lang="en" suppressHydrationWarning>/);
    }
  });
});

describe("copies across apps", () => {
  // Three separate Next builds; the marketing site deploys without building
  // packages/shared. So the files are copied, and this keeps them identical.
  it.each(["dashboard", "admin"])("%s/lib/theme.ts is the same as web's", (app) => {
    expect(read(`${app}/lib/theme.ts`)).toBe(read("web/lib/theme.ts"));
  });

  it.each(["dashboard", "admin"])(
    "%s/components/theme-control.tsx is the same as web's",
    (app) => {
      expect(read(`${app}/components/theme-control.tsx`)).toBe(
        read("web/app/theme-control.tsx"),
      );
    },
  );

  it.each(["dashboard", "admin"])(
    "%s/components/theme-clock.tsx is the same as web's",
    (app) => {
      expect(read(`${app}/components/theme-clock.tsx`)).toBe(read("web/app/theme-clock.tsx"));
    },
  );

  // One control per page: the marketing footer, and /settings in the
  // dashboard and admin. The sidebars no longer carry one.
  it.each([
    ["web", "app/site-chrome.tsx"],
    ["dashboard", "app/settings/page.tsx"],
    ["admin", "app/settings/page.tsx"],
  ])("%s renders the control in %s", (app, file) => {
    expect(read(`${app}/${file}`)).toMatch(/<ThemeControl\b/);
  });

  it.each([
    ["dashboard", "components/sidebar-nav.tsx"],
    ["admin", "components/nav.tsx"],
  ])("%s does not render the control in %s", (app, file) => {
    expect(read(`${app}/${file}`)).not.toMatch(/ThemeControl/);
  });

  // The clock has to run on pages with no control, so it lives in the layout.
  it.each(["web", "dashboard", "admin"])("%s mounts ThemeClock in its root layout", (app) => {
    const body = /<body>([\s\S]*?)<\/body>/.exec(read(`${app}/app/layout.tsx`))?.[1] ?? "";
    expect(body, app).toMatch(/<ThemeClock \/>/);
  });
});

describe("startAutoThemeClock (no ThemeControl involved)", () => {
  // A stand-in document: just what applyTheme and the clock touch. The clock
  // is started on its own here, the way ThemeClock starts it on a page that
  // has no control.
  function fakeDocument() {
    const target = new EventTarget();
    return Object.assign(target, {
      documentElement: { dataset: {} as Record<string, string> },
      visibilityState: "visible" as DocumentVisibilityState,
    });
  }
  const at = (d: number, h: number, m = 0) => new Date(2026, 2, d, h, m, 0, 0);

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("switches to dark just after 19:00 and back to light just after 07:00", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(3, 18, 59));
    const doc = fakeDocument();
    doc.documentElement.dataset.theme = "light";
    vi.stubGlobal("document", doc);

    const stop = startAutoThemeClock();
    vi.advanceTimersByTime(59_000);
    expect(doc.documentElement.dataset.theme, "18:59:59 is still day").toBe("light");
    vi.advanceTimersByTime(2_000);
    expect(doc.documentElement.dataset.theme, "19:00:01").toBe("dark");

    // It rescheduled itself: the next boundary is tomorrow's 07:00.
    vi.advanceTimersByTime(12 * 3_600_000 - 2_000);
    expect(doc.documentElement.dataset.theme, "06:59:59 next day").toBe("dark");
    vi.advanceTimersByTime(2_000);
    expect(doc.documentElement.dataset.theme, "07:00:01 next day").toBe("light");
    stop();
  });

  it("stops switching once cleaned up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(3, 18, 59));
    const doc = fakeDocument();
    doc.documentElement.dataset.theme = "light";
    vi.stubGlobal("document", doc);

    const stop = startAutoThemeClock();
    stop();
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(doc.documentElement.dataset.theme).toBe("light");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up when a tab left open becomes visible, even if no timer fired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(3, 23));
    const doc = fakeDocument();
    doc.documentElement.dataset.theme = "dark";
    vi.stubGlobal("document", doc);

    const stop = startAutoThemeClock();
    // A laptop opened at 08:00: the clock moved, the timer did not run.
    vi.setSystemTime(at(4, 8));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(doc.documentElement.dataset.theme, "hidden tabs are left alone").toBe("dark");
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(doc.documentElement.dataset.theme).toBe("light");
    stop();
  });
});

describe("chooseOverride and subscribeToOverride", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeWindow(storage: Map<string, string> | "throws") {
    const target = new EventTarget();
    const localStorage = {
      getItem: (k: string) => (storage === "throws" ? fail() : (storage.get(k) ?? null)),
      setItem: (k: string, v: string) => (storage === "throws" ? fail() : storage.set(k, v)),
      removeItem: (k: string) => (storage === "throws" ? fail() : storage.delete(k)),
    };
    function fail(): never {
      throw new Error("SecurityError");
    }
    return Object.assign(target, { localStorage });
  }

  it("delivers a choice made in this tab and saves it", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", fakeWindow(storage));
    const seen: ThemeOverride[] = [];
    const unsubscribe = subscribeToOverride((o) => seen.push(o));

    chooseOverride("dark");
    chooseOverride("auto");
    expect(seen).toEqual(["dark", "auto"]);
    expect(storage.has(THEME_STORAGE_KEY), "Auto removes the key").toBe(false);

    unsubscribe();
    chooseOverride("light");
    expect(seen).toEqual(["dark", "auto"]);
    expect(storage.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("still delivers the choice when storage is blocked", () => {
    vi.stubGlobal("window", fakeWindow("throws"));
    const seen: ThemeOverride[] = [];
    subscribeToOverride((o) => seen.push(o));
    chooseOverride("dark");
    expect(seen).toEqual(["dark"]);
  });

  it("hears another tab through the storage event, and only for its own key", () => {
    const win = fakeWindow(new Map());
    vi.stubGlobal("window", win);
    const seen: ThemeOverride[] = [];
    subscribeToOverride((o) => seen.push(o));
    const storageEvent = (key: string, newValue: string | null) =>
      Object.assign(new Event("storage"), { key, newValue });

    win.dispatchEvent(storageEvent("something-else", "dark"));
    win.dispatchEvent(storageEvent(THEME_STORAGE_KEY, "dark"));
    win.dispatchEvent(storageEvent(THEME_STORAGE_KEY, null));
    expect(seen).toEqual(["dark", "auto"]);
  });
});
