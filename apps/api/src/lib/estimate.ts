// The public estimator: a savings number for someone who has not signed up,
// has not run a collector, and has not handed over a token.
//
// It exists because every other way into this product asks for something
// first. The signup asks for a Google account, the assessment asks for a
// snapshot bundle. Both are reasonable asks *after* someone believes there is
// money on the table, and both are walls before that.
//
// Two rules shape this module.
//
// 1. It does not own any pricing. `planTarget`/`sizeTarget` in sizing.ts are
//    the single source, the same functions the options page and the generated
//    HCL read. A calculator with its own copy of the Hetzner price list would
//    drift within a release, and drift here is worse than elsewhere: this is
//    the first number a stranger ever sees, and the assessment they run later
//    would contradict it.
//
// 2. It subtracts the labour. A managed platform's bill includes somebody
//    patching the kernel; a VPS bill does not. Publishing the gross difference
//    and staying quiet about who does that work now is the fastest way to lose
//    the first competent reader, so the ops line is computed here and is not
//    optional in the response.

import type { OptionSizing } from "@infralift/shared";
import { planTarget, sizeTarget, type WorkloadFootprint } from "./sizing.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type DataTier = "none" | "small" | "large";

/** Whether the application could run as request/response functions at all.
 * This is the one compatibility question worth asking on a public form: a
 * Rails or Django app does not become a Worker, no matter what the price
 * table says. */
export type Runtime = "js" | "other";

/** What the form asks for. Deliberately in the units someone reads off an
 * invoice or a dashboard, not in the units sizing.ts thinks in. */
export interface EstimateInput {
  /** Label only. It frames the answer, it does not change the arithmetic. */
  sourceProvider?: string;
  /** Current all-in monthly bill, USD. Undefined means "I don't know", which
   * is answerable: the target cost is still computable, the saving is not. */
  monthlySpendUsd?: number;
  webInstances: number;
  workerInstances: number;
  ramPerInstanceMb: number;
  postgres: DataTier;
  redis: DataTier;
  runtime: Runtime;
  bandwidthGbMonth: number;
  requestsMillionsMonth: number;
  objectStorageGb: number;
  /** Loaded cost of an engineer-hour, USD. Overridable because the honest
   * answer depends on whose hour it is, and a bootstrapper who wants to price
   * their own time at zero should be able to say so and see that number
   * rather than argue with ours. */
  hourlyRateUsd?: number;
}

/** US-market fully-loaded senior engineer. Stated in the response so the
 * reader can disagree with the assumption rather than the conclusion. */
export const DEFAULT_HOURLY_RATE_USD = 150;

export function footprintFrom(input: EstimateInput): WorkloadFootprint {
  const instances = input.webInstances + input.workerInstances;
  return {
    totalRamMb: instances * input.ramPerInstanceMb,
    webInstances: input.webInstances,
    workerInstances: input.workerInstances,
    bandwidthGbMonth: input.bandwidthGbMonth,
    requestsMillionsMonth: input.requestsMillionsMonth,
    postgresTier: input.postgres === "none" ? null : input.postgres,
    redisTier: input.redis === "none" ? null : input.redis,
    objectStorageGb: input.objectStorageGb,
  };
}

// ---------------------------------------------------------------------------
// The ops line
// ---------------------------------------------------------------------------

// Only *net-new* operational work is counted. Someone leaving Heroku already
// deploys, already watches error rates, already carries a pager for their own
// application. What they do not do today is patch a kernel, verify a backup
// restore, or notice that a host is out of disk. Counting the work they were
// already doing would be as dishonest in the other direction as counting none
// of it, and would make every migration look absurd.
//
// Managed data services (Neon, Upstash) add nothing here on purpose: they are
// managed on both sides of the move, so they are not part of the delta.

const HETZNER_BASE_HOURS = 3;
const HETZNER_HOURS_PER_EXTRA_INSTANCE = 0.5;

// Workers have no hosts. The real cost of moving to them is one-time (runtime
// limits, cold paths, rewriting anything that assumed a filesystem), and that
// belongs in the migration scope, not the monthly line.
const CLOUDFLARE_BASE_HOURS = 0.5;

export interface OpsBurden {
  hoursPerMonth: number;
  monthlyCents: number;
  hourlyRateUsd: number;
  note: string;
}

