"use client";

import { useState } from "react";

import { verifiedMonth } from "../../lib/prices";

// The public calculator. Like assessment-form.tsx this is deliberately
// dependency-free: the marketing site is a static export and this is the only
// other interactive thing on it.
//
// It posts to /a/estimate on the Worker rather than to the API directly, for
// the same two reasons the lead form does: same-origin, so no CORS preflight
// and no public origin widening a credentialed allowlist, and the API sits
// behind Cloudflare Access, so the Worker is the only place that can hold a
// service token for it.

const FIELD =
  "w-full rounded-lg border border-border bg-bg px-3.5 py-2.5 text-[15px] text-text placeholder:text-faint focus:border-accent focus:outline-none";
const LABEL_CLS = "block text-[13px] font-semibold text-muted mb-1.5";
const HINT = "mt-1 text-[13px] text-muted";

const PROVIDERS = [
  "Vercel",
  "Heroku",
  "Netlify",
  "Render",
  "Railway",
  "Fly.io",
  "DigitalOcean",
  "Firebase / GCP",
  "AWS",
  "Something else",
];

const RAM_CHOICES = [
  { value: 512, label: "512 MB" },
  { value: 1024, label: "1 GB" },
  { value: 2048, label: "2 GB" },
  { value: 4096, label: "4 GB" },
  { value: 8192, label: "8 GB" },
  { value: 14336, label: "14 GB" },
];

const TIERS = [
  { value: "none", label: "None" },
  { value: "small", label: "Small (hobby / essential)" },
  { value: "large", label: "Large (standard / premium)" },
];

// Shapes mirror apps/api/src/lib/estimate.ts. They are redeclared rather than
// imported because apps/web has no dependency on @infralift/shared and this
// page is not worth adding one for; the API owns the arithmetic either way.
interface LineItem {
  label: string;
  monthlyCents: number;
  note?: string;
}

interface EstimateTarget {
  slug: string;
  name: string;
  monthlyCents: number;
  lineItems: LineItem[];
  ops: { hoursPerMonth: number; monthlyCents: number; note: string };
  eligible: boolean;
  ineligibleReason?: string;
  grossMonthlySavingsCents: number | null;
  netMonthlySavingsCents: number | null;
  netAnnualSavingsCents: number | null;
}

interface EstimateResult {
  targets: EstimateTarget[];
  bestSlug: string | null;
  assumptions: string[];
  pricesVerifiedAt?: string;
}

function usd(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: dollars >= 100 ? 0 : 2,
  });
}

