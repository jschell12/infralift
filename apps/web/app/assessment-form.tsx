"use client";

import { useState } from "react";

// The only interactive component on the marketing site. Everything else is a
// static export, so this is deliberately dependency-free: no form library, no
// validation library, no analytics wrapper.

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

const SPEND = [
  "under $200/mo",
  "$200 - $500/mo",
  "$500 - $1,500/mo",
  "$1,500 - $5,000/mo",
  "over $5,000/mo",
];

const FIELD =
  "w-full rounded-lg border border-border bg-bg px-3.5 py-2.5 text-[15px] text-text placeholder:text-faint focus:border-accent focus:outline-none";
const LABEL_CLS = "block text-[13px] font-semibold text-muted mb-1.5";

/** The /leaving pages know the provider but spell it their own way
 * ("Firebase" against this list's "Firebase / GCP"), and a defaultValue that
 * matches no option silently selects nothing. Match loosely, then fall back to
 * offering the caller's spelling as its own option. */
function providerOptions(provider?: string): { options: string[]; selected: string } {
  if (!provider) return { options: PROVIDERS, selected: "" };
  const key = provider.toLowerCase();
  const match = PROVIDERS.find(
    (p) => p.toLowerCase() === key || p.toLowerCase().startsWith(key)
  );
  if (match) return { options: PROVIDERS, selected: match };
  return { options: [provider, ...PROVIDERS], selected: provider };
}

export function AssessmentForm({ provider }: { provider?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const { options, selected } = providerOptions(provider);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setError(null);

    const form = new FormData(e.currentTarget);
    const params = new URLSearchParams(window.location.search);

    try {
      const res = await fetch("/a/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          name: form.get("name") || undefined,
          company: form.get("company") || undefined,
          provider: form.get("provider") || undefined,
          monthlySpend: form.get("monthlySpend") || undefined,
          message: form.get("message") || undefined,
          // Honeypot: hidden from real users, so anything here is a bot.
          website: form.get("website") || undefined,
          sourcePath: window.location.pathname,
          referrer: document.referrer || undefined,
          utmSource: params.get("utm_source") || undefined,
          utmMedium: params.get("utm_medium") || undefined,
          utmCampaign: params.get("utm_campaign") || undefined,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
        setState("idle");
        return;
      }
      setState("sent");
    } catch {
      setError("Could not reach us. Check your connection and try again.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div className="rounded-xl border border-accent/20 bg-accent-dim/40 p-6">
        <h3 className="mb-1.5 text-lg font-semibold">Got it.</h3>
        <p className="text-[15px] text-muted">
          We read every one of these ourselves. If an assessment makes sense
          for your stack we will come back asking for a read-only token. If it
          does not, we will tell you that instead.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className={LABEL_CLS} htmlFor="lead-email">
            Work email
          </label>
          <input
            id="lead-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className={FIELD}
            placeholder="you@company.com"
          />
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="lead-name">
            Name <span className="font-normal text-faint">(optional)</span>
          </label>
          <input
            id="lead-name"
            name="name"
            type="text"
            autoComplete="name"
            className={FIELD}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className={LABEL_CLS} htmlFor="lead-provider">
            Where you run today
          </label>
          <select
            id="lead-provider"
            name="provider"
            defaultValue={selected}
            className={FIELD}
          >
            <option value="">Select one</option>
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="lead-spend">
            Roughly what it costs
          </label>
          <select id="lead-spend" name="monthlySpend" className={FIELD}>
            <option value="">Select one</option>
            {SPEND.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={LABEL_CLS} htmlFor="lead-message">
          Anything we should know?{" "}
          <span className="font-normal text-faint">(optional)</span>
        </label>
        <textarea
          id="lead-message"
          name="message"
          rows={3}
          className={FIELD}
          placeholder="Stack, deadlines, what is driving the move."
        />
      </div>

      {/* Honeypot. Hidden from people and from screen readers; bots fill it. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="lead-website">Website</label>
        <input id="lead-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {error && <div className="text-[13px] text-danger">{error}</div>}

      <div className="flex flex-wrap items-center gap-3.5">
        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-lg border-0 bg-accent px-6 py-3 text-[15px] font-semibold text-bg hover:bg-accent/90 disabled:cursor-default disabled:opacity-50"
        >
          {state === "sending" ? "Sending..." : "Request a free assessment"}
        </button>
        <span className="text-[13px] text-faint">
          No account needed. We reply by email.
        </span>
      </div>
    </form>
  );
}
