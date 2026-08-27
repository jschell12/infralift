"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ProviderConnectionSummary,
  AssessmentSummary,
} from "@infralift/shared";
import { api, formatCents } from "../lib/api";

interface AuthUser {
  email: string;
  name: string | null;
}

const PROVIDER_COSTS: Record<string, { label: string; typical: string; detail: string }> = {
  vercel: {
    label: "Vercel",
    typical: "$200-$3,000+/mo",
    detail: "Per-seat pricing ($20/engineer), $0.15/GB egress, $2/M edge requests",
  },
  heroku: {
    label: "Heroku",
    typical: "$150-$900+/mo",
    detail: "Standard-2X $50/dyno, Performance-M $250/dyno, Postgres $50-200",
  },
  netlify: { label: "Netlify", typical: "$100-$500/mo", detail: "Build minutes, bandwidth, serverless" },
  render: { label: "Render", typical: "$50-$300/mo", detail: "Per-service pricing, managed Postgres" },
  railway: { label: "Railway", typical: "$50-$400/mo", detail: "Usage-based compute + database" },
  flyio: { label: "Fly.io", typical: "$30-$200/mo", detail: "Per-machine pricing, volumes" },
  firebase: { label: "Firebase", typical: "$50-$5,000+/mo", detail: "Per-read/write Firestore, Cloud Functions invocations" },
  aws: { label: "AWS", typical: "Varies", detail: "NAT Gateway, data transfer, managed services" },
  cloudflare: { label: "Cloudflare", typical: "$5-$50/mo", detail: "Workers Paid plan" },
  gcp: { label: "GCP", typical: "Varies", detail: "Cloud Run, Cloud SQL, egress" },
  digitalocean: { label: "DigitalOcean", typical: "$20-$200/mo", detail: "Droplets, App Platform, managed DB" },
  azure: { label: "Azure", typical: "Varies", detail: "App Services, SQL, storage" },
};

const TOP_PROVIDERS = ["vercel", "heroku", "firebase", "aws"] as const;

