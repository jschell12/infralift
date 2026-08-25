// Workspace adapter interface. TfCloudWorkspaceAdapter targets the HCP
// Terraform (Terraform Cloud) v2 API and is selected when TFC_TOKEN and
// TFC_ORG are set; otherwise the stub keeps the job pipeline able to
// complete end-to-end without external credentials.

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

// ---------------------------------------------------------------------------
// HCP Terraform / Terraform Cloud implementation (JSON:API v2).
// ---------------------------------------------------------------------------

const TFC_API = process.env.TFC_API_URL ?? "https://app.terraform.io/api/v2";

export class TfCloudError extends Error {}

export class TfCloudWorkspaceAdapter implements WorkspaceAdapter {
  constructor(
    private token: string,
    private org: string
  ) {}

  private async request(
    method: string,
    path: string,
    body?: object
  ): Promise<any> {
    const res = await fetch(`${TFC_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new TfCloudError(
        `TFC ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`
      );
    }
    return res.json();
  }

  private async getWorkspaceId(workspaceName: string): Promise<string> {
    const json = await this.request(
      "GET",
      `/organizations/${this.org}/workspaces/${encodeURIComponent(workspaceName)}`
    );
    return json.data.id as string;
  }

  // Idempotent: a 422 name-taken response resolves to the existing workspace.
  async createWorkspace(opts: {
    workspaceName: string;
    repo: string;
    branch: string;
    workingDirectory: string;
    autoApply: boolean;
  }): Promise<{ workspaceName: string }> {
    const res = await fetch(
      `${TFC_API}/organizations/${this.org}/workspaces`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: {
              name: opts.workspaceName,
              "working-directory": opts.workingDirectory,
              "auto-apply": opts.autoApply,
              // API-driven workflow until a VCS provider is linked in TFC;
              // repo/branch recorded in the description for operators.
              description: `infralift: ${opts.repo}@${opts.branch}`,
            },
          },
        }),
      }
    );
    if (res.ok) return { workspaceName: opts.workspaceName };
    if (res.status === 422) {
      // Name already taken — confirm it exists and treat as success.
      await this.getWorkspaceId(opts.workspaceName);
      return { workspaceName: opts.workspaceName };
    }
    const text = await res.text();
    throw new TfCloudError(
      `TFC workspace create -> ${res.status}: ${text.slice(0, 200)}`
    );
  }

  async queueRun(
    workspaceName: string,
    description: string
  ): Promise<WorkspaceRun> {
    const workspaceId = await this.getWorkspaceId(workspaceName);
    try {
      const json = await this.request("POST", `/runs`, {
        data: {
          type: "runs",
          attributes: { message: description },
          relationships: {
            workspace: { data: { type: "workspaces", id: workspaceId } },
          },
        },
      });
      return {
        runId: json.data.id as string,
        status: json.data.attributes.status as string,
      };
    } catch (err) {
      // A freshly created API-driven workspace has no configuration version
      // yet; surface that as a run status instead of failing the job.
      if (err instanceof TfCloudError && err.message.includes("422")) {
        return { runId: "none", status: "awaiting_configuration" };
      }
      throw err;
    }
  }

  async getRun(_workspaceName: string, runId: string): Promise<WorkspaceRun> {
    const json = await this.request("GET", `/runs/${runId}`);
    return {
      runId,
      status: json.data.attributes.status as string,
    };
  }
}

export function getWorkspaceAdapter(): WorkspaceAdapter {
  const token = process.env.TFC_TOKEN;
  const org = process.env.TFC_ORG;
  if (token && org) return new TfCloudWorkspaceAdapter(token, org);
  return new StubWorkspaceAdapter();
}
