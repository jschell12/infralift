// Who can see a team stack, and how its visibility may change (ADR 0009).
//
//   request   private to pending_public                 the owner
//   approve   pending_public to public                  an infralift admin
//   revoke    pending_public or public to revoked       an infralift admin
//   withdraw  pending_public or public to private       the owner
//
// A revoked stack stays revoked: the owner still sees and uses it, nobody else.
// The owning org always sees its own stacks. Another org sees one only while
// it is public, and then only the version the review covered.

export const STACK_VISIBILITIES = ["private", "pending_public", "public", "revoked"] as const;
export type StackVisibility = (typeof STACK_VISIBILITIES)[number];

export type VisibilityAction = "request" | "withdraw" | "approve" | "revoke";

const NEXT: Record<VisibilityAction, Partial<Record<StackVisibility, StackVisibility>>> = {
  request: { private: "pending_public" },
  withdraw: { pending_public: "private", public: "private" },
  approve: { pending_public: "public" },
  revoke: { pending_public: "revoked", public: "revoked" },
};

/** The visibility `action` moves to from `from`, or null when it may not. */
export function nextVisibility(from: string, action: VisibilityAction): StackVisibility | null {
  return NEXT[action][from as StackVisibility] ?? null;
}

/** Where `action` may start from and where it goes, for a guarded update.
 *  Every action has one destination. */
export function transitionFor(action: VisibilityAction): { from: StackVisibility[]; to: StackVisibility } {
  const table = NEXT[action];
  return { from: Object.keys(table) as StackVisibility[], to: Object.values(table)[0] as StackVisibility };
}

export type StackOrigin = "infralift" | "org" | "community";

/** How `orgId` sees a source: its own, a community stack, or not at all. */
export function originFor(
  orgId: string,
  source: { orgId: string; visibility: string; publishedVersionId: string | null }
): Exclude<StackOrigin, "infralift"> | null {
  if (source.orgId === orgId) return "org";
  return source.visibility === "public" && source.publishedVersionId ? "community" : null;
}

/** The Prisma filter for every source `orgId` may see. Kept beside originFor
 *  so the query and the check say the same thing. */
export function visibleWhere(orgId: string) {
  return { OR: [{ orgId }, { visibility: "public", publishedVersionId: { not: null } }] };
}
