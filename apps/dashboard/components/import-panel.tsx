"use client";

import { useEffect, useState } from "react";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { api } from "../lib/api";
import { Chip, INPUT, LABEL, MONO, Note, PrimaryButton, type Tone } from "./ui";

// "From a Terraform repo": scan a GitHub repository for root modules and
// import one. Importing adds a read-only plan check to the repository as a
// pull request; the module is safe to take over once that plan changes
// nothing. infralift reads the code only, never the state or credentials.

interface ScannedRoot {
  path: string;
  backend: {
    kind: string;
    type: string | null;
    settings: Record<string, string>;
    partial: boolean;
    configFiles: string[];
  };
  providers: { name: string; source: string; version: string | null }[];
  resources: number;
  dataSources: number;
  moduleCalls: number;
  requiredVariables: string[];
  tool: "terraform" | "tofu";
  readiness: "ready" | "adopt-tfc" | "blocked";
  notes: string[];
  secrets: string[];
  /** What to set, one line per cloud (keys or OIDC) or secret. Markdown code spans. */
  setup: string[];
  checkFile: string;
}

interface ScanResponse {
  repo: string;
  ref: string;
  filesRead: number;
  skipped: string[];
  errors: { path: string; message: string }[];
  roots: ScannedRoot[];
}

const BACKEND_NAMES: Record<string, string> = {
  s3: "S3",
  r2: "Cloudflare R2",
  gcs: "Google Cloud Storage",
  azurerm: "Azure Storage",
  tfc: "Terraform Cloud",
  local: "Local state",
  other: "Other backend",
};

const READINESS: Record<ScannedRoot["readiness"], { tone: Tone; text: string }> = {
  ready: { tone: "accent", text: "Ready to import" },
  "adopt-tfc": { tone: "info", text: "Adopt from Terraform Cloud" },
  blocked: { tone: "warn", text: "Needs a change first" },
};

