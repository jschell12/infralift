import Link from "next/link";

import { LEAVING_PAGES } from "../lib/leaving";
import { DASHBOARD_URL } from "../lib/links";
import { ThemeControl } from "./theme-control";

// One header and footer for every page. Home, the estimator, the leaving pages
// and the docs each had their own copy, and the docs copy used class names no
// stylesheet defined, so it rendered as bare links.

export const CONTAINER = "max-w-[1080px] mx-auto px-4 sm:px-6";

// Anchors are written as "/#id" so they work from any page, and on the home
// page they scroll in place. site-chrome.test.ts checks each id exists there.
export const NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#migrations", label: "Migrations" },
  { href: "/#faq", label: "FAQ" },
  { href: "/estimate", label: "Estimator" },
  { href: "/docs", label: "Docs" },
];

const CTA =
  "inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-[15px] font-semibold text-on-accent hover:brightness-95 active:brightness-90";
const NAV_LINK =
  "inline-flex min-h-11 items-center text-[15px] text-muted hover:text-text";

export function SiteHeader() {
  return (
    <header className={CONTAINER}>
      <nav
        aria-label="Main"
        className="relative flex items-center justify-between gap-4 py-3"
      >
        <Link
          href="/"
          className="inline-flex min-h-11 items-center text-xl font-bold tracking-[-0.02em] text-text"
        >
          infra<span className="text-muted">lift</span>
        </Link>
        <div className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={NAV_LINK}>
              {l.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <a className={CTA} href={DASHBOARD_URL}>
            Free assessment
          </a>
          {/* A native disclosure: opens and closes with no JavaScript, and is
              keyboard and screen-reader operable as it stands. */}
          <details className="group md:hidden">
            <summary className="inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-border px-3 text-[15px] text-text [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Menu</span>
              <span className="hidden group-open:inline">Close</span>
            </summary>
            <div className="absolute inset-x-0 top-full z-10 grid rounded-xl border border-border bg-surface p-2 shadow-lg">
              {NAV_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="flex min-h-11 items-center rounded-lg px-3 text-base text-text hover:bg-bg"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}

const FOOT_LINK = "inline-flex min-h-11 items-center text-muted hover:text-text";

export function SiteFooter() {
  return (
    <footer className={`${CONTAINER} border-t border-border py-10 text-sm`}>
      <div className="grid gap-8 sm:grid-cols-3">
        <div>
          <div className="font-semibold text-text">infralift</div>
          <p className="mt-2 text-muted">
            Click-ops infrastructure, brought under Terraform and managed as
            code.
          </p>
        </div>
        <div>
          <h2 className="font-semibold text-text">Product</h2>
          <ul className="mt-1">
            <li><Link className={FOOT_LINK} href="/docs">Docs</Link></li>
            <li><Link className={FOOT_LINK} href="/#pricing">Pricing</Link></li>
            <li><Link className={FOOT_LINK} href="/estimate">Cost estimator</Link></li>
            <li><Link className={FOOT_LINK} href="/docs/security">Security model</Link></li>
            <li>
              <a className={FOOT_LINK} href="mailto:security@infralift.dev">
                security@infralift.dev
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h2 className="font-semibold text-text">Cost breakdowns</h2>
          <ul className="mt-1">
            {LEAVING_PAGES.map((p) => (
              <li key={p.slug}>
                <Link className={FOOT_LINK} href={`/leaving/${p.slug}`}>
                  Leaving {p.provider}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted">&copy; {new Date().getFullYear()} infralift</p>
        <ThemeControl />
      </div>
    </footer>
  );
}
