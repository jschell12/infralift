import type { Prisma } from "@prisma/client";
import { isGitHost, type DriftStatus, type GitHost, type ImportCheckResult, type Project, type RootModule } from "@infralift/shared";

// ---------------------------------------------------------------------------
// TfProject row -> Project (one type per kind, @infralift/shared projects.ts).
//
// The table keeps every kind in one row shape: `source` plus columns that
// only mean something for some kinds. This is the one place that knows which
// columns go with which kind. A row missing what its kind requires is a data
// error and is reported, not papered over with nulls.
// ---------------------------------------------------------------------------

export const PROJECT_ROW_INCLUDE = {
  templateVersion: { select: { releaseTag: true, template: { select: { slug: true } } } },
  renderings: {
    select: { id: true, fileName: true, commitSha: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.TfProjectInclude;

export type ProjectRow = Prisma.TfProjectGetPayload<{ include: typeof PROJECT_ROW_INCLUDE }>;

export class ProjectShapeError extends Error {
  constructor(
    readonly projectId: string,
    reason: string
  ) {
    super(`project ${projectId}: ${reason}`);
  }
}

const settings = (v: Prisma.JsonValue): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const DRIFT_STATES: readonly string[] = ["none", "drift", "unknown", "unapplied"];

function driftOf(row: ProjectRow): DriftStatus | null {
  if (!row.driftState || !row.driftCheckedAt || !DRIFT_STATES.includes(row.driftState)) return null;
  return {
    state: row.driftState as DriftStatus["state"],
    message: row.driftMessage ?? "",
    checkUrl: row.driftCheckUrl,
    ranAt: row.driftRanAt?.toISOString() ?? null,
    checkedAt: row.driftCheckedAt.toISOString(),
  };
}

export function toProjectView(row: ProjectRow): Project {
  const need = <T>(value: T | null | undefined, field: string): T => {
    if (value === null || value === undefined) {
      throw new ProjectShapeError(row.id, `${row.source} project has no ${field}`);
    }
    return value;
  };
  const common = {
    id: row.id,
    name: row.name,
    gitHost: (isGitHost(row.gitHost) ? row.gitHost : "github") as GitHost,
    gitConnectionId: row.gitConnectionId,
    destRepo: row.destRepo,
    destBranch: row.destBranch,
    destPath: row.destPath,
    tfcConnectionId: row.tfcConnectionId,
    createdAt: row.createdAt.toISOString(),
  };
  switch (row.source) {
    case "template": {
      const v = need(row.templateVersion, "template version");
      return {
        ...common,
        kind: "template",
        templateVersion: { releaseTag: v.releaseTag, template: { slug: v.template.slug } },
        renderings: row.renderings.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        providerConfig: settings(row.providerConfig),
      };
    }
    case "codegen":
      return {
        ...common,
        kind: "codegen",
        assessmentId: need(row.assessmentId, "assessment"),
        migrationTarget: row.migrationTarget,
        providerConfig: settings(row.providerConfig),
      };
    case "stack":
      return {
        ...common,
        kind: "stack",
        stackSlug: need(row.stackSlug, "stack slug"),
        providerConfig: settings(row.providerConfig),
        drift: driftOf(row),
      };
    case "imported":
      return {
        ...common,
        kind: "imported",
        importJson: need(row.importJson, "scan") as unknown as RootModule,
        importCheckJson: (row.importCheckJson ?? null) as unknown as ImportCheckResult | null,
        assessmentId: row.assessmentId,
        drift: driftOf(row),
      };
    case "adopted":
      return { ...common, kind: "adopted" };
    default:
      throw new ProjectShapeError(row.id, `unknown kind ${JSON.stringify(row.source)}`);
  }
}