/** A project name from the repo and module path: acme/infra + envs/prod = infra-envs-prod. */
export function suggestName(repo: string, path: string): string {
  const base = `${repo.split("/").pop() ?? ""}${path ? `-${path}` : ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = /^[a-z]/.test(base) ? base : `tf-${base}`;
  return name.slice(0, 32).replace(/-+$/, "");
}

export function ImportPanel({ onCreated }: { onCreated: () => void }) {
  const [conns, setConns] = useState<ProviderConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ProviderConnectionSummary[]>("/connections")
      .then((c) => {
        const gh = c.filter((x) => x.provider === "github");
        setConns(gh);
        setConnectionId(gh[0]?.id ?? "");
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  async function doScan() {
    setBusy("scan");
    setError(null);
    setScan(null);
    try {
      setScan(
        await api<ScanResponse>("/tf/imports/scan", {
          method: "POST",
          body: JSON.stringify({ repo: repo.trim(), ref: ref.trim() || undefined, connectionId: connectionId || undefined }),
        })
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!conns.length && !error) {
    return (
      <Note>
        Connect GitHub under <a className="text-accent" href="/connections">Connections</a> first. infralift reads
        the repository&apos;s Terraform with it and opens the import pull request.
      </Note>
    );
  }

  return (
    <div>
      <p className="text-sm text-muted mb-4">
        infralift reads your Terraform, then adds a check to the repository that plans against your existing state,
        read-only, in your own CI. A module is imported once that plan changes nothing, so nothing that is running
        gets touched.
      </p>
      {conns.length > 1 && (
        <>
          <label className={LABEL}>GitHub connection</label>
          <select className={`${INPUT} mb-4`} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {conns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="grid grid-cols-[1fr_140px] gap-2 mb-4">
        <div>
          <label className={LABEL}>Repository</label>
          <input className={INPUT} placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </div>
        <div>
          <label className={LABEL}>Branch</label>
          <input className={INPUT} placeholder="default" value={ref} onChange={(e) => setRef(e.target.value)} />
        </div>
      </div>
      <PrimaryButton onClick={doScan} disabled={!/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) || busy !== null}>
        {busy === "scan" ? "Scanning…" : "Scan repository"}
      </PrimaryButton>

      {error && <div className="text-danger text-sm mt-4">{error}</div>}

      {scan && (
        <div className="mt-6">
          <div className="text-xs text-faint mb-3">
            {scan.filesRead} Terraform files read on {scan.ref}; {scan.roots.length} root module
            {scan.roots.length === 1 ? "" : "s"}.
          </div>
          {[...scan.skipped, ...scan.errors.map((e) => `${e.path} did not parse: ${e.message}`)].map((s) => (
            <div key={s} className="text-xs text-warn mb-1">
              {s}
            </div>
          ))}
          {scan.roots.length === 0 && (
            <Note>No Terraform root modules found. A root module is a directory with a backend, or with resources that no other directory calls as a module.</Note>
          )}
          <div className="grid gap-3">
            {scan.roots.map((r) => (
              <RootCard key={r.path} root={r} scan={scan} connectionId={connectionId} onCreated={onCreated} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RootCard({
  root,
  scan,
  connectionId,
  onCreated,
}: {
  root: ScannedRoot;
  scan: ScanResponse;
  connectionId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState(suggestName(scan.repo, root.path));
  const [configFile, setConfigFile] = useState(root.backend.configFiles.length === 1 ? root.backend.configFiles[0] : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = READINESS[root.readiness];
  const where = [root.backend.settings.bucket, root.backend.settings.key ?? root.backend.settings.prefix]
    .filter(Boolean)
    .join("/");
  const needsFile = root.backend.partial && root.backend.configFiles.length > 1;

  async function doImport() {
    setBusy(true);
    setError(null);
    try {
      await api("/tf/imports", {
        method: "POST",
        body: JSON.stringify({
          repo: scan.repo,
          ref: scan.ref,
          path: root.path,
          name,
          connectionId: connectionId || undefined,
          backendConfigFile: needsFile ? configFile : undefined,
        }),
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-bg p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-sm font-semibold ${MONO}`}>{root.path || "/"}</span>
        <Chip tone={r.tone}>{r.text}</Chip>
      </div>
      <div className="text-xs text-muted mb-2">
        {BACKEND_NAMES[root.backend.kind] ?? root.backend.kind}
        {where && <span className={MONO}> · {where}</span>} · {root.resources} resource{root.resources === 1 ? "" : "s"}
        {root.moduleCalls > 0 && ` · ${root.moduleCalls} module call${root.moduleCalls === 1 ? "" : "s"}`} ·{" "}
        {root.tool === "tofu" ? "OpenTofu" : "Terraform"}
      </div>
      {root.providers.length > 0 && (
        <div className={`text-[11px] text-faint mb-2 ${MONO}`}>{root.providers.map((p) => p.source).join(", ")}</div>
      )}
      {root.notes.map((n) => (
        <div key={n} className="text-xs text-warn mb-1">
          {n}
        </div>
      ))}
      {root.readiness === "adopt-tfc" && (
        <a className="text-accent text-sm font-semibold" href="/workspaces">
          Adopt the workspace
        </a>
      )}
      {root.readiness === "ready" && (
        <div className="mt-3">
          {root.setup.length > 0 && (
            <div className="text-xs text-muted mb-3">
              Before the check can run, set in the repository:
              <ul className="mt-1 list-disc pl-4">
                {root.setup.map((l) => (
                  <li key={l}>
                    {l.split("`").map((part, i) =>
                      i % 2 ? (
                        <span key={i} className={MONO}>
                          {part}
                        </span>
                      ) : (
                        part
                      )
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {needsFile && (
            <>
              <label className={LABEL}>Backend config file</label>
              <select className={`${INPUT} mb-3`} value={configFile} onChange={(e) => setConfigFile(e.target.value)}>
                <option value="">Pick one</option>
                {root.backend.configFiles.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className={LABEL}>Project name</label>
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <PrimaryButton onClick={doImport} disabled={busy || !name || (needsFile && !configFile)}>
              {busy ? "Importing…" : "Import"}
            </PrimaryButton>
          </div>
          {error && <div className="text-danger text-sm mt-2">{error}</div>}
        </div>
      )}
    </div>
  );
}
