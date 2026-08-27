"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";

interface Lead {
  id: string;
  title: string;
  classification: string;
  providers: string[];
  platform: string;
  engagementScore: number | null;
  sourceUrl: string;
  status: string;
  postedAt: string | null;
  community: { name: string };
}

interface ReportData {
  total: number;
  byClassification: Record<string, number>;
  byStatus: Record<string, number>;
  byProvider: { provider: string; count: number }[];
  byPlatform: Record<string, number>;
  crossTab: { provider: string; classification: string; count: number }[];
  topLeads: Lead[];
}

const PROVIDER_LABEL: Record<string, string> = {
  vercel: "Vercel",
  heroku: "Heroku",
  firebase: "Firebase",
  aws: "AWS",
  gcp: "GCP",
  azure: "Azure",
  netlify: "Netlify",
  render: "Render",
  railway: "Railway",
  flyio: "Fly.io",
  digitalocean: "DigitalOcean",
  cloudflare: "Cloudflare",
};

const CLASS_LABEL: Record<string, string> = {
  billing_pain: "Billing Pain",
  migration_interest: "Migration Interest",
  platform_complaint: "Platform Complaint",
};

const CLASS_COLOR: Record<string, string> = {
  billing_pain: "text-danger",
  migration_interest: "text-warn",
  platform_complaint: "text-muted",
};

