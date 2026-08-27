import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "infralift admin",
  description: "Internal admin dashboard for infralift.",
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
          <aside className="w-[220px] bg-surface border-r border-border px-4 py-6 flex-shrink-0 flex flex-col gap-1">
            <a className="block text-lg font-bold text-text mb-6" href="/">
              infra<span className="text-accent">lift</span>
              <span className="text-muted text-xs ml-1">admin</span>
            </a>
            <nav className="flex flex-col gap-1">
              <a href="/" className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-surface">
                Overview
              </a>
              <a href="/leads" className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-surface">
                Leads
              </a>
              <a href="/communities" className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-surface">
                Communities
              </a>
              <a href="/scanner" className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-surface">
                Scanner
              </a>
            </nav>
          </aside>
          <main className="flex-1 p-10 max-w-[1100px]">{children}</main>
        </div>
      </body>
    </html>
  );
}
