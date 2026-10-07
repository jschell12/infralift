// Lightweight Terraform Cloud API client. Uses fetch directly (no SDK).
// All TFC responses use JSON:API format ({ data: { id, type, attributes } }).

const TFC_BASE = process.env.TFC_API_URL ?? "https://app.terraform.io/api/v2";

/** API base for a TFC/TFE hostname. Terraform Enterprise serves the same v2 API. */
export function tfcBaseUrl(hostname?: string | null): string {
  if (!hostname || hostname === "app.terraform.io") return TFC_BASE;
  return `https://${hostname}/api/v2`;
}

// ---------------------------------------------------------------------------
// Response types (mapped from JSON:API attributes to flat objects)
// ---------------------------------------------------------------------------

export interface TfcWorkspace {
  id: string;
  name: string;
  autoApply: boolean;
  workingDirectory: string | null;
  vcsRepo: string | null;
  /** Clone URL of the VCS repo, which is not always GitHub. */
  vcsRepoUrl: string | null;
  vcsBranch: string | null;
  currentConfigVersionId: string | null;
  globalRemoteState: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
  resourceCount: number;
  latestRunStatus: string | null;
}

export interface TfcStateVersion {
  id: string;
  serial: number;
  resourceCount: number;
  createdAt: string;
}

export interface TfcVariable {
  key: string;
  /** Null when sensitive: callers must not rely on the API to withhold it. */
  value: string | null;
  category: "terraform" | "env";
  hcl: boolean;
  sensitive: boolean;
  description: string;
}

export interface TfcOutput {
  name: string;
  sensitive: boolean;
}

export interface TfcIngress {
  commitSha: string | null;
  cloneUrl: string | null;
}

export interface TfcRun {
  id: string;
  status: string;
  message: string;
  createdAt: string;
  planOnly: boolean;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TfcClientError extends Error {
  constructor(
    public method: string,
    public path: string,
    public statusCode: number,
    public responseBody: string,
  ) {
    super(`TFC ${method} ${path} -> ${statusCode}: ${responseBody.slice(0, 200)}`);
    this.name = "TfcClientError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TfcClient {
  constructor(
    private token: string,
    private org: string,
    private base: string = TFC_BASE,
  ) {}

  // -- internal helpers -----------------------------------------------------

  private async request<T = unknown>(method: string, path: string, body?: object): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: body ? JSON.stringify(body) : undefined,
      // The host can be customer-supplied (TFE). Never follow a redirect to
      // somewhere it was not checked against.
      redirect: "manual",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new TfcClientError(method, path, res.status, text);
    }
    // 204 No Content (e.g. DELETE) has no body
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private static mapWorkspace(data: any): TfcWorkspace {
    const a = data.attributes;
    const vcs = a["vcs-repo"];
    return {
      id: data.id,
      name: a.name,
      autoApply: a["auto-apply"] ?? false,
      workingDirectory: a["working-directory"] || null,
      vcsRepo: vcs?.identifier ?? null,
      vcsRepoUrl: vcs?.["repository-http-url"] ?? null,
      vcsBranch: vcs?.branch || null,
      currentConfigVersionId:
        data.relationships?.["current-configuration-version"]?.data?.id ?? null,
      globalRemoteState: a["global-remote-state"] ?? false,
      description: a.description ?? "",
      createdAt: a["created-at"],
      updatedAt: a["updated-at"],
      resourceCount: a["resource-count"] ?? 0,
      latestRunStatus: a["latest-run"]?.status ?? null,
    };
  }

  private static mapRun(data: any): TfcRun {
    const a = data.attributes;
    return {
      id: data.id,
      status: a.status,
      message: a.message ?? "",
      createdAt: a["created-at"],
      planOnly: a["plan-only"] ?? false,
    };
  }

  private static mapStateVersion(data: any): TfcStateVersion {
    const a = data.attributes;
    return {
      id: data.id,
      serial: a.serial,
      resourceCount: a["resources-processed"] ?? 0,
      createdAt: a["created-at"],
    };
  }

  // -- workspaces -----------------------------------------------------------

  /** List all workspaces in the organization. Follows pagination. */
  async listWorkspaces(): Promise<TfcWorkspace[]> {
    const results: TfcWorkspace[] = [];
    let path: string | null = `/organizations/${encodeURIComponent(this.org)}/workspaces?page%5Bsize%5D=100`;

    while (path) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await this.request("GET", path);
      for (const d of json.data ?? []) {
        results.push(TfcClient.mapWorkspace(d));
      }
      // JSON:API pagination: next page URL is absolute; strip the base.
      const nextUrl: string | null = json.links?.next ?? null;
      if (nextUrl) {
        path = nextUrl.startsWith("http") ? nextUrl.replace(this.base, "") : nextUrl;
      } else {
        path = null;
      }
    }

    return results;
  }

