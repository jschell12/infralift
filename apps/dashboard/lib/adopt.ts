// The adopt step of /projects/new (components/assess-panel.tsx) shows one
// tile per cloud account. These decide what each tile says and which one
// action on the page is the primary one, kept free of React so they can be
// tested.

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

export type PrimaryAdoptAction = { connectionId: string; action: "assess" | "adopt" } | null;

/**
 * The one action that gets the accent on the adopt step. Every other action
 * on the page is secondary, so the accent marks a single next step.
 *
 * In order: the account the link pointed at (?assess=<id>) if it can be
 * assessed; otherwise the account assessed most recently, whose next step is
 * to adopt what was found; otherwise the first account that can be assessed.
 * An account can be assessed only when its connection is valid.
 */
export function primaryAdoptAction(
  accounts: Pick<ProviderConnectionSummary, "id" | "status">[],
  assessments: Assessment[],
  highlight: string | null = null
): PrimaryAdoptAction {
  const assessable = accounts.filter((c) => c.status === "valid");
  const nextStepFor = (id: string): PrimaryAdoptAction => ({
    connectionId: id,
    action: latestCompletedAssessment(assessments, id) ? "adopt" : "assess",
  });

  if (highlight && assessable.some((c) => c.id === highlight)) return nextStepFor(highlight);

  let newest: { id: string; at: string } | null = null;
  for (const c of assessable) {
    const a = latestCompletedAssessment(assessments, c.id);
    if (a && (!newest || (a.completedAt ?? "") > newest.at)) newest = { id: c.id, at: a.completedAt ?? "" };
  }
  if (newest) return { connectionId: newest.id, action: "adopt" };

  return assessable[0] ? { connectionId: assessable[0].id, action: "assess" } : null;
}
