import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import {
  DAYTIME_HOURS,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  msUntilNextBoundary,
  parseOverride,
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

  it.each([
    ["web", "app/site-chrome.tsx"],
    ["dashboard", "components/sidebar-nav.tsx"],
    ["admin", "components/nav.tsx"],
  ])("%s renders the control in %s", (app, file) => {
    expect(read(`${app}/${file}`)).toMatch(/<ThemeControl\b/);
  });
});
