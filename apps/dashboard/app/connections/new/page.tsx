"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { AwsSetup } from "@infralift/shared";
import { api, errorText } from "../../../lib/api";
import {
  CONNECTION_TYPES,
  connectionTypeInfo,
  createConnection,
  TFC,
  type ConnectionTypeInfo,
} from "../../../lib/connections";
import { CARD, H1, INPUT, LABEL, Note, PrimaryButton, Skeleton, SMALL_BTN, TEXT_BTN } from "../../../components/ui";

// /connections/new: pick a type, then fill in only that type's fields
// (ADR 0010). The type is in the URL (?type=aws) so back returns to the
// picker and a link can open one type directly. Every type, Terraform Cloud
// included, is stored through createConnection() in lib/connections.ts.

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

export default function NewConnectionPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <NewConnection />
    </Suspense>
  );
}

function NewConnection() {
  const params = useSearchParams();
  const info = connectionTypeInfo(params.get("type"));
  return (
    <>
      <a className={`${TEXT_BTN} ${FOCUS} -ml-1 mb-2 gap-1`} href="/connections">
        <span aria-hidden="true">{"\u2190"}</span>Connections
      </a>
      <h1 className={H1}>{info ? `Connect ${info.name}` : "Add a connection"}</h1>
      {info ? <ConnectionForm key={info.type} info={info} /> : <TypePicker />}
    </>
  );
}

const GROUPS: { key: ConnectionTypeInfo["group"]; title: string; body: string }[] = [
  {
    key: "cloud",
    title: "Cloud providers",
    body: "Read-only access to one account. A project adopts what runs there.",
  },
  {
    key: "code",
    title: "Terraform and code",
    body: "Where the code and state go: a repository host, or a Terraform Cloud organization.",
  },
];

function TypePicker() {
  return (
    <>
      <p className="mb-7 max-w-[620px] text-muted">Pick what you are connecting. The next step shows only its fields.</p>
      {GROUPS.map((g) => (
        <section key={g.key} aria-labelledby={`group-${g.key}`} className="mb-8">
          <h2 id={`group-${g.key}`} className="text-base font-semibold">
            {g.title}
          </h2>
          <p className="mb-3 text-sm text-muted">{g.body}</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {CONNECTION_TYPES.filter((t) => t.group === g.key).map((t) => (
              <li key={t.type}>
                <Link
                  href={`/connections/new?type=${t.type}`}
                  className={`flex min-h-12 items-center rounded-lg border border-border bg-surface px-3 py-2.5 text-[15px] font-semibold text-text hover:border-control active:bg-bg ${FOCUS}`}
                >
                  {t.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function ConnectionForm({ info }: { info: ConnectionTypeInfo }) {
  const router = useRouter();
  const isTfc = info.type === TFC;
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [organization, setOrganization] = useState("");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read on submit itself, before React re-renders the disabled button, so a
  // double tap cannot post twice.
  const inFlight = useRef(false);

  const [awsSetup, setAwsSetup] = useState<AwsSetup | null>(null);
  const [awsError, setAwsError] = useState<string | null>(null);
  useEffect(() => {
    if (info.type !== "aws") return;
    api<AwsSetup>("/connections/aws-setup")
      .then(setAwsSetup)
      .catch((e) => setAwsError(errorText(e)));
  }, [info.type]);
  const awsBlocked = info.type === "aws" && !awsSetup?.enabled;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || awsBlocked) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await createConnection(info.type, { label, token, organization, hostname });
      router.push("/connections");
    } catch (err) {
      setError(errorText(err));
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mb-4">
        <Link className={`${TEXT_BTN} ${FOCUS} -ml-1`} href="/connections/new">
          Pick a different type
        </Link>
      </p>
      <form onSubmit={submit} className={`${CARD} max-w-[640px]`}>
        <label htmlFor="conn-label" className={LABEL}>
          Label
        </label>
        <input
          id="conn-label"
          className={`${INPUT} mb-4`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={isTfc ? "e.g. platform" : "e.g. production"}
          required
        />

        {isTfc && (
          <>
            <label htmlFor="conn-organization" className={LABEL}>
              Organization
            </label>
            <input
              id="conn-organization"
              className={`${INPUT} mb-4`}
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              autoComplete="off"
              required
            />
            <label htmlFor="conn-hostname" className={LABEL}>
              Hostname (Terraform Enterprise only)
            </label>
            <input
              id="conn-hostname"
              className={`${INPUT} mb-4`}
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="app.terraform.io"
              autoComplete="off"
            />
          </>
        )}

        {info.type === "aws" && <AwsSetupPanel setup={awsSetup} error={awsError} />}

        <label htmlFor="conn-token" className={LABEL}>
          {info.secret.label}
        </label>
        {info.secret.kind === "json" ? (
          <textarea
            id="conn-token"
            className={`${INPUT} mb-4 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={info.type === "azure" ? 4 : 6}
            placeholder={info.secret.placeholder}
            autoComplete="off"
            spellCheck={false}
            required
          />
        ) : (
          <input
            id="conn-token"
            className={`${INPUT} mb-4 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={info.secret.kind === "arn" ? "text" : "password"}
            placeholder={info.secret.placeholder}
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}

        <div className="mb-3">
          <Note tone="emphasis">
            {info.readOnly
              ? "Your credential is encrypted with AES-256 before storage, never displayed again, and only used for read-only API calls. You can revoke it from your provider at any time."
              : "Your credential is encrypted with AES-256 before storage and never displayed again. You can revoke it at any time."}
          </Note>
        </div>
        <div className="mb-5 rounded-lg border border-border bg-bg p-3 text-[13px] leading-relaxed text-muted">
          {info.help}
        </div>

        <PrimaryButton disabled={busy || awsBlocked}>{busy ? "Verifying..." : "Connect & verify"}</PrimaryButton>
        {error && (
          <div role="alert" className="mt-3 text-sm text-danger">
            {error}
          </div>
        )}
      </form>
    </>
  );
}

function CopyBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-muted">{title}</span>
        <button
          type="button"
          className={SMALL_BTN}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs text-muted">
        {text}
      </pre>
    </div>
  );
}

/** AWS setup: this org's external ID and the policies to paste into the IAM
 *  role before its ARN goes in the field below. */
function AwsSetupPanel({ setup, error }: { setup: AwsSetup | null; error: string | null }) {
  if (error) {
    return (
      <div className="mb-4">
        <Note>{error}</Note>
      </div>
    );
  }
  if (!setup) {
    return (
      <div role="status" aria-label="Loading AWS setup" className="mb-4">
        <Skeleton className="h-3 w-1/3 mb-2" />
        <Skeleton className="h-9 w-full mb-3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!setup.enabled) {
    return (
      <div className="mb-4">
        <Note>AWS isn&apos;t available yet on this server. Connect another provider for now.</Note>
      </div>
    );
  }
  return (
    <div className="mb-2">
      <div className={LABEL}>Your external ID</div>
      <div className="mb-3 break-all rounded-lg border border-border bg-bg p-2 font-mono text-xs">{setup.externalId}</div>
      <CopyBlock title="Trust policy" text={setup.trustPolicy ?? ""} />
      <CopyBlock title="Permissions policy" text={setup.permissionsPolicy ?? ""} />
    </div>
  );
}
