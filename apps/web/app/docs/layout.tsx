import Link from "next/link";

const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ?? "http://localhost:3001";

const NAV = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/connect-providers", label: "Granting access" },
  { href: "/docs/assessment-report", label: "Assessment report" },
  { href: "/docs/migration-process", label: "Migration process" },
  { href: "/docs/security", label: "Security model" },
];

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="container">
        <nav className="nav">
          <Link href="/" className="logo">
            infra<span>lift</span>
          </Link>
          <div className="nav-links">
            <Link href="/">Home</Link>
            <a className="btn btn-primary" href={DASHBOARD_URL}>
              Start assessment
            </a>
          </div>
        </nav>
      </header>
      <div className="container docs-shell">
        <aside className="docs-sidebar">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </aside>
        <main className="docs-article">{children}</main>
      </div>
      <footer className="container footer">
        <div>© {new Date().getFullYear()} infralift</div>
        <div>Fixed-fee migrations, delivered as Terraform.</div>
      </footer>
    </>
  );
}