  /** Get a single workspace by name. Returns null if it doesn't exist. */
  async getWorkspace(name: string): Promise<TfcWorkspace | null> {
    try {
      const json = await this.request<any>(
        "GET",
        `/organizations/${encodeURIComponent(this.org)}/workspaces/${encodeURIComponent(name)}`,
      );
      return TfcClient.mapWorkspace(json.data);
    } catch (err) {
      if (err instanceof TfcClientError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /** Create a workspace. Idempotent: returns the existing workspace on 422 (name taken). */
  async createWorkspace(
    name: string,
    opts?: { vcsRepo?: string; workingDir?: string; autoApply?: boolean },
  ): Promise<TfcWorkspace> {
    const attributes: Record<string, unknown> = {
      name,
      "auto-apply": opts?.autoApply ?? false,
    };
    if (opts?.workingDir) attributes["working-directory"] = opts.workingDir;

    const relationships: Record<string, unknown> = {};
    // VCS connection requires an OAuth token ID configured in TFC; just
    // record the repo identifier in the description for API-driven mode.
    if (opts?.vcsRepo) {
      attributes.description = `infralift: ${opts.vcsRepo}`;
    }

    try {
      const json = await this.request<any>(
        "POST",
        `/organizations/${encodeURIComponent(this.org)}/workspaces`,
        {
          data: {
            type: "workspaces",
            attributes,
            ...(Object.keys(relationships).length ? { relationships } : {}),
          },
        },
      );
      return TfcClient.mapWorkspace(json.data);
    } catch (err) {
      // 422 = name already taken; fetch the existing workspace.
      if (err instanceof TfcClientError && err.statusCode === 422) {
        const existing = await this.getWorkspace(name);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Create a workspace, refusing to reuse one that already exists. The
   * caller decides what an existing one means; createWorkspace's 422 reuse
   * cannot tell "made on an earlier attempt" from "already the customer's".
   */
  async createWorkspaceExclusive(
    name: string,
    opts: { autoApply: boolean; description: string },
  ): Promise<{ workspace: TfcWorkspace; created: boolean }> {
    const existing = await this.getWorkspace(name);
    if (existing) return { workspace: existing, created: false };
    try {
      const json = await this.request<any>(
        "POST",
        `/organizations/${encodeURIComponent(this.org)}/workspaces`,
        {
          data: {
            type: "workspaces",
            attributes: { name, "auto-apply": opts.autoApply, description: opts.description },
          },
        },
      );
      return { workspace: TfcClient.mapWorkspace(json.data), created: true };
    } catch (err) {
      if (err instanceof TfcClientError && err.statusCode === 422) {
        const raced = await this.getWorkspace(name);
        if (raced) return { workspace: raced, created: false };
      }
      throw err;
    }
  }

  // -- organization ---------------------------------------------------------

  /** True when the token can read the organization. Used to verify a connection. */
  async canReadOrganization(): Promise<boolean> {
    try {
      await this.request("GET", `/organizations/${encodeURIComponent(this.org)}`);
      return true;
    } catch (err) {
      if (err instanceof TfcClientError && (err.statusCode === 401 || err.statusCode === 404)) {
        return false;
      }
      throw err;
    }
  }

  // -- variables, outputs, configuration ------------------------------------

  /** Workspace variables. Sensitive values are nulled here, whatever the API returned. */
  async listVariables(workspaceId: string): Promise<TfcVariable[]> {
    const json = await this.request<any>(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/vars`,
    );
    return (json.data ?? []).map((d: any) => {
      const a = d.attributes;
      const sensitive = Boolean(a.sensitive);
      return {
        key: a.key,
        value: sensitive ? null : (a.value ?? null),
        category: a.category === "env" ? "env" : "terraform",
        hcl: Boolean(a.hcl),
        sensitive,
        description: a.description ?? "",
      };
    });
  }

  /** Output names of the current state version. Empty when there is no state yet. */
  async listCurrentOutputs(workspaceId: string): Promise<TfcOutput[]> {
    try {
      const json = await this.request<any>(
        "GET",
        `/workspaces/${encodeURIComponent(workspaceId)}/current-state-version-outputs`,
      );
      return (json.data ?? []).map((d: any) => ({
        name: d.attributes.name,
        sensitive: Boolean(d.attributes.sensitive),
      }));
    } catch (err) {
      if (err instanceof TfcClientError && err.statusCode === 404) return [];
      throw err;
    }
  }

  /** Commit and clone URL a configuration version was ingressed from. Null for CLI uploads. */
  async getIngress(configVersionId: string): Promise<TfcIngress | null> {
    try {
      const json = await this.request<any>(
        "GET",
        `/configuration-versions/${encodeURIComponent(configVersionId)}/ingress-attributes`,
      );
      const a = json.data?.attributes ?? {};
      return { commitSha: a["commit-sha"] ?? null, cloneUrl: a["clone-url"] ?? null };
    } catch (err) {
      if (err instanceof TfcClientError && err.statusCode === 404) return null;
      throw err;
    }
  }

  // -- cross-workspace wiring -----------------------------------------------

  /** Let `consumerIds` read `workspaceId`'s outputs (tfe_outputs / remote state). */
  async addRemoteStateConsumers(workspaceId: string, consumerIds: string[]): Promise<void> {
    await this.request(
      "POST",
      `/workspaces/${encodeURIComponent(workspaceId)}/relationships/remote-state-consumers`,
      { data: consumerIds.map((id) => ({ type: "workspaces", id })) },
    );
  }

  /** Workspace ids whose applies already trigger runs in `workspaceId`. */
  async listInboundRunTriggerSources(workspaceId: string): Promise<string[]> {
    const json = await this.request<any>(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/run-triggers?filter%5Brun-trigger%5D%5Btype%5D=inbound`,
    );
    return (json.data ?? [])
      .map((d: any) => d.relationships?.sourceable?.data?.id)
      .filter(Boolean);
  }

  /**
   * Queue a run in `workspaceId` whenever `sourceId` applies. Idempotent: the
   * API documents no duplicate status, so existing triggers are checked first.
   */
  async ensureRunTrigger(workspaceId: string, sourceId: string): Promise<void> {
    const existing = await this.listInboundRunTriggerSources(workspaceId);
    if (existing.includes(sourceId)) return;
    await this.request("POST", `/workspaces/${encodeURIComponent(workspaceId)}/run-triggers`, {
      data: {
        relationships: { sourceable: { data: { id: sourceId, type: "workspaces" } } },
      },
    });
  }

  // -- state versions -------------------------------------------------------

  /** Get the current state version for a workspace. Returns null if no state exists yet. */
  async getStateVersion(workspaceId: string): Promise<TfcStateVersion | null> {
    try {
      const json = await this.request<any>(
        "GET",
        `/workspaces/${encodeURIComponent(workspaceId)}/current-state-version`,
      );
      return TfcClient.mapStateVersion(json.data);
    } catch (err) {
      if (err instanceof TfcClientError && err.statusCode === 404) return null;
      throw err;
    }
  }

  // -- runs -----------------------------------------------------------------

  /** Queue a new run (plan + optional apply) for a workspace. */
  async createRun(workspaceId: string, message: string): Promise<TfcRun> {
    const json = await this.request<any>("POST", "/runs", {
      data: {
        type: "runs",
        attributes: { message },
        relationships: {
          workspace: { data: { type: "workspaces", id: workspaceId } },
        },
      },
    });
    return TfcClient.mapRun(json.data);
  }

  /** Get a single run by ID. */
  async getRun(runId: string): Promise<TfcRun> {
    const json = await this.request<any>("GET", `/runs/${encodeURIComponent(runId)}`);
    return TfcClient.mapRun(json.data);
  }

  /** List runs for a workspace (most recent first, up to 20). */
  async listRuns(workspaceId: string): Promise<TfcRun[]> {
    const json = await this.request<any>(
      "GET",
      `/workspaces/${encodeURIComponent(workspaceId)}/runs?page%5Bsize%5D=20`,
    );
    return (json.data ?? []).map(TfcClient.mapRun);
  }
}

// ---------------------------------------------------------------------------
// Factory: returns a client when TFC_TOKEN + TFC_ORG are set, null otherwise.
// ---------------------------------------------------------------------------

export function getTfcClient(): TfcClient | null {
  const token = process.env.TFC_TOKEN;
  const org = process.env.TFC_ORG;
  if (token && org) return new TfcClient(token, org);
  return null;
}
