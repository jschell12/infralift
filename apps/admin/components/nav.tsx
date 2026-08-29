"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

const ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/leads", label: "Leads" },
  { href: "/communities", label: "Communities" },
  { href: "/report", label: "Report" },
  { href: "/scanner", label: "Scanner" },
] as const;

function Wordmark() {
  return (
    <a className="block text-lg font-bold text-text" href="/">
      infra<span className="text-accent">lift</span>
      <span className="ml-1 text-xs text-muted">admin</span>
    </a>
  );
}

function NavLinks({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        return (
          <a
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`block rounded-lg px-3 py-2.5 text-sm ${active ? "bg-bg text-text" : "text-muted hover:bg-bg hover:text-text"}`}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

/** Hamburger that morphs into a close cross. Stroke-only so it inherits
 *  the button's text colour. */
function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M5 5l12 12" />
          <path d="M17 5L5 17" />
        </>
      ) : (
        <>
          <path d="M3 6h16" />
          <path d="M3 11h16" />
          <path d="M3 16h16" />
        </>
      )}
    </svg>
  );
}

/**
 * Renders both shells: a sticky top bar with a collapsible menu below `md`,
 * and the persistent sidebar at `md` and up. Only one is ever visible.
 */
export function AdminNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "/";

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-surface md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Wordmark />
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="-mr-2 cursor-pointer rounded-lg border-0 bg-transparent p-2 text-muted hover:text-text"
          >
            <MenuIcon open={open} />
          </button>
        </div>
        {open ? (
          <div className="border-t border-border px-3 py-3">
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
          </div>
        ) : null}
      </header>

      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-surface px-4 py-6 md:flex">
        <div className="mb-6 px-3">
          <Wordmark />
        </div>
        <NavLinks pathname={pathname} />
      </aside>
    </>
  );
}
