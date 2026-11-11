"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSummary } from "@infralift/shared";
import { api, errorText } from "../../lib/api";
import { RunsDrawer } from "../../components/runs-drawer";

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api<WorkspaceSummary[]>(`/workspaces`)
      .then(setWorkspaces)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  // Read from the list so a link or a run shows up after a reload.
  const opened = workspaces.find((w) => w.id === open) ?? null;

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Workspaces</h1>
      <p className="text-muted mb-8">
        Terraform Cloud workspaces created during your migration. State lives
        in TF Cloud; code lives in your repo.
      </p>

      {error && <div className="text-danger text-sm mt-2">{error}</div>}

      {workspaces.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-6 mb-4">
          <h3 className="text-base font-semibold mb-1.5">No workspaces yet</h3>
          <p className="text-muted text-sm">
            Workspaces are created during the "Terraform repo + TF Cloud
            workspaces" migration phase and appear here with drift status and
            run history.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl p-6 mb-4">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Workspace</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Drift</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Last run</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Link</th>
                <th className="text-left p-3 border-b border-border text-muted font-medium text-xs">Runs</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id}>
                  <td className="p-3 border-b border-border">{w.name}</td>
                  <td className="p-3 border-b border-border">
                    <span
                      className={
                        w.driftDetected
                          ? "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-danger/20 text-danger"
                          : "inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent-dim text-accent"
                      }
                    >
                      {w.driftDetected ? "drift detected" : "clean"}
                    </span>
                  </td>
                  <td className="p-3 border-b border-border">
                    {w.lastRunStatus ?? "—"}
                    {w.lastRunAt &&
                      ` · ${new Date(w.lastRunAt).toLocaleString()}`}
                  </td>
                  <td className="p-3 border-b border-border">
                    {w.tfcWorkspaceUrl ? (
                      <a href={w.tfcWorkspaceUrl}>Open in TF Cloud</a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="p-3 border-b border-border">
                    {w.connectionId ? (
                      <button className="text-accent cursor-pointer" onClick={() => setOpen(w.id)}>
                        Runs
                      </button>
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

      {opened && <RunsDrawer workspace={opened} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}
