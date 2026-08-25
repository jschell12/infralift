import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "infralift dashboard",
  description: "Manage your infrastructure assessment and migration.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <a className="logo" href="/">
              infra<span>lift</span>
            </a>
            <nav>
              <a href="/">Overview</a>
              <a href="/connections">Provider connections</a>
              <a href="/assessments">Assessments</a>
              <a href="/migrations">Migration status</a>
              <a href="/terraform">Terraform generation</a>
              <a href="/workspaces">Workspaces</a>
              <a href="/standards">IaC standards</a>
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
