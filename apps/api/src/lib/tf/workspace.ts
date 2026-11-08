// Workspace adapter interface. TfCloudWorkspaceAdapter targets the HCP
// Terraform (Terraform Cloud) v2 API. Jobs get one only through a project's
// own Terraform Cloud connection (lib/tf/tfc-connection.ts); there is no
// adapter for infralift's own organization, so nothing can fall back to it.

import { TfcClient, TfcClientError } from "./tfc-client.js";

export interface WorkspaceRun {
  runId: string;
  status: string;
}

export interface WorkspaceAdapter {
  createWorkspace(opts: {
    workspaceName: string;
    repo: string;
    branch: string;
    workingDirectory: string;
    autoApply: boolean;
  }): Promise<{ workspaceName: string }>;
  queueRun(workspaceName: string, description: string): Promise<WorkspaceRun>;
  getRun(workspaceName: string, runId: string): Promise<WorkspaceRun>;
}

// ---------------------------------------------------------------------------
// HCP Terraform / Terraform Cloud implementation, backed by TfcClient.
// ---------------------------------------------------------------------------

export class TfCloudError extends Error {}

export class TfCloudWorkspaceAdapter implements WorkspaceAdapter {
  private client: TfcClient;

  constructor(token: string, org: string, base?: string) {
    this.client = new TfcClient(token, org, base);
  }

  // Idempotent: a 422 name-taken response resolves to the existing workspace.
  async createWorkspace(opts: {
    workspaceName: string;
    repo: string;
    branch: string;
    workingDirectory: string;
    autoApply: boolean;
  }): Promise<{ workspaceName: string }> {
    await this.client.createWorkspace(opts.workspaceName, {
      vcsRepo: `${opts.repo}@${opts.branch}`,
      workingDir: opts.workingDirectory,
      autoApply: opts.autoApply,
    });
    return { workspaceName: opts.workspaceName };
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
