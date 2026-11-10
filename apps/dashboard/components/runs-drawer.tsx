"use client";

import { useCallback, useEffect, useState } from "react";
import {
  runIsSettled,
  type TfcOAuthTokenSummary,
  type TfcRunSummary,
  type WorkspaceSummary,
} from "@infralift/shared";
import { api } from "../lib/api";
import { Chip, Drawer, INPUT, LABEL, PrimaryButton, type Tone } from "./ui";

const POLL_MS = 5000;
const BTN = "rounded-lg border border-border px-3 py-1.5 text-xs font-semibold cursor-pointer disabled:opacity-50";

function tone(r: TfcRunSummary): Tone {
  if (r.isConfirmable) return "warn";
  if (["applied", "planned_and_finished", "planned_and_saved"].includes(r.status)) return "accent";
  if (["errored", "policy_soft_failed"].includes(r.status)) return "danger";
  if (["discarded", "canceled", "force_canceled"].includes(r.status)) return "muted";
  return "info";
}

function counts(r: TfcRunSummary): string {
  if (r.additions === null) return "";
  return `+${r.additions} ~${r.changes ?? 0} -${r.destructions ?? 0}`;
}

/** Runs for one workspace: queue a plan, apply or discard one waiting for
 *  confirmation, and link the repository so merges plan. */
export function RunsDrawer({
  workspace,
  onClose,
  onChanged,
}: {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [runs, setRuns] = useState<TfcRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [linking, setLinking] = useState(false);
  const [tokens, setTokens] = useState<TfcOAuthTokenSummary[]>([]);
  const [tokenId, setTokenId] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [dir, setDir] = useState("");

  const base = `/workspaces/${workspace.id}`;
  const load = useCallback(
    () =>
      api<TfcRunSummary[]>(`${base}/runs`)
        .then((r) => {
          setRuns(r);
          setError(null);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [base]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any run can still move on its own. Stops when every run is
  // settled, or when the drawer closes (the effect cleans up).
  const active = runs?.some((r) => !runIsSettled(r)) ?? false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  async function act(path: string, body: object) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setConfirming(null);
      setTyped("");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startLink() {
    setLinking(true);
    setError(null);
    try {
      const r = await api<{ tokens: TfcOAuthTokenSummary[]; selected: string | null }>(
        `/workspaces/connections/${workspace.connectionId}/oauth-tokens`
      );
      setTokens(r.tokens);
      setTokenId(r.selected ?? r.tokens[0]?.id ?? "");
    } catch (e) {
      setLinking(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/vcs`, {
        method: "POST",
        body: JSON.stringify({
          repo,
          oauthTokenId: tokenId,
          ...(branch ? { branch } : {}),
          ...(dir ? { workingDirectory: dir } : {}),
        }),
      });
      setLinking(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title={workspace.name}
      subtitle={workspace.vcsRepo ? `Plans each merge to ${workspace.vcsRepo}.` : "Not linked to a repository: merges do not plan."}
      onClose={onClose}
    >
      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      <div className="flex gap-2 mb-6">
        <PrimaryButton disabled={busy} onClick={() => act(`${base}/runs`, { message: "Plan queued from infralift" })}>
          Queue plan
        </PrimaryButton>
        {!workspace.vcsRepo && workspace.kind !== "adopted" && !linking && (
          <button className={BTN} onClick={startLink}>
            Link repository
          </button>
        )}
      </div>

      {linking && tokens.length > 0 && (
        <form onSubmit={link} className="mb-6 border border-border rounded-lg p-4">
          <label className={LABEL}>VCS connection</label>
          <select className={`${INPUT} mb-3`} value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>
                {t.serviceProviderDisplayName}
                {t.user ? ` (${t.user})` : ""}
              </option>
            ))}
          </select>
          <label className={LABEL}>Repository (owner/repo)</label>
          <input className={`${INPUT} mb-3`} value={repo} onChange={(e) => setRepo(e.target.value)} required />
          <label className={LABEL}>Branch (blank: the default branch)</label>
          <input className={`${INPUT} mb-3`} value={branch} onChange={(e) => setBranch(e.target.value)} />
          <label className={LABEL}>Working directory (optional)</label>
          <input className={`${INPUT} mb-3`} value={dir} onChange={(e) => setDir(e.target.value)} />
          <div className="flex gap-2">
            <button className={BTN} type="submit" disabled={busy || !repo || !tokenId}>
              Link
            </button>
            <button className={BTN} type="button" onClick={() => setLinking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {runs === null ? (
        <div className="text-muted text-sm">Loading runs...</div>
      ) : runs.length === 0 ? (
        <div className="text-muted text-sm">No runs yet.</div>
      ) : (
        <ul className="space-y-3">
          {runs.map((r) => (
            <li key={r.id} className="border border-border rounded-lg p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <Chip tone={tone(r)}>{r.isConfirmable ? "needs confirmation" : r.status.replaceAll("_", " ")}</Chip>
                <span className="text-muted text-xs">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <div className="mt-2">{r.message || r.id}</div>
              <div className="text-muted text-xs mt-1">
                {[counts(r), r.planOnly ? "plan only" : "", r.source ?? ""].filter(Boolean).join(" · ")}
              </div>
              {(r.isConfirmable || r.isDiscardable) && confirming !== r.id && (
                <div className="flex gap-2 mt-3">
                  {r.isConfirmable && (
                    <button className={BTN} disabled={busy} onClick={() => setConfirming(r.id)}>
                      Apply
                    </button>
                  )}
                  {r.isDiscardable && (
                    <button className={BTN} disabled={busy} onClick={() => act(`${base}/runs/${r.id}/discard`, {})}>
                      Discard
                    </button>
                  )}
                </div>
              )}
              {confirming === r.id && (
                <div className="mt-3">
                  <label className={LABEL}>
                    Type <span className="font-mono">{workspace.name}</span> to apply
                  </label>
                  <input className={`${INPUT} mb-2`} value={typed} onChange={(e) => setTyped(e.target.value)} />
                  <div className="flex gap-2">
                    <button
                      className={BTN}
                      disabled={busy || typed !== workspace.name}
                      onClick={() => act(`${base}/runs/${r.id}/apply`, { confirm: typed })}
                    >
                      Apply
                    </button>
                    <button className={BTN} onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
