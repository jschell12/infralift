import type { Metadata } from "next";
import "./globals.css";
import { SidebarNav } from "../components/sidebar-nav";

export const metadata: Metadata = {
  title: "infralift",
  description: "See what your infrastructure costs. See what it should cost.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="flex w-[210px] shrink-0 flex-col justify-between border-r border-border bg-surface px-4 py-6">
            <div>
              <a
                className="mb-7 block px-3 text-lg font-bold text-text"
                href="/"
              >
                infra<span className="text-accent">lift</span>
              </a>
              <SidebarNav />
            </div>
            <div className="px-3 text-xs text-muted">
              <div className="mb-1.5">Northwind Labs</div>
              <a
                href="https://infralift.dev"
                className="text-faint hover:text-text"
              >
                infralift.dev
              </a>
            </div>
          </aside>
          <main className="min-w-0 flex-1 max-w-[1000px] p-10">{children}</main>
        </div>
      </body>
    </html>
  );
}