export function Calculator() {
  const [state, setState] = useState<"idle" | "running">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "running") return;
    setState("running");
    setError(null);

    const form = new FormData(e.currentTarget);
    const spend = String(form.get("monthlySpendUsd") ?? "").trim();

    try {
      const res = await fetch("/a/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceProvider: form.get("sourceProvider") || undefined,
          // Blank means "I don't know". Sending 0 would be a claim that they
          // pay nothing, and the API answers those differently.
          monthlySpendUsd: spend === "" ? undefined : spend,
          runtime: form.get("runtime"),
          webInstances: form.get("webInstances"),
          workerInstances: form.get("workerInstances"),
          ramPerInstanceMb: form.get("ramPerInstanceMb"),
          postgres: form.get("postgres"),
          redis: form.get("redis"),
          bandwidthGbMonth: form.get("bandwidthGbMonth"),
          requestsMillionsMonth: form.get("requestsMillionsMonth"),
          objectStorageGb: form.get("objectStorageGb"),
          hourlyRateUsd: form.get("hourlyRateUsd"),
          website: form.get("website") || undefined,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
        setState("idle");
        return;
      }
      setResult((await res.json()) as EstimateResult);
      setState("idle");
    } catch {
      setError("Could not reach us. Check your connection and try again.");
      setState("idle");
    }
  }

  return (
    <div className="grid gap-10">
      <form onSubmit={submit} className="grid gap-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={LABEL_CLS} htmlFor="est-provider">
              Where you run today
            </label>
            <select
              id="est-provider"
              name="sourceProvider"
              defaultValue="Vercel"
              className={FIELD}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-spend">
              Current bill, per month
            </label>
            <input
              id="est-spend"
              name="monthlySpendUsd"
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              className={FIELD}
              placeholder="755"
            />
            <p className={HINT}>
              Leave blank if you are not sure. You will get the target cost
              without a savings claim.
            </p>
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-runtime">
              What it runs on
            </label>
            <select
              id="est-runtime"
              name="runtime"
              defaultValue="js"
              className={FIELD}
            >
              <option value="js">Node, JavaScript, or static</option>
              <option value="other">Rails, Django, Java, Go, or native</option>
            </select>
            <p className={HINT}>
              Decides whether Workers is even an option for you.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={LABEL_CLS} htmlFor="est-web">
              Web processes
            </label>
            <input
              id="est-web"
              name="webInstances"
              type="number"
              min={0}
              max={200}
              defaultValue={2}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-workers">
              Background workers
            </label>
            <input
              id="est-workers"
              name="workerInstances"
              type="number"
              min={0}
              max={200}
              defaultValue={0}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-ram">
              RAM per process
            </label>
            <select
              id="est-ram"
              name="ramPerInstanceMb"
              defaultValue={1024}
              className={FIELD}
            >
              {RAM_CHOICES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={LABEL_CLS} htmlFor="est-postgres">
              Postgres
            </label>
            <select
              id="est-postgres"
              name="postgres"
              defaultValue="small"
              className={FIELD}
            >
              {TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-redis">
              Redis
            </label>
            <select
              id="est-redis"
              name="redis"
              defaultValue="none"
              className={FIELD}
            >
              {TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={LABEL_CLS} htmlFor="est-bandwidth">
              Egress, GB per month
            </label>
            <input
              id="est-bandwidth"
              name="bandwidthGbMonth"
              type="number"
              min={0}
              defaultValue={500}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-requests">
              Requests, millions per month
            </label>
            <input
              id="est-requests"
              name="requestsMillionsMonth"
              type="number"
              min={0}
              step="0.1"
              defaultValue={10}
              required
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="est-storage">
              Object storage, GB
            </label>
            <input
              id="est-storage"
              name="objectStorageGb"
              type="number"
              min={0}
              defaultValue={50}
              required
              className={FIELD}
            />
          </div>
        </div>

        <div className="max-w-[280px]">
          <label className={LABEL_CLS} htmlFor="est-rate">
            Your engineer hourly rate
          </label>
          <input
            id="est-rate"
            name="hourlyRateUsd"
            type="number"
            min={0}
            max={2000}
            defaultValue={150}
            required
            className={FIELD}
          />
          <p className={HINT}>
            Used to price the operations work a move hands back to you. Set it
            to 0 if you want to see the number without it.
          </p>
        </div>

        {/* Honeypot. Hidden from people and from screen readers; bots fill it. */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="est-website">Website</label>
          <input
            id="est-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {error && <div className="text-[13px] text-danger">{error}</div>}

        <div className="flex flex-wrap items-center gap-3.5">
          <button
            type="submit"
            disabled={state === "running"}
            className="rounded-lg border-0 bg-accent px-6 py-3 text-[15px] font-semibold text-bg hover:bg-accent/90 disabled:cursor-default disabled:opacity-50"
          >
            {state === "running" ? "Working..." : "Show me the number"}
          </button>
          <span className="text-[13px] text-muted">
            No account, no token, nothing stored.
          </span>
        </div>
      </form>

      {result && <Result result={result} />}
    </div>
  );
}

function Result({ result }: { result: EstimateResult }) {
  const { targets, bestSlug, assumptions } = result;
  const best = targets.find((t) => t.slug === bestSlug) ?? null;
  const verified = verifiedMonth(result.pricesVerifiedAt);

  return (
    <div className="grid gap-6 border-t border-border pt-10">
      {/* The headline. A null bestSlug is a real answer, not an empty state:
          telling someone not to move is what makes the rest of the page
          believable, and it saves both sides a call. */}
      {best && best.netAnnualSavingsCents !== null ? (
        <div className="rounded-xl border border-accent/20 bg-accent-dim/40 p-6">
          <div className="text-[15px] font-semibold text-accent">
            Best fit: {best.name}
          </div>
          <div className="mt-2 text-4xl font-bold tracking-[-0.02em]">
            {usd(best.netAnnualSavingsCents)}
            <span className="text-xl font-semibold text-muted"> / year</span>
          </div>
          <p className="mt-2 text-[15px] text-muted">
            After the operations work is priced in. Gross difference is{" "}
            {usd(best.grossMonthlySavingsCents ?? 0)}/mo, the operations line
            costs {usd(best.ops.monthlyCents)}/mo, so you keep{" "}
            {usd(best.netMonthlySavingsCents ?? 0)}/mo.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-6">
          <h3 className="text-lg font-semibold">
            On these numbers, we would not move you.
          </h3>
          <p className="mt-2 text-[15px] text-muted">
            {targets.some((t) => t.netMonthlySavingsCents !== null)
              ? "Once the operations work is priced in, nothing here beats what you pay today. That can change quickly with egress or headcount, so it is worth re-running when your traffic does."
              : "Without a current bill there is nothing to compare against. The target costs below are still real."}
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {targets.map((t) => (
          <div
            key={t.slug}
            className={`rounded-xl border p-6 ${
              t.slug === bestSlug
                ? "border-accent/30 bg-surface"
                : "border-border bg-surface"
            } ${t.eligible ? "" : "opacity-70"}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-base font-semibold">{t.name}</h4>
              <div className="text-lg font-bold">
                {usd(t.monthlyCents)}
                <span className="text-[13px] font-normal text-muted">/mo</span>
              </div>
            </div>

            {!t.eligible && (
              <p className="mt-3 rounded-lg border border-border bg-bg p-3 text-[13px] text-muted">
                <span className="font-semibold text-text">
                  Not a fit for your stack.{" "}
                </span>
                {t.ineligibleReason}
              </p>
            )}

            <table className="mt-4 w-full text-[13px]">
              <tbody>
                {t.lineItems.map((li, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-3 text-muted">{li.label}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {li.monthlyCents === 0 ? "included" : usd(li.monthlyCents)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td className="py-1.5 pr-3 font-semibold">
                    Operations, {t.ops.hoursPerMonth} hr/mo
                  </td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">
                    {usd(t.ops.monthlyCents)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className={HINT}>{t.ops.note}</p>

            {t.netMonthlySavingsCents !== null && (
              <div className="mt-4 border-t border-border pt-3 text-[15px]">
                <span className="text-muted">Net against your bill: </span>
                <span
                  className={`font-semibold tabular-nums ${
                    t.netMonthlySavingsCents > 0 ? "text-accent" : "text-danger"
                  }`}
                >
                  {t.netMonthlySavingsCents > 0 ? "saves " : "costs "}
                  {usd(Math.abs(t.netMonthlySavingsCents))}/mo
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-surface p-6">
        <h4 className="text-base font-semibold text-text">
          What this assumes
        </h4>
        <ul className="mt-3 grid gap-2 text-[14px] text-muted">
          {assumptions.map((a, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-faint">&middot;</span>
              <span>{a}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[14px] text-muted">
          These are the numbers you typed, priced against the same model that
          produces our assessments and the Terraform we generate from them. The
          assessment reads your actual account, so it corrects whatever you
          guessed here.
          {verified && <> Prices verified {verified}.</>}
        </p>
      </div>
    </div>
  );
}
