"use client";

import { useCallback, useEffect, useState } from "react";
import {
  orgSpendTotals,
  type ProviderConnectionSummary,
  type AssessmentSummary,
} from "@infralift/shared";
import { api, errorText, formatCents, savingsNote } from "../lib/api";
import {
  Card,
  CardTitle,
  Chip,
  ErrorState,
  H1,
  LEAD,
  NUM,
  Note,
  PrimaryButton,
  Skeleton,
  SkeletonCards,
  StatCard,
} from "../components/ui";

interface AuthUser {
  email: string;
  name: string | null;
}

const PROVIDER_COSTS: Record<
  string,
  { label: string; typical: string; detail: string }
> = {
  vercel: {
    label: "Vercel",
    typical: "$200-$3,000+/mo",
    detail:
      "Per-seat pricing ($20/engineer), $0.15/GB egress, $2/M edge requests",
  },
  heroku: {
    label: "Heroku",
    typical: "$150-$900+/mo",
    detail:
      "Standard-2X $50/dyno, Performance-M $250/dyno, Postgres $50-200",
  },
  firebase: {
    label: "Firebase",
    typical: "$50-$5,000+/mo",
    detail: "Per-read/write Firestore, Cloud Functions invocations",
  },
  aws: {
    label: "AWS",
    typical: "Varies",
    detail: "NAT Gateway, data transfer, managed services",
  },
  netlify: {
    label: "Netlify",
    typical: "$100-$500/mo",
    detail: "Build minutes, bandwidth, serverless",
  },
  render: {
    label: "Render",
    typical: "$50-$300/mo",
    detail: "Per-service pricing, managed Postgres",
  },
  railway: {
    label: "Railway",
    typical: "$50-$400/mo",
    detail: "Usage-based compute + database",
  },
  flyio: {
    label: "Fly.io",
    typical: "$30-$200/mo",
    detail: "Per-machine pricing, volumes",
  },
  cloudflare: {
    label: "Cloudflare",
    typical: "$5-$50/mo",
    detail: "Workers Paid plan",
  },
  gcp: { label: "GCP", typical: "Varies", detail: "Cloud Run, Cloud SQL, egress" },
  digitalocean: {
    label: "DigitalOcean",
    typical: "$20-$200/mo",
    detail: "Droplets, App Platform, managed DB",
  },
  azure: {
    label: "Azure",
    typical: "Varies",
    detail: "App Services, SQL, storage",
  },
};

const TOP_PROVIDERS = ["vercel", "heroku", "firebase", "aws"] as const;