export default function Dashboard() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>([]);
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [u, c, a] = await Promise.all([
        api<AuthUser>("/auth/me"),
        api<ProviderConnectionSummary[]>("/connections"),
        api<AssessmentSummary[]>("/assessments"),
      ]);
      setUser(u);
      setConnections(c);
      setAssessments(a);
    } catch {
      // auth error handled gracefully
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  const hasConnections = connections.length > 0;
  const completedAssessments = assessments.filter((a) => a.status === "completed");
  const hasAssessments = completedAssessments.length > 0;

  const totalMonthlyCost = completedAssessments.reduce(
    (sum, a) => sum + (a.estimatedMonthlyCostCents ?? 0), 0
  );
  const totalSavings = completedAssessments.reduce(
    (sum, a) => sum + (a.estimatedMonthlySavingsCents ?? 0), 0
  );

  const firstName = user?.name?.split(" ")[0] ?? user?.email?.split("@")[0] ?? "";

  // --- State 3: Has assessment results ---
  if (hasAssessments) {
    return (
      <>
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight mb-1">
            Your infrastructure costs {formatCents(totalMonthlyCost)}/mo
          </h1>
          <p className="text-muted">
            Across {completedAssessments.length} assessed provider{completedAssessments.length > 1 ? "s" : ""}.
            {totalSavings > 0 && (
              <> We found <span className="text-accent font-semibold">{formatCents(totalSavings)}/mo</span> in potential savings.</>
            )}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-surface border border-border rounded-xl p-5">
            <div className="text-xs text-muted uppercase tracking-wide mb-1">Current monthly</div>
            <div className="text-3xl font-bold text-danger">{formatCents(totalMonthlyCost)}</div>
          </div>
          {totalSavings > 0 && (
            <div className="bg-surface border border-accent/20 rounded-xl p-5">
              <div className="text-xs text-muted uppercase tracking-wide mb-1">Estimated savings</div>
              <div className="text-3xl font-bold text-accent">{formatCents(totalSavings)}/mo</div>
            </div>
          )}
          <div className="bg-surface border border-border rounded-xl p-5">
            <div className="text-xs text-muted uppercase tracking-wide mb-1">Resources found</div>
            <div className="text-3xl font-bold">{completedAssessments.reduce((s, a) => s + a.resourceCount, 0)}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {completedAssessments.map((a) => (
            <a key={a.id} href={`/assessments`} className="block bg-surface border border-border rounded-xl p-5 hover:border-accent/40 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold">{a.provider.charAt(0).toUpperCase() + a.provider.slice(1)}</span>
                <span className="text-xs bg-accent-dim text-accent px-2 py-0.5 rounded-full">{a.status}</span>
              </div>
              <div className="text-2xl font-bold text-danger mb-1">{formatCents(a.estimatedMonthlyCostCents)}/mo</div>
              <div className="text-sm text-muted">{a.resourceCount} resources, {a.findingCounts.high + a.findingCounts.medium} findings</div>
            </a>
          ))}
        </div>

        {totalSavings > 0 && (
          <div className="bg-accent-dim/50 border border-accent/20 rounded-xl p-6 text-center">
            <h3 className="text-lg font-semibold mb-2">
              Save {formatCents(totalSavings * 12)}/year with a fixed-fee migration
            </h3>
            <p className="text-sm text-muted mb-4 max-w-lg mx-auto">
              We build the target environment in parallel with zero downtime on your
              current stack, delivered as Terraform in a repo you own.
            </p>
            <a
              href="/migrations"
              className="inline-block px-6 py-3 bg-accent text-bg font-semibold rounded-lg hover:bg-accent/90"
            >
              Start your migration
            </a>
          </div>
        )}

        {connections.filter(c => !completedAssessments.some(a => a.provider === c.provider)).length > 0 && (
          <div className="mt-6 bg-surface border border-border rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-1">Connected but not assessed</h3>
            <p className="text-sm text-muted mb-3">Run assessments on your remaining connections to get the full picture.</p>
            <a href="/assessments" className="text-sm text-accent hover:underline">Run assessments</a>
          </div>
        )}
      </>
    );
  }

  // --- State 2: Has connections, no assessments yet ---
  if (hasConnections) {
    return (
      <>
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight mb-1">
            {firstName ? `${firstName}, your` : "Your"} providers are connected
          </h1>
          <p className="text-muted">
            Run your first assessment to see what you&apos;re paying and where the savings are.
          </p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6 mb-6">
          <h3 className="text-base font-semibold mb-3">Connected</h3>
          <div className="space-y-3">
            {connections.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div>
                  <span className="font-medium">{c.provider.charAt(0).toUpperCase() + c.provider.slice(1)}</span>
                  <span className="text-muted text-sm ml-2">{c.label}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  c.status === "valid"
                    ? "bg-accent-dim text-accent"
                    : "bg-danger/20 text-danger"
                }`}>{c.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-accent-dim/50 border border-accent/20 rounded-xl p-6 text-center">
          <h3 className="text-lg font-semibold mb-2">See what you&apos;re actually paying</h3>
          <p className="text-sm text-muted mb-4 max-w-md mx-auto">
            We&apos;ll inventory every project, service, database, and function,
            then show you the monthly cost and where to cut it.
          </p>
          <a
            href="/assessments"
            className="inline-block px-6 py-3 bg-accent text-bg font-semibold rounded-lg hover:bg-accent/90"
          >
            Run your assessment
          </a>
        </div>
      </>
    );
  }

  // --- State 1: Brand new user, no connections ---
  return (
    <>
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          {firstName ? `${firstName}, let\u2019s` : "Let\u2019s"} find out what your hosting actually costs
        </h1>
        <p className="text-muted text-lg">
          Connect a provider below. We&apos;ll inventory your resources, calculate
          your real monthly spend, and show you what the same stack costs on
          infrastructure you control.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {TOP_PROVIDERS.map((key) => {
          const p = PROVIDER_COSTS[key];
          return (
            <a
              key={key}
              href="/connections"
              className="block bg-surface border border-border rounded-xl p-6 hover:border-accent/40 transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">{p.label}</h3>
                <span className="text-xs text-muted bg-bg px-2.5 py-1 rounded-full">
                  Typical: {p.typical}
                </span>
              </div>
              <p className="text-sm text-muted mb-4">{p.detail}</p>
              <span className="text-sm text-accent font-medium group-hover:underline">
                Connect {p.label} account
              </span>
            </a>
          );
        })}
      </div>

      <div className="bg-surface border border-border rounded-xl p-5 mb-8">
        <button
          className="text-sm text-muted hover:text-text cursor-pointer w-full text-left"
          onClick={(e) => {
            const el = (e.target as HTMLElement).closest(".bg-surface")?.querySelector(".hidden");
            if (el) el.classList.toggle("hidden");
          }}
        >
          + 8 more providers (Netlify, Render, Railway, Fly.io, DigitalOcean, GCP, Azure, Cloudflare)
        </button>
        <div className="hidden grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          {Object.entries(PROVIDER_COSTS)
            .filter(([k]) => !(TOP_PROVIDERS as readonly string[]).includes(k))
            .map(([key, p]) => (
              <a
                key={key}
                href="/connections"
                className="block text-sm text-muted hover:text-accent py-2 px-3 bg-bg rounded-lg"
              >
                {p.label}
              </a>
            ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-2xl font-bold text-accent mb-1">85%</div>
          <p className="text-xs text-muted">average savings for teams migrating off Vercel at scale</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-2xl font-bold text-accent mb-1">2 min</div>
          <p className="text-xs text-muted">to connect and get your first cost report</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-2xl font-bold text-accent mb-1">Read-only</div>
          <p className="text-xs text-muted">we never get write access to your infrastructure</p>
        </div>
      </div>

      <div className="flex items-start gap-2 text-sm text-muted bg-accent-dim/30 border border-accent/10 rounded-lg p-4">
        <svg className="w-4 h-4 mt-0.5 text-accent flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m0 0a2 2 0 100 4 2 2 0 000-4zm6-6V7a6 6 0 10-12 0v4m-2 0h16a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8a1 1 0 011-1z" />
        </svg>
        <span>
          Tokens are encrypted with AES-256 before storage, never displayed again,
          and only used for read-only API calls. Revoke from your provider at any time.
        </span>
      </div>
    </>
  );
}
