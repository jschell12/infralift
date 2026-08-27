import type { Metadata } from "next";
import "./globals.css";

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
          <aside className="w-[200px] bg-surface border-r border-border px-4 py-6 flex-shrink-0 flex flex-col justify-between">
            <div>
              <a
                className="block text-lg font-bold text-text mb-8 px-3"
                href="/"
              >
                infra<span className="text-accent">lift</span>
              </a>
              <nav className="flex flex-col gap-0.5">
                <a
                  href="/"
                  className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-bg"
                >
                  Dashboard
                </a>
                <a
                  href="/connections"
                  className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-bg"
                >
                  Connections
                </a>
                <a
                  href="/assessments"
                  className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-bg"
                >
                  Assessments
                </a>
                <a
                  href="/migrations"
                  className="block text-sm text-muted px-3 py-2 rounded-lg hover:text-text hover:bg-bg"
                >
                  Migrations
                </a>
              </nav>
            </div>
            <div className="px-3 text-xs text-muted">
              <a href="https://infralift.dev" className="hover:text-text">infralift.dev</a>
            </div>
          </aside>
          <main className="flex-1 p-8 md:p-10 max-w-[960px]">{children}</main>
        </div>
      </body>
    </html>
  );
}