export default function Dashboard() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>(
    []
  );
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load is said, with a retry. It used to be swallowed, which
  // dropped a signed-in customer with connections into new-user onboarding.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [u, c, a] = await Promise.all([
        api<AuthUser>("/auth/me"),
        api<ProviderConnectionSummary[]>("/connections"),
        api<AssessmentSummary[]>("/assessments"),
      ]);
      setUser(u);
      setConnections(c);
      setAssessments(a);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div>
        <Skeleton className="h-8 w-2/3 max-w-[420px] mb-3" />
        <Skeleton className="h-4 w-1/2 max-w-[320px] mb-7" />
        <SkeletonCards count={3} label="Loading your dashboard" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <h1 className={H1}>Dashboard</h1>
        <p className={LEAD}>Your connections and assessments could not be loaded.</p>
        <ErrorState message={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  // One assessment per connection (an "Assess again" rerun replaces the
  // earlier run rather than adding to it), each at the bill the options page
  // compares against. An unknown bill is said, never summed as zero.
  const {
    counted: completed,
    knownMonthlyCents: totalCost,
    unknownCount,
  } = orgSpendTotals(assessments);
  const unknownNote =
    unknownCount > 0
      ? `unknown for ${unknownCount} stack${unknownCount === 1 ? "" : "s"}`
      : null;
  const costHeadline =
    unknownCount === completed.length
      ? "unknown"
      : `${formatCents(totalCost)}/mo${unknownCount > 0 ? "+" : ""}`;
  // Net savings across every assessed stack, so a split stack (a Vercel
  // frontend and a Heroku backend) adds up. Each figure is that assessment's
  // best sized target after operations work, the same number its options
  // page leads with. A stack where staying put is cheaper adds nothing rather
  // than subtracting, because nobody moves one stack at a loss to pay for
  // another. Unknown is counted and said, never summed as zero.
  const compared = completed.filter((a) => a.netMonthlySavingsCents !== null);
  const totalSavings = compared.reduce(
    (s, a) => s + Math.max(0, a.netMonthlySavingsCents!),
    0
  );
  const notCompared = completed.length - compared.length;
  const needBill = completed.filter(
    (a) => a.currentSpend.source === "unknown"
  ).length;
  const whoNeedsBill =
    needBill === notCompared
      ? needBill === 1
        ? "it needs"
        : "they need"
      : `${needBill} ${needBill === 1 ? "needs" : "need"}`;
  const biggest = [...compared].sort(
    (a, b) => b.netMonthlySavingsCents! - a.netMonthlySavingsCents!
  )[0];
  const firstName =
    user?.name?.split(" ")[0] ?? user?.email?.split("@")[0] ?? "";

  // ── State 3: assessed ────────────────────────────────────────
  if (completed.length > 0) {
    return (
      <>
        <h1 className={H1}>
          {unknownCount === completed.length
            ? "Your infrastructure cost is unknown"
            : `Your infrastructure costs ${costHeadline}`}
        </h1>
        <p className="text-muted mb-7">
          Across {completed.length} assessed provider
          {completed.length > 1 ? "s" : ""}
          {unknownNote && unknownCount < completed.length ? `, ${unknownNote}` : ""}.
          {totalSavings > 0 && (
            <>
              {" "}
              We found{" "}
              <span className="font-semibold text-accent">
                {formatCents(totalSavings)}/mo
              </span>{" "}
              in net savings after operations work.
            </>
          )}
          {notCompared > 0 && (
            <>
              {" "}
              {notCompared} of {completed.length} {notCompared === 1 ? "has" : "have"}{" "}
              no savings figure yet
              {needBill > 0 ? `: ${whoNeedsBill} your monthly bill, entered on the options page.` : "."}
            </>
          )}
        </p>

        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard
            label="Current monthly"
            value={unknownCount === completed.length ? "unknown" : formatCents(totalCost)}
            sub={unknownNote ?? undefined}
            tone={unknownCount === completed.length ? "muted" : "danger"}
          />
          <StatCard
            label="Net savings"
            value={compared.length > 0 ? `${formatCents(totalSavings)}/mo` : "\u2014"}
            sub={
              notCompared === 0
                ? "after operations work"
                : `${notCompared} of ${completed.length} not counted yet`
            }
            tone="accent"
          />
          <StatCard
            label="Resources found"
            value={completed.reduce((s, a) => s + a.resourceCount, 0)}
            tone="muted"
          />
        </div>

        <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {completed.map((a) => (
            <a
              key={a.id}
              href={`/assessments/${a.id}`}
              className={`block bg-surface border border-border rounded-xl p-5 hover:border-accent`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold capitalize">
                  {a.provider}
                </span>
                <Chip tone="accent">{a.status}</Chip>
              </div>
              <div className={`mb-1 text-2xl font-bold text-danger ${NUM}`}>
                {a.currentSpend.monthlyCents === null
                  ? "unknown"
                  : `${formatCents(a.currentSpend.monthlyCents)}/mo`}
              </div>
              <div className="text-sm text-muted">
                {a.resourceCount} resources,{" "}
                {a.findingCounts.high + a.findingCounts.medium} findings &middot;{" "}
                {savingsNote(a)} &middot; open report &rarr;
              </div>
            </a>
          ))}
        </div>

        {totalSavings > 0 && (
          <div className="rounded-xl border border-accent/20 bg-accent-dim/40 p-7 text-center">
            <h3 className="mb-2 text-[19px] font-semibold">
              Save {formatCents(totalSavings * 12)}/year with a fixed-fee
              migration
            </h3>
            <p className="mx-auto mb-5 max-w-[480px] text-sm text-muted">
              We build the target environment in parallel with zero downtime on
              your current stack, delivered as Terraform in a repo you own.
            </p>
            <PrimaryButton href={`/assessments/${(biggest ?? completed[0]).id}/options`}>
              Compare targets
            </PrimaryButton>
          </div>
        )}
      </>
    );
  }

  // ── State 2: connected, not assessed ─────────────────────────
  if (connections.length > 0) {
    return (
      <>
        <h1 className={H1}>
          {firstName ? `${firstName}, your` : "Your"} providers are connected
        </h1>
        <p className="text-muted mb-7">
          Run your first assessment to see what you&apos;re paying and where the
          savings are.
        </p>

        <Card className="mb-5">
          <CardTitle>Connected</CardTitle>
          <div className="flex flex-col">
            {connections.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between border-b border-border py-2.5 last:border-0"
              >
                <div>
                  <span className="font-medium capitalize">{c.provider}</span>
                  <span className="ml-2 text-sm text-muted">{c.label}</span>
                </div>
                <Chip tone={c.status === "valid" ? "accent" : "danger"}>
                  {c.status}
                </Chip>
              </div>
            ))}
          </div>
        </Card>

        <div className="rounded-xl border border-accent/20 bg-accent-dim/40 p-7 text-center">
          <h3 className="mb-2 text-[19px] font-semibold">
            See what you&apos;re actually paying
          </h3>
          <p className="mx-auto mb-5 max-w-[440px] text-sm text-muted">
            We&apos;ll inventory every project, service, database, and function,
            then show you the monthly cost and where to cut it.
          </p>
          <PrimaryButton href="/projects?start=existing">Run your assessment</PrimaryButton>
        </div>
      </>
    );
  }

  // ── State 1: brand new ───────────────────────────────────────
  const rest = Object.entries(PROVIDER_COSTS).filter(
    ([k]) => !(TOP_PROVIDERS as readonly string[]).includes(k)
  );

  return (
    <>
      <h1 className="mb-2 text-3xl font-bold tracking-[-0.02em]">
        {firstName ? `${firstName}, let\u2019s` : "Let\u2019s"} find out what your
        hosting actually costs
      </h1>
      <p className="mb-8 text-lg text-muted">
        Connect a provider below. We&apos;ll inventory your resources, calculate
        your real monthly spend, and show you what the same stack costs on
        infrastructure you control.
      </p>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {TOP_PROVIDERS.map((key) => {
          const p = PROVIDER_COSTS[key];
          return (
            <a
              key={key}
              href={`/connections?provider=${key}`}
              className="group block rounded-xl border border-border bg-surface p-5 hover:border-accent"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[17px] font-semibold">{p.label}</h3>
                <span className="rounded-full bg-bg px-2.5 py-1 text-xs text-muted">
                  Typical: {p.typical}
                </span>
              </div>
              <p className="mb-3.5 text-sm text-muted">{p.detail}</p>
              <span className="text-sm font-medium text-accent">
                Connect {p.label} account &rarr;
              </span>
            </a>
          );
        })}
      </div>

      <Card className="mb-6">
        <button
          className="w-full cursor-pointer text-left text-sm text-muted hover:text-text"
          onClick={() => setShowAll((v) => !v)}
        >
          + {rest.length} more providers (Netlify, Render, Railway, Fly.io,
          DigitalOcean, GCP, Azure, Cloudflare)
        </button>
        {showAll && (
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {rest.map(([key, p]) => (
              <a
                key={key}
                href={`/connections?provider=${key}`}
                className="block rounded-lg bg-bg px-3 py-2 text-sm text-muted hover:text-accent"
              >
                {p.label}
              </a>
            ))}
          </div>
        )}
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatCard label="Time to first report" value="2 min" sub="connect and run" />
        <StatCard label="Access level" value="Read-only" sub="never write" />
      </div>

      <Note tone="accent">
        Tokens are encrypted with AES-256 before storage, never displayed again,
        and only used for read-only API calls. Revoke from your provider at any
        time.
      </Note>
    </>
  );
}
