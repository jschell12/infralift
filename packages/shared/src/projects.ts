// ---------------------------------------------------------------------------
// Projects, as the API returns them: one type per kind, discriminated by
// `kind`. Each kind carries only the fields that mean something for it, so a
// reader never has to remember which nullable column goes with which kind.
//
//   template  a single file rendered from a template version (legacy /terraform)
//   codegen   Terraform generated from an assessment, for a migration target
//   stack     a whole deploy setup rendered from a stack, landed as a PR
//   imported  existing Terraform in a repo, or cloud resources adopted as they
//             run, behind the read-only import check
//   adopted   built around workspaces adopted from the customer's Terraform Cloud
//
// The database still stores these in one TfProject table (source + nullable
// columns); apps/api/src/lib/projects/view.ts maps a row to its kind.
// ---------------------------------------------------------------------------

import type { GitHost } from "./index.js";
import type { ImportCheckResult, RootModule } from "./imports.js";

export const PROJECT_KINDS = ["template", "codegen", "stack", "imported", "adopted"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

interface ProjectCommon {
  id: string;
  name: string;
  /** Where the code lives. */
  gitHost: GitHost;
  gitConnectionId: string | null;
  destRepo: string;
  destBranch: string;
  /** Directory inside the repository; "" = the root. */
  destPath: string;
  /** The org's Terraform Cloud connection the workspace lives in, if any. */
  tfcConnectionId: string | null;
  createdAt: string;
}

/** Whether what is running still matches the code on the default branch,
 *  from the daily `infra drift` check. "unknown": the check has not run, is
 *  running, or failed before it could compare. */
export type DriftState = "none" | "drift" | "unknown";

export interface DriftStatus {
  state: DriftState;
  /** One line, from the check's own annotation when there is one. */
  message: string;
  checkUrl: string | null;
  /** When the drift plan ran, if one was found. */
  ranAt: string | null;
  /** When infralift last read it. */
  checkedAt: string;
}

export interface TemplateProject extends ProjectCommon {
  kind: "template";
  templateVersion: { releaseTag: string; template: { slug: string } };
  renderings: { id: string; fileName: string; commitSha: string | null; createdAt: string }[];
  /** Provider pinning for the rendered provider.tf. */
  providerConfig: Record<string, unknown>;
}

export interface CodegenProject extends ProjectCommon {
  kind: "codegen";
  assessmentId: string;
  /** cloudflare | hetzner | null (source only). */
  migrationTarget: string | null;
  /** Codegen options: source provider, backend. */
  providerConfig: Record<string, unknown>;
}

export interface StackProject extends ProjectCommon {
  kind: "stack";
  stackSlug: string;
  /** The stack's settings, with its defaults filled in. */
  providerConfig: Record<string, unknown>;
  /** Null until infralift has read the drift check. */
  drift: DriftStatus | null;
}

export interface ImportedProject extends ProjectCommon {
  kind: "imported";
  /** The scanned root module (repo import) or the adoption it was built from. */
  importJson: RootModule;
  /** Last result of the read-only import check, if read yet. */
  importCheckJson: ImportCheckResult | null;
  /** Set when adopted from a cloud account's assessment. */
  assessmentId: string | null;
  /** Null until infralift has read the drift check. */
  drift: DriftStatus | null;
}

export interface AdoptedProject extends ProjectCommon {
  kind: "adopted";
}

export type Project = TemplateProject | CodegenProject | StackProject | ImportedProject | AdoptedProject;
