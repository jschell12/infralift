// Workspace adapter interface. The real implementation targets Terraform
// Cloud's API; until an org token is wired in, the stub records intent and
// returns deterministic names so the job pipeline can complete end-to-end.

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

export class StubWorkspaceAdapter implements WorkspaceAdapter {
  async createWorkspace(opts: {
    workspaceName: string;
    repo: string;
    branch: string;
    workingDirectory: string;
    autoApply: boolean;
  }): Promise<{ workspaceName: string }> {
    return { workspaceName: opts.workspaceName };
  }

  async queueRun(
    workspaceName: string,
    _description: string
  ): Promise<WorkspaceRun> {
    return { runId: `stub-run-${workspaceName}`, status: "not_connected" };
  }

  async getRun(workspaceName: string, runId: string): Promise<WorkspaceRun> {
    return { runId, status: "not_connected" };
  }
}

// Swap point for TfCloudWorkspaceAdapter once a TFC org token is available.
export function getWorkspaceAdapter(): WorkspaceAdapter {
  return new StubWorkspaceAdapter();
}
