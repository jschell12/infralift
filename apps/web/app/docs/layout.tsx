import Link from "next/link";

import { CONTAINER, SiteFooter, SiteHeader } from "../site-chrome";

// Every .md under docs/ is rendered and publicly reachable (see lib/docs.ts),
// so anything not listed here is published but unlinked rather than private.
const NAV = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/connect-providers", label: "Granting access" },
  { href: "/docs/assessment-report", label: "Assessment report" },
  { href: "/docs/cost-scenarios", label: "Cost scenarios" },
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
      <SiteHeader />
      <div
        className={`${CONTAINER} grid gap-8 pt-8 pb-16 md:grid-cols-[200px_minmax(0,1fr)] md:gap-12`}
      >
        <nav aria-label="Documentation">
          <ul className="flex flex-wrap gap-x-5 border-b border-border pb-3 md:sticky md:top-6 md:flex-col md:border-b-0 md:pb-0">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-11 items-center text-[15px] text-muted hover:text-text"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="docs-article min-w-0">{children}</main>
      </div>
      <SiteFooter />
    </>
  );
}
