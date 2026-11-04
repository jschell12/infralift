"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type {
  AssessmentSummary,
  MigrationSummary,
  ProviderConnectionSummary,
} from "@infralift/shared";
import { api } from "../lib/api";

const ITEMS = [
  { href: "/", label: "Dashboard", key: null },
  { href: "/projects", label: "Projects", key: null },
  { href: "/connections", label: "Connections", key: "connections" },
  { href: "/assessments", label: "Assessments", key: "assessments" },
  { href: "/migrations", label: "Migrations", key: "migrations" },
] as const;

export function SidebarNav({ pathname }: { pathname?: string }) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    void (async () => {
      try {
        const [c, a, m] = await Promise.all([
          api<ProviderConnectionSummary[]>("/connections"),
          api<AssessmentSummary[]>("/assessments"),
          api<MigrationSummary[]>("/migrations"),
        ]);
        setCounts({
          connections: c.length,
          assessments: a.filter((x) => x.status === "completed").length,
          migrations: m.filter((x) => x.status !== "cancelled").length,
        });
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
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-bg text-text" : "text-muted hover:bg-bg hover:text-text"}`}
          >
            <span>{item.label}</span>
            {count ? (
              <span className="ml-auto text-[11px] text-faint [font-variant-numeric:tabular-nums]">
                {count}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}
