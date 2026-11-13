import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AdminNav } from "../components/nav";
import { ThemeClock } from "../components/theme-clock";
import { THEME_BOOT_SCRIPT } from "../lib/theme";

export const metadata: Metadata = {
  title: "infralift admin",
  description: "Internal admin dashboard for infralift.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets data-theme before the first paint so the page never flashes
            the wrong palette. Built from lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        {/* Keeps Auto on the clock on every page, control or not. */}
        <ThemeClock />
        {/* Column on phones (top bar over content), row on desktop (sidebar
            beside content). AdminNav renders whichever half is visible. */}
        <div className="flex min-h-screen flex-col md:flex-row">
          <AdminNav />
          <main className="min-w-0 max-w-full flex-1 p-4 md:max-w-[1100px] md:p-10">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
