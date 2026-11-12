// The adopt step of /projects/new (components/assess-panel.tsx) shows one
// tile per cloud account. These decide what each tile says and which one
// action on the page is the primary one, kept free of React so they can be
// tested. The account's own page, /projects/new/adopt, uses
// lib/adopt-account.ts.

import type { AssessmentSummary, ProviderConnectionSummary } from "@infralift/shared";

type Assessment = Pick<AssessmentSummary, "id" | "status" | "connectionId" | "completedAt">;

/** The newest completed assessment of one connection, or null. Reruns of a
 *  connection share its connectionId; the newest completedAt wins, whatever
 *  order the list came in. */
export function latestCompletedAssessment<T extends Assessment>(assessments: T[], connectionId: string): T | null {
  let latest: T | null = null;
  for (const a of assessments) {
    if (a.connectionId !== connectionId || a.status !== "completed") continue;
    if (!latest || (a.completedAt ?? "") > (latest.completedAt ?? "")) latest = a;
  }
  return latest;
}

/** Where "Find unmanaged resources" goes for one account: its own page, so
 *  the browser's back button returns to the account tiles. */
export function findUnmanagedHref(connectionId: string): string {
  return `/projects/new/adopt?connection=${encodeURIComponent(connectionId)}`;
}

/**
 * The account whose "Find unmanaged resources" gets the accent on the adopt
 * step. Every other action on the page is secondary, so the accent marks a
 * single next step.
 *
 * The account the link pointed at (?assess=<id>) if its connection is valid,
 * otherwise the first valid one. Only a valid connection can read its
 * account; null when there is none.
 */
export function primaryFindAccount(
  accounts: Pick<ProviderConnectionSummary, "id" | "status">[],
  highlight: string | null = null
): string | null {
  const readable = accounts.filter((c) => c.status === "valid");
  if (highlight && readable.some((c) => c.id === highlight)) return highlight;
  return readable[0]?.id ?? null;
}
