// The Workspace row for a Terraform Cloud workspace a job created or reused.
// The workspaces page and the runs drawer read these rows, so a workspace a
// job made without one was invisible to both.
//
// Which kind a row gets decides what infralift may change on it later
// (services/workspace-runs.ts refuses to link an adopted workspace):
// - created by this job: "managed".
// - already there when the job ran, and no row for it yet: "adopted". The
//   adapter cannot tell a workspace an earlier run of this job made from one
//   the customer made, so it is treated as theirs and left as it is.
// - a row already exists for it: its kind is kept. A rerun never turns an
//   adopted workspace into a managed one or the other way round.
//
// A workspace a job created before these rows existed is recorded as adopted
// by the next run of that job. Adopting it under Workspaces records it the
// same way, with its variables and outputs.

import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { CreatedWorkspace } from "./workspace.js";

export interface RecordJobWorkspaceInput {
  orgId: string;
  projectId: string;
  connectionId: string;
  cred: { hostname: string; organization: string };
  ws: CreatedWorkspace;
}

export type RecordedWorkspace =
  | { status: "recorded"; id: string; kind: string }
  | { status: "skipped"; reason: string };

export function tfcWorkspaceUrl(cred: { hostname: string; organization: string }, name: string): string {
  return `https://${cred.hostname}/app/${encodeURIComponent(cred.organization)}/workspaces/${encodeURIComponent(name)}`;
}

/** Upserts the row, keyed on (org, TFC workspace id). Every query names the
 *  org, so a workspace id seen in one org can never touch another's row. */
export async function recordJobWorkspace(input: RecordJobWorkspaceInput): Promise<RecordedWorkspace> {
  const { orgId, projectId, connectionId, cred, ws } = input;
  const remote = {
    tfcWorkspaceUrl: tfcWorkspaceUrl(cred, ws.workspaceName),
    vcsRepo: ws.vcsRepo,
    workingDirectory: ws.workingDirectory,
  };

  const byId = await prisma.workspace.findUnique({
    where: { orgId_tfcWorkspaceId: { orgId, tfcWorkspaceId: ws.tfcWorkspaceId } },
  });
  if (byId) {
    // Only rows a job writes are refreshed; adopted and extension rows are
    // kept as their own flows wrote them.
    if (byId.kind === "managed") {
      await prisma.workspace.update({
        where: { id: byId.id },
        data: { ...remote, connectionId, ...(byId.projectId ? {} : { projectId }) },
      });
    }
    return { status: "recorded", id: byId.id, kind: byId.kind };
  }

  const byName = await prisma.workspace.findUnique({ where: { orgId_name: { orgId, name: ws.workspaceName } } });
  if (byName) {
    return {
      status: "skipped",
      reason: `infralift already has a workspace named ${ws.workspaceName} for a different Terraform Cloud workspace`,
    };
  }

  const kind = ws.created ? "managed" : "adopted";
  try {
    const row = await prisma.workspace.create({
      data: {
        orgId,
        name: ws.workspaceName,
        kind,
        projectId,
        connectionId,
        tfcWorkspaceId: ws.tfcWorkspaceId,
        ...remote,
      },
    });
    return { status: "recorded", id: row.id, kind };
  } catch (err) {
    // Two runs racing to record the same workspace: the other one won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await prisma.workspace.findUnique({
        where: { orgId_tfcWorkspaceId: { orgId, tfcWorkspaceId: ws.tfcWorkspaceId } },
      });
      if (raced) return { status: "recorded", id: raced.id, kind: raced.kind };
    }
    throw err;
  }
}

/** For a job's result line. Never throws: the workspace exists in TFC either
 *  way, and a job that otherwise worked should not fail on its bookkeeping. */
export async function recordJobWorkspaceNote(input: RecordJobWorkspaceInput): Promise<string> {
  try {
    const r = await recordJobWorkspace(input);
    if (r.status === "skipped") return `not listed under Workspaces: ${r.reason}`;
    if (r.kind === "adopted") {
      return "it already existed and infralift did not create it, so it is listed as adopted and infralift will not change its settings";
    }
    return `listed under Workspaces as ${r.kind}`;
  } catch (err) {
    console.error(`could not record workspace ${input.ws.workspaceName} for org ${input.orgId}:`, err);
    return "not listed under Workspaces: recording it failed, rerun the job to retry";
  }
}
