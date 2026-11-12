"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { api } from "../lib/api";

const ITEMS = [
  { href: "/", label: "Dashboard", key: null },
  { href: "/projects", label: "Projects", key: null },
  { href: "/connections", label: "Connections", key: "connections" },
] as const;

function Wordmark() {
  return (
    <a className="block text-lg font-bold text-text" href="/">
      infra<span className="text-muted">lift</span>
    </a>
  );
}

export function SidebarNav({
  pathname,
  onNavigate,
}: {
  pathname?: string;
  onNavigate?: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    void (async () => {
      try {
        const c = await api<ProviderConnectionSummary[]>("/connections");
        setCounts({ connections: c.length });
      } catch {
        // sidebar counts are decorative; ignore auth/network errors
      }
    })();
  }, []);

  // usePathname is the same on the server and in the browser; reading
  // window.location here made the server render "/" as active on every page,
  // and React keeps the server's classes after a hydration mismatch.
  const routerPath = usePathname();
  const current = pathname ?? routerPath ?? "/";

  return (
    <nav className="flex flex-col gap-0.5">
      {ITEMS.map((item) => {
        const active =
          item.href === "/"
            ? current === "/"
            : current.startsWith(item.href);
        const count = item.key ? counts[item.key] : undefined;
        return (
          <a
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm ${active ? "bg-bg text-text" : "text-muted hover:bg-bg hover:text-text"}`}
          >
            <span>{item.label}</span>
            {count ? (
              <span className="ml-auto text-xs text-faint [font-variant-numeric:tabular-nums]">
                {count}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

/** Hamburger that morphs into a close cross. Stroke-only so it inherits the
 *  button's text colour. */
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
 * Both shells, ported from apps/admin's AdminNav: a sticky top bar with a
 * collapsible menu below `md`, and the persistent sidebar at `md` and up. Only
 * one is ever visible, so a phone never pays for a 210px column.
 */
export function AppNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-surface md:hidden">
        <div className="flex items-center justify-between px-4 py-1.5">
          <Wordmark />
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="app-nav-menu"
            onClick={() => setOpen((v) => !v)}
            className="-mr-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted hover:text-text active:bg-bg"
          >
            <MenuIcon open={open} />
          </button>
        </div>
        {open ? (
          <div id="app-nav-menu" className="border-t border-border px-3 py-3">
            <SidebarNav onNavigate={() => setOpen(false)} />
          </div>
        ) : null}
      </header>

      <aside className="hidden w-[210px] shrink-0 flex-col justify-between border-r border-border bg-surface px-4 py-6 md:flex">
        <div>
          <div className="mb-7 px-3">
            <Wordmark />
          </div>
          <SidebarNav />
        </div>
        <div className="px-3 text-xs">
          <a href="https://infralift.dev" className="text-faint hover:text-text">
            infralift.dev
          </a>
        </div>
      </aside>
    </>
  );
}