export function opsBurden(
  slug: string,
  footprint: WorkloadFootprint,
  hourlyRateUsd: number
): OpsBurden {
  const plan = planTarget(slug, footprint);

  let hours: number;
  let note: string;

  if (slug === "hetzner") {
    const instanceCount =
      plan?.hetzner?.instances.reduce((sum, g) => sum + g.count, 0) ?? 1;
    hours =
      HETZNER_BASE_HOURS +
      Math.max(0, instanceCount - 1) * HETZNER_HOURS_PER_EXTRA_INSTANCE;
    note =
      "Patching, backup verification, and host monitoring across " +
      `${instanceCount} instance${instanceCount === 1 ? "" : "s"}. ` +
      "Your database and cache stay managed, so they are not counted here.";
  } else {
    hours = CLOUDFLARE_BASE_HOURS;
    note =
      "There are no hosts to patch. The real cost of Workers is one-time " +
      "(runtime limits, anything assuming a filesystem) and is scoped in the " +
      "migration plan, not billed monthly.";
  }

  return {
    hoursPerMonth: hours,
    monthlyCents: Math.round(hours * hourlyRateUsd * 100),
    hourlyRateUsd,
    note,
  };
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

// Pricing a target the workload cannot run on is the most expensive kind of
// wrong this page can be. sizeCloudflare will happily quote Workers for an
// eight-dyno Rails app, because it prices requests and bandwidth and knows
// nothing about what is serving them. That quote wins on price every time,
// and it is worthless.
//
// So each target answers whether it can host this workload at all, before
// anything is ranked. An ineligible target is still returned, with the reason,
// because "Workers would be cheaper but cannot run your stack" is more useful
// to the reader than a column that quietly vanished.

/** Above this, a process is not going to fit in a Worker isolate's 128MB.
 * Below it the number is ambiguous (dyno sizes are routinely oversized), so
 * the runtime answer decides instead. */
const WORKERS_RAM_CEILING_MB = 1024;

function fitFor(
  slug: string,
  input: EstimateInput
): { eligible: boolean; reason?: string } {
  if (slug !== "cloudflare") return { eligible: true };

  if (input.runtime === "other") {
    return {
      eligible: false,
      reason:
        "Workers runs JavaScript and WebAssembly. A Rails, Django, Java, or " +
        "native-dependency application does not port to it, so this is not a " +
        "target for your stack. Hetzner runs your container unchanged.",
    };
  }
  if (input.ramPerInstanceMb > WORKERS_RAM_CEILING_MB) {
    return {
      eligible: false,
      reason:
        `Each Worker isolate gets 128MB. You told us your processes run at ` +
        `${input.ramPerInstanceMb}MB each, which will not fit without ` +
        "splitting the application up. That is real work and it is not in " +
        "these numbers.",
    };
  }
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface EstimateTarget {
  slug: string;
  name: string;
  /** Infrastructure only, before the ops line. */
  monthlyCents: number;
  lineItems: OptionSizing["lineItems"];
  ops: OpsBurden;
  /** False when this target cannot host the workload. It is still priced, so
   * the reader can see what they are giving up, but it is never recommended. */
  eligible: boolean;
  ineligibleReason?: string;
  /** Bill today minus infrastructure. Null when spend is unknown. */
  grossMonthlySavingsCents: number | null;
  /** Gross minus the ops line. This is the number that means something. */
  netMonthlySavingsCents: number | null;
  netAnnualSavingsCents: number | null;
}

export interface EstimateResult {
  targets: EstimateTarget[];
  /** Slug of the best net outcome, or null when nothing saves money. A null
   * here is a real answer and the UI renders it as one. */
  bestSlug: string | null;
  /** Plain-language statements the reader is entitled to argue with. */
  assumptions: string[];
}

const TARGET_NAMES: Record<string, string> = {
  cloudflare: "Cloudflare Workers",
  hetzner: "Hetzner",
};

export function estimate(input: EstimateInput): EstimateResult {
  const footprint = footprintFrom(input);
  const rate = input.hourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD;
  const spendCents =
    input.monthlySpendUsd === undefined
      ? null
      : Math.round(input.monthlySpendUsd * 100);

  const targets: EstimateTarget[] = [];
  for (const slug of ["cloudflare", "hetzner"]) {
    const sizing = sizeTarget(slug, footprint);
    // sizeTarget returns null for a slug with no model. Skipping rather than
    // guessing keeps the "no claim beats an absurd claim" rule the options
    // page already follows.
    if (!sizing) continue;

    const ops = opsBurden(slug, footprint, rate);
    const gross =
      spendCents === null ? null : spendCents - sizing.monthlyCents;
    const net = gross === null ? null : gross - ops.monthlyCents;
    const fit = fitFor(slug, input);

    targets.push({
      slug,
      name: TARGET_NAMES[slug] ?? slug,
      monthlyCents: sizing.monthlyCents,
      lineItems: sizing.lineItems,
      ops,
      eligible: fit.eligible,
      ineligibleReason: fit.reason,
      grossMonthlySavingsCents: gross,
      netMonthlySavingsCents: net,
      netAnnualSavingsCents: net === null ? null : net * 12,
    });
  }

  targets.sort((a, b) => {
    // A target that cannot run the workload never leads, however cheap it is.
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    // Unknown spend means no savings to rank on; fall back to raw cost so the
    // cheaper target still leads.
    if (a.netMonthlySavingsCents === null || b.netMonthlySavingsCents === null) {
      return a.monthlyCents - b.monthlyCents;
    }
    return b.netMonthlySavingsCents - a.netMonthlySavingsCents;
  });

  // Only claim a winner when it actually wins. If the best net outcome is a
  // loss, the honest output is "stay where you are", and that is worth more
  // to us than a lead: it is the answer that makes the other numbers on this
  // page believable, and it disqualifies a prospect before either side spends
  // a call on it.
  const best = targets[0];
  const bestSlug =
    best &&
    best.eligible &&
    best.netMonthlySavingsCents !== null &&
    best.netMonthlySavingsCents > 0
      ? best.slug
      : null;

  const assumptions = [
    `Engineer time is priced at $${rate}/hour, fully loaded.`,
    "Only net-new operations work is counted: patching, backup verification, and host monitoring. Deploys, application monitoring, and on-call happen on both sides of the move and are not part of the difference.",
    "Postgres and Redis land on managed services (Neon, Upstash), so they are managed before and after.",
    "Instance sizing covers the RAM you entered with 30% headroom.",
    "One-time migration work is not in these numbers. It is scoped, with a fixed fee, in the migration plan.",
  ];
  if (spendCents === null) {
    assumptions.unshift(
      "You did not give a current bill, so this shows what the target costs and makes no savings claim."
    );
  }

  return { targets, bestSlug, assumptions };
}