export default function ReportPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ReportData>("/leads/report")
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="text-danger">{error}</div>;
  if (!data) return <p className="text-muted">Loading report...</p>;

  // Build cross-tab matrix
  const providers = data.byProvider.map((p) => p.provider);
  const classifications = ["billing_pain", "migration_interest", "platform_complaint"];
  const crossMap = new Map<string, number>();
  for (const row of data.crossTab) {
    crossMap.set(`${row.provider}:${row.classification}`, row.count);
  }

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Lead Intelligence Report</h1>
      <p className="text-muted mb-8">
        106 classified leads from developer communities (Jan-Aug 2026). Each lead
        mentions at least one source hosting platform and discusses billing pain,
        migration interest, or platform complaints.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-accent">{data.total}</div>
          <p className="text-muted text-sm">total leads</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-danger">{data.byClassification.billing_pain ?? 0}</div>
          <p className="text-muted text-sm">billing pain</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-warn">{data.byClassification.migration_interest ?? 0}</div>
          <p className="text-muted text-sm">migration interest</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 text-center">
          <div className="text-3xl font-bold text-muted">{data.byClassification.platform_complaint ?? 0}</div>
          <p className="text-muted text-sm">platform complaints</p>
        </div>
      </div>

      {/* Where infralift fits */}
      <div className="bg-surface border border-accent/30 rounded-xl p-6 mb-8">
        <h2 className="text-xl font-bold mb-3">Where infralift fits</h2>
        <p className="text-muted text-sm mb-4">
          75% of leads are billing pain. Developers on Vercel, AWS, and Cloudflare
          are the loudest about costs. The pattern: usage-based pricing is
          predictable at small scale but compounds with growth. infralift's
          fixed-fee migration to Cloudflare Workers or a Hetzner VPS eliminates
          the unpredictability.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <h3 className="text-sm font-semibold text-accent mb-2">Primary targets</h3>
            <ul className="text-muted text-sm space-y-1">
              <li><span className="text-text font-semibold">Vercel</span> (42 leads) - per-seat + usage pricing, $0.15/GB egress</li>
              <li><span className="text-text font-semibold">AWS</span> (37 leads) - NAT gateways, egress, complexity sprawl</li>
              <li><span className="text-text font-semibold">Firebase</span> (12 leads) - Firestore per-read pricing, Studio sunset</li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-accent mb-2">Secondary targets</h3>
            <ul className="text-muted text-sm space-y-1">
              <li><span className="text-text font-semibold">GCP</span> (12 leads) - Cloud Run billing, egress fees</li>
              <li><span className="text-text font-semibold">Cloudflare</span> (24 leads) - Workers limits, overage protection gaps</li>
              <li><span className="text-text font-semibold">Heroku</span> (5 leads) - maintenance mode, stagnation</li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-accent mb-2">Key insight</h3>
            <p className="text-muted text-sm">
              The HN post "Usage circuit breaker for Cloudflare Workers" (29 pts)
              shows developers building DIY cost protection because platforms
              don't offer it. infralift's migration to fixed-cost infrastructure
              removes the need for circuit breakers entirely.
            </p>
          </div>
        </div>
      </div>

      {/* Provider x Classification cross-tab */}
      <div className="bg-surface border border-border rounded-xl p-6 mb-8">
        <h2 className="text-lg font-bold mb-4">Provider pain matrix</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="text-left p-2 border-b border-border text-muted font-medium">Provider</th>
              <th className="text-right p-2 border-b border-border text-danger font-medium">Billing Pain</th>
              <th className="text-right p-2 border-b border-border text-warn font-medium">Migration Interest</th>
              <th className="text-right p-2 border-b border-border text-muted font-medium">Complaint</th>
              <th className="text-right p-2 border-b border-border text-text font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const bp = crossMap.get(`${p}:billing_pain`) ?? 0;
              const mi = crossMap.get(`${p}:migration_interest`) ?? 0;
              const pc = crossMap.get(`${p}:platform_complaint`) ?? 0;
              const total = bp + mi + pc;
              return (
                <tr key={p}>
                  <td className="p-2 border-b border-border text-text font-medium">{PROVIDER_LABEL[p] ?? p}</td>
                  <td className="p-2 border-b border-border text-right text-danger">{bp || ""}</td>
                  <td className="p-2 border-b border-border text-right text-warn">{mi || ""}</td>
                  <td className="p-2 border-b border-border text-right text-muted">{pc || ""}</td>
                  <td className="p-2 border-b border-border text-right text-text font-semibold">{total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Source breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-8">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">By source community</h2>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {Object.entries(data.byPlatform)
                .sort(([, a], [, b]) => b - a)
                .map(([platform, count]) => (
                  <tr key={platform}>
                    <td className="p-2 border-b border-border text-text">{platform}</td>
                    <td className="p-2 border-b border-border text-right text-accent font-semibold">{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <div className="bg-surface border border-border rounded-xl p-6">
          <h2 className="text-lg font-bold mb-4">By lead status</h2>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {Object.entries(data.byStatus)
                .sort(([, a], [, b]) => b - a)
                .map(([status, count]) => (
                  <tr key={status}>
                    <td className="p-2 border-b border-border text-text">{status}</td>
                    <td className="p-2 border-b border-border text-right text-accent font-semibold">{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Top leads */}
      <div className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-bold mb-4">Top 20 leads by engagement</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="text-left p-2 border-b border-border text-muted font-medium text-xs">Score</th>
              <th className="text-left p-2 border-b border-border text-muted font-medium text-xs">Classification</th>
              <th className="text-left p-2 border-b border-border text-muted font-medium text-xs">Providers</th>
              <th className="text-left p-2 border-b border-border text-muted font-medium text-xs">Title</th>
              <th className="text-left p-2 border-b border-border text-muted font-medium text-xs">Source</th>
            </tr>
          </thead>
          <tbody>
            {data.topLeads.map((l) => (
              <tr key={l.id}>
                <td className="p-2 border-b border-border text-accent font-bold">{l.engagementScore ?? 0}</td>
                <td className="p-2 border-b border-border">
                  <span className={CLASS_COLOR[l.classification]}>
                    {CLASS_LABEL[l.classification] ?? l.classification}
                  </span>
                </td>
                <td className="p-2 border-b border-border">
                  <div className="flex flex-wrap gap-1">
                    {(l.providers ?? []).map((p) => (
                      <span key={p} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent-dim text-accent">
                        {PROVIDER_LABEL[p] ?? p}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="p-2 border-b border-border">
                  <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
                    {l.title.length > 70 ? l.title.slice(0, 70) + "..." : l.title}
                  </a>
                </td>
                <td className="p-2 border-b border-border text-muted">{l.community?.name ?? l.platform}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
