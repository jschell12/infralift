"use client";

import { ThemeControl } from "../../components/theme-control";
import { H1, LEAD } from "../../components/ui";

// The one page that shows the theme control. Auto keeps switching on every
// other page too, because ThemeClock in the root layout does the switching.
export default function SettingsPage() {
  return (
    <div>
      <h1 className={H1}>Settings</h1>
      <p className={LEAD}>Preferences for this browser.</p>

      <section aria-labelledby="settings-theme">
        <h2 id="settings-theme" className="mb-1 text-base font-semibold">
          Theme
        </h2>
        <p className="mb-3 max-w-[640px] text-sm text-muted">
          Auto follows your local clock: light from 07:00 to 19:00, dark the rest of the time.
        </p>
        <ThemeControl labelledBy="settings-theme" />
      </section>
    </div>
  );
}
