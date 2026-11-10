// Workspace adapter interface. TfCloudWorkspaceAdapter targets the HCP
// Terraform (Terraform Cloud) v2 API. Jobs get one only through a project's
// own Terraform Cloud connection (lib/tf/tfc-connection.ts); there is no
// adapter for infralift's own organization, so nothing can fall back to it.

import { TfcClient, TfcClientError } from "./tfc-client.js";

export interface WorkspaceRun {
  runId: string;
  status: string;
}

export interface CreatedWorkspace {
  workspaceName: string;
  /** The repo TFC fetches from; null when the workspace is API-driven, so
   *  nothing plans on a merge. */
  vcsRepo: string | null;
  /** TFC holds VCS-triggered runs until one run has been queued by hand,
   *  unless this is set. */
  queueAllRuns: boolean;
  /** Why a link was asked for and not made; the workspace was created
   *  unlinked instead. */
  linkError: string | null;
}

export interface CreateWorkspaceOpts {
  workspaceName: string;
  repo: string;
  branch: string;
  workingDirectory: string;
  autoApply: boolean;
  /** Let pushes queue runs before any run has been queued by hand. For a
   *  caller that queues no run of its own after creating the workspace. */
  queueAllRuns?: boolean;
}

export interface WorkspaceAdapter {
  createWorkspace(opts: CreateWorkspaceOpts): Promise<CreatedWorkspace>;
  queueRun(workspaceName: string, description: string): Promise<WorkspaceRun>;
  getRun(workspaceName: string, runId: string): Promise<WorkspaceRun>;
}

// ---------------------------------------------------------------------------
// HCP Terraform / Terraform Cloud implementation, backed by TfcClient.
// ---------------------------------------------------------------------------

export class TfCloudError extends Error {}

export class TfCloudWorkspaceAdapter implements WorkspaceAdapter {
  private client: TfcClient;

  /** `vcsOauthTokenId` is the VCS connection the customer picked for this
   *  organization; without one, workspaces are created API-driven. */
  constructor(token: string, org: string, base?: string, private vcsOauthTokenId: string | null = null) {
    this.client = new TfcClient(token, org, base);
  }

  // Idempotent: a 422 name-taken response resolves to the existing workspace,
  // which is reported as it is and not linked here. A link TFC refuses (it
  // cannot see the repo through that token) falls back to an unlinked
  // workspace, so a job that worked before a VCS token was picked still works.
  async createWorkspace(opts: CreateWorkspaceOpts): Promise<CreatedWorkspace> {
    const vcs =
      this.vcsOauthTokenId && opts.repo
        ? { identifier: opts.repo, oauthTokenId: this.vcsOauthTokenId, branch: opts.branch }
        : undefined;
    const base = {
      description: `infralift: ${opts.repo}@${opts.branch}`,
      workingDir: opts.workingDirectory,
      autoApply: opts.autoApply,
    };
    let linkError: string | null = null;
    let ws;
    try {
      ws = await this.client.createWorkspace(opts.workspaceName, {
        ...base,
        ...(vcs ? { vcs, queueAllRuns: opts.queueAllRuns } : {}),
      });
    } catch (err) {
      if (!vcs || !(err instanceof TfcClientError) || err.statusCode !== 422) throw err;
      linkError = `Terraform Cloud could not link ${opts.repo} (it answered 422)`;
      ws = await this.client.createWorkspace(opts.workspaceName, base);
    }
    return { workspaceName: opts.workspaceName, vcsRepo: ws.vcsRepo, queueAllRuns: ws.queueAllRuns, linkError };
  }

  async queueRun(
    workspaceName: string,
    description: string
  ): Promise<WorkspaceRun> {
    const ws = await this.client.getWorkspace(workspaceName);
    if (!ws) {
      throw new TfCloudError(`workspace "${workspaceName}" not found`);
    }
    try {
      const run = await this.client.createRun(ws.id, description);
      return { runId: run.id, status: run.status };
    } catch (err) {
      // A freshly created API-driven workspace has no configuration version
      // yet; surface that as a run status instead of failing the job.
      if (err instanceof TfcClientError && err.statusCode === 422) {
        return { runId: "none", status: "awaiting_configuration" };
      }
      throw err;
    }
  }

  async getRun(_workspaceName: string, runId: string): Promise<WorkspaceRun> {
    const run = await this.client.getRun(runId);
    return { runId: run.id, status: run.status };
  }
}
