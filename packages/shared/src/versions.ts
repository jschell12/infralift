// ---------------------------------------------------------------------------
// Version lag, as the API returns it (ADR 0012, phase 1: the fleet view).
//
// For each project: the catalog or team stack release it was made from
// against the newest one, the required_version its repository declares
// against infralift's baseline, and each provider its lock file pins against
// the baseline's constraint. Read-only. Nothing here opens an upgrade.
//
//   current        at or past what infralift's baseline (or the stack's
//                  newest release) asks for
//   behind-minor   behind on a minor or patch release, same major
//   behind-major   at least one major release behind
//   unknown        not compared: no lock file, nothing pinned, the repository
//                  could not be read, or infralift has nothing to compare it
//                  with. Never a guess.
// ---------------------------------------------------------------------------

import type { ProjectKind } from "./projects.js";

export const VERSION_STATUSES = ["current", "behind-minor", "behind-major", "unknown"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export interface VersionItem {
  /** "stack release", "terraform", or a provider source such as "hashicorp/aws". */
  name: string;
  /** What the project has: the release it was made from, the repository's
   *  required_version, or the provider version its lock file pins. */
  have: string | null;
  /** What infralift's baseline or the stack's newest release asks for. */
  want: string | null;
  status: VersionStatus;
  /** Why it is unknown, or anything else a reader needs to trust the row. */
  note: string | null;
}

export interface ProjectVersions {
  projectId: string;
  name: string;
  kind: ProjectKind;
  destRepo: string;
  /** The worst status of the items below. */
  status: VersionStatus;
  /** Null for projects not made from a stack. */
  stack: VersionItem | null;
  /** Null until the repository has been read once. */
  terraform: VersionItem | null;
  providers: VersionItem[];
  /** When infralift last read the repository; null if it never has. */
  checkedAt: string | null;
  /** The branch that was read, and the directory in it ("" = the root). */
  ref: string | null;
  path: string | null;
  /** Why the last read failed, in words; null when it worked. */
  problem: string | null;
  /** What a read that worked skipped or could not parse. */
  notes: string[];
}

export interface VersionsPage {
  projects: ProjectVersions[];
  nextCursor: string | null;
}

/** lib/tf/baseline.ts as data: the required_version floors and the provider
 *  constraints infralift writes. */
export interface VersionBaseline {
  requiredVersion: Record<string, string>;
  providers: Record<string, string>;
}
