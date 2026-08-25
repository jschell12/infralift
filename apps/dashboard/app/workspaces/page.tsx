"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSummary } from "@infralift/shared";
import { api, DEV_ORG_ID } from "../../lib/api";

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<WorkspaceSummary[]>(`/workspaces?orgId=${DEV_ORG_ID}`)
      .then(setWorkspaces)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <h1>Workspaces</h1>
      <p className="lead">
        Terraform Cloud workspaces created during your migration. State lives
        in TF Cloud; code lives in your repo.
      </p>

      {error && <div className="error">{error}</div>}

      {workspaces.length === 0 ? (
        <div className="card">
          <h3>No workspaces yet</h3>
          <p>
            Workspaces are created during the “Terraform repo + TF Cloud
            workspaces” migration phase and appear here with drift status and
            run history.
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Drift</th>
                <th>Last run</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td>
                    <span
                      className={
                        w.driftDetected ? "badge badge-bad" : "badge badge-ok"
                      }
                    >
                      {w.driftDetected ? "drift detected" : "clean"}
                    </span>
                  </td>
                  <td>
                    {w.lastRunStatus ?? "—"}
                    {w.lastRunAt &&
                      ` · ${new Date(w.lastRunAt).toLocaleString()}`}
                  </td>
                  <td>
                    {w.tfcWorkspaceUrl ? (
                      <a href={w.tfcWorkspaceUrl}>Open in TF Cloud</a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
