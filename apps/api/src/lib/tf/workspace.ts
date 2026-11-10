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
}

export interface WorkspaceAdapter {
  createWorkspace(opts: {
    workspaceName: string;
    repo: string;
    branch: string;
    workingDirectory: string;
    autoApply: boolean;
  }): Promise<CreatedWorkspace>;
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
  // which is reported as it is and not linked here.
  async createWorkspace(opts: {
    workspaceName: string;
    repo: string;
    branch: string;
    workingDirectory: string;
    autoApply: boolean;
  }): Promise<CreatedWorkspace> {
    const vcs =
      this.vcsOauthTokenId && opts.repo
        ? { identifier: opts.repo, oauthTokenId: this.vcsOauthTokenId, branch: opts.branch }
        : undefined;
    const ws = await this.client.createWorkspace(opts.workspaceName, {
      vcs,
      description: `infralift: ${opts.repo}@${opts.branch}`,
      workingDir: opts.workingDirectory,
      autoApply: opts.autoApply,
    });
    return { workspaceName: opts.workspaceName, vcsRepo: ws.vcsRepo };
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
