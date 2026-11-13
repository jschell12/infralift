"use client";

// Checking connections again from a page that shows them. When any connection
// on the page was never checked or was last checked over a day ago, the page
// asks the API to check the org's stale connections in the background (POST
// /connections/check-stale), then reloads the list every CHECK_POLL_MS while
// any row says checking, so each tile updates when its check is recorded.
// The API decides what is stale and rate limits the request per org; the
// daily sweep checks every connection whether or not a page asks.

import { useEffect, useRef } from "react";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { api } from "./api";
import { isStale } from "./connections";

export const CHECK_POLL_MS = 3000;
/** Reloads per page visit at most, so a check that never records (its
 *  process died holding the claim) cannot keep a tab polling. */
export const CHECK_POLL_MAX = 20;

/** True when a page showing these connections should ask for a check. */
export function shouldRequestChecks(list: readonly ProviderConnectionSummary[], now: number = Date.now()): boolean {
  return list.some((c) => isStale(c, now));
}

export function checkingCount(list: readonly ProviderConnectionSummary[]): number {
  return list.filter((c) => c.checking).length;
}

/** "Checking 2 connections..." for the page's one status line; empty when
 *  nothing is being checked. */
export function checkingText(count: number): string {
  if (count === 0) return "";
  return count === 1 ? "Checking 1 connection..." : `Checking ${count} connections...`;
}

/**
 * Asks for a check of stale connections once per page visit, and reloads
 * while any is being checked. `reload` must refetch GET /connections into the
 * `connections` the page passes back in. Returns how many are being checked.
 */
export function useConnectionChecks(
  connections: readonly ProviderConnectionSummary[] | null,
  reload: () => unknown
): number {
  const asked = useRef(false);
  const polls = useRef(0);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!connections || asked.current || !shouldRequestChecks(connections)) return;
    asked.current = true;
    // A refusal (429: checked a moment ago) or a network failure changes
    // nothing on the page; the daily check still runs.
    void api("/connections/check-stale", { method: "POST" })
      .then(() => reloadRef.current())
      .catch(() => {});
  }, [connections]);

  const count = checkingCount(connections ?? []);
  useEffect(() => {
    if (count === 0) {
      polls.current = 0;
      return;
    }
    if (polls.current >= CHECK_POLL_MAX) return;
    const timer = setTimeout(() => {
      polls.current++;
      reloadRef.current();
    }, CHECK_POLL_MS);
    return () => clearTimeout(timer);
  }, [connections, count]);

  return count;
}
