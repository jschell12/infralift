"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { api, errorText } from "../../lib/api";
import { connectionName, connectionStatus, connectionTypeInfo, isCloudAccount, TFC } from "../../lib/connections";
import {
  CARD,
  Chip,
  Drawer,
  ErrorState,
  H1,
  INPUT,
  LABEL,
  PrimaryButton,
  Skeleton,
  SMALL_BTN,
  SMALL_BTN_DANGER,
  SMALL_BTN_STRONG,
} from "../../components/ui";

// /connections: one tile per stored credential, Terraform Cloud included
// (ADR 0010). Adding one is its own page, /connections/new; the drawer here
// is only for replacing an existing credential.

/** Replace a connection's credential. The API verifies the new one first and
 *  keeps the old one if it fails, so a failure here changes nothing. */
function ReplaceDrawer({
  c,
  onClose,
  onDone,
}: {
  c: ProviderConnectionSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const isTfc = String(c.provider) === TFC;
  const secret = connectionTypeInfo(c.provider)?.secret;
  const [token, setToken] = useState("");
  const [organization, setOrganization] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/connections/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify(
          isTfc ? { token, organization: organization || undefined, hostname: hostname || undefined } : { token }
        ),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      title="Replace credential"
      subtitle={`${connectionName(c.provider)} · ${c.label}. The new credential is verified before it replaces the current one.`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        {isTfc && (
          <>
            <label htmlFor="replace-organization" className={LABEL}>Organization (blank keeps the current one)</label>
            <input id="replace-organization" className={`${INPUT} mb-4`} value={organization} onChange={(e) => setOrganization(e.target.value)} />
            <label htmlFor="replace-hostname" className={LABEL}>Hostname (blank keeps the current one)</label>
            <input id="replace-hostname" className={`${INPUT} mb-4`} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="app.terraform.io" />
          </>
        )}
        <label htmlFor="replace-token" className={LABEL}>{secret?.label ?? "Credential"}</label>
        {secret?.kind === "json" ? (
          <textarea
            id="replace-token"
            className={`${INPUT} mb-4 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={6}
            placeholder={secret.placeholder}
            autoComplete="off"
            spellCheck={false}
            required
          />
        ) : (
          <input
            id="replace-token"
            className={`${INPUT} mb-4 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={secret?.kind === "arn" ? "text" : "password"}
            placeholder={secret?.placeholder}
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}
        <PrimaryButton disabled={busy}>{busy ? "Verifying..." : "Verify & replace"}</PrimaryButton>
        {error && <div role="alert" className="mt-2 text-sm text-danger">{error}</div>}
      </form>
    </Drawer>
  );
}

function formatVerified(iso: string | null): string {
  if (!iso) return "Not verified yet";
  return `Last verified ${new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}

/** One connection: what it is, what state it is in and why, and the three
 *  ways to act on it. Remove asks once, inline, before it deletes. */
function ConnectionTile({ c, onChanged }: { c: ProviderConnectionSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState<null | "verify" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const status = connectionStatus(c);

  async function act(kind: "verify" | "remove", path: string, method: string) {
    setBusy(kind);
    setError(null);
    try {
      await api(path, { method });
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={`${CARD} flex min-w-0 flex-col p-5`}>
      <div className="mb-1 flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold break-words">{connectionName(c.provider)}</h2>
        <Chip tone={status.tone}>{status.text}</Chip>
      </div>
      <div className="mb-1 text-sm text-muted break-words">{c.label}</div>
      <div className="text-xs text-faint">{formatVerified(c.lastVerifiedAt)}</div>
      {c.status === "invalid" && c.lastError && (
        <div className="mt-2 text-xs text-danger break-words">{c.lastError}</div>
      )}

      <div className="mt-auto pt-4">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-full text-xs text-muted">Remove &quot;{c.label}&quot; and its stored credential?</span>
            <button
              type="button"
              className={SMALL_BTN_DANGER}
              disabled={busy !== null}
              onClick={() => void act("remove", `/connections/${c.id}`, "DELETE")}
            >
              {busy === "remove" ? "Removing..." : "Remove"}
            </button>
            <button type="button" className={SMALL_BTN} disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={SMALL_BTN}
              disabled={busy !== null}
              onClick={() => void act("verify", `/connections/${c.id}/verify`, "POST")}
            >
              {busy === "verify" ? "Verifying..." : "Verify"}
            </button>
            <button type="button" className={SMALL_BTN} disabled={busy !== null} onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button type="button" className={SMALL_BTN} disabled={busy !== null} onClick={() => setConfirming(true)}>
              Remove
            </button>
          </div>
        )}
        {error && <div role="alert" className="mt-2 text-xs text-danger">{error}</div>}
      </div>

      {replacing && (
        <ReplaceDrawer
          c={c}
          onClose={() => setReplacing(false)}
          onDone={() => {
            setReplacing(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ProviderConnectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections(await api<ProviderConnectionSummary[]>("/connections"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasCloudAccount = (connections ?? []).some((c) => c.status === "valid" && isCloudAccount(c.provider));

  return (
    <>
      <div className="mb-7 flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-[280px]">
          <h1 className={H1}>Connections</h1>
          <p className="max-w-[620px] text-muted">
            Credentials infralift uses to read your cloud accounts and to write to your repositories and Terraform
            Cloud. Encrypted at rest and never shown again.
          </p>
        </div>
        <PrimaryButton href="/connections/new">Add connection</PrimaryButton>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      )}

      {connections === null && !error && (
        <ul role="status" aria-label="Loading connections" className={GRID}>
          {[0, 1, 2].map((i) => (
            <li key={i} className={`${CARD} p-5`}>
              <Skeleton className="h-4 w-1/2 mb-3" />
              <Skeleton className="h-3 w-2/3 mb-2" />
              <Skeleton className="h-3 w-1/3 mb-5" />
              <Skeleton className="h-11 w-full" />
            </li>
          ))}
        </ul>
      )}

      {connections !== null && connections.length === 0 && (
        <div className={CARD}>
          <h2 className="mb-1.5 text-base font-semibold">No connections yet</h2>
          <p className="mb-4 max-w-[620px] text-sm text-muted">
            A connection lets infralift read one cloud account, such as AWS or Cloudflare, so it can list what runs
            there and bring it under Terraform. GitHub, GitLab and Terraform Cloud connections are where the code and
            state go.
          </p>
          <a className={SMALL_BTN_STRONG} href="/connections/new">
            Add your first connection
          </a>
        </div>
      )}

      {connections !== null && connections.length > 0 && (
        <>
          <ul className={GRID} aria-label="Connections">
            {connections.map((c) => (
              <ConnectionTile key={c.id} c={c} onChanged={() => void load()} />
            ))}
          </ul>
          {hasCloudAccount && (
            <div className="mt-6">
              <a className={SMALL_BTN_STRONG} href="/projects/new?start=adopt">
                Adopt from one of these accounts
              </a>
            </div>
          )}
        </>
      )}
    </>
  );
}
