import type { Request, RequestHandler } from "express";
import { TooManyRequests } from "./errors.js";

// ---------------------------------------------------------------------------
// Rate limits, all of them, in one place.
//
// Every limit the API enforces is a row in RATE_LIMITS: how many calls one org
// and/or one client IP may make in a window, and the sentence a refused caller
// reads. A refusal is a 429 with a Retry-After header saying how many seconds
// until the oldest counted call leaves the window.
//
// Strategy pattern: where the counts are kept is a RateLimitStore. The only
// store today is in memory (createMemoryRateLimitStore), so the counts are
// per API process: a second replica would allow a second allowance, and a
// restart forgets every count. That matches the rest of the process (one API
// process at a time, ADR 0006). A store backed by Postgres or Redis that
// implements the same two methods makes the limits shared without changing a
// caller; the interface is async for that reason.
//
// Where a limit is checked:
//   - rateLimit(policy) as route middleware, for a route whose every call
//     costs something (an assessment calls AWS Cost Explorer, which bills per
//     request; a scan reads a repository; a run queues work in Terraform Cloud).
//   - RateLimiter.check() inside a service, where only some calls cost
//     something: the unmanaged view counts provider reads, not cache hits.
//   - RateLimiter.decide() in the public intake routes, which answer a refusal
//     with their own body and only after the honeypot check.
// ---------------------------------------------------------------------------

/** At most `max` calls in any `windowMs`. */
export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** When refused, how long until a call would be allowed; 0 when allowed. */
  retryAfterMs: number;
}

/** Where counts are kept. `consume` counts the call when it is allowed and
 *  does not count it when refused. */
export interface RateLimitStore {
  consume(key: string, rule: RateLimitRule, now: number): Promise<RateLimitDecision>;
  /** Forget every count. For tests. */
  reset(): Promise<void>;
}

/** The keys a store holds before it sweeps out the ones with nothing left in
 *  their window, so the map cannot grow without bound. */
const SWEEP_AT_KEYS = 5000;

/** Sliding window in this process's memory: each key keeps the timestamps of
 *  its recent calls. See the header for what "in this process" costs. */
export function createMemoryRateLimitStore(): RateLimitStore {
  const hits = new Map<string, number[]>();

  function sweep(now: number, windowMs: number) {
    for (const [key, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }

  return {
    async consume(key, rule, now) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
      if (recent.length >= rule.max) {
        hits.set(key, recent);
        // The oldest call in the window is the next to leave it.
        return { allowed: false, retryAfterMs: Math.max(1, recent[0] + rule.windowMs - now) };
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > SWEEP_AT_KEYS) sweep(now, rule.windowMs);
      return { allowed: true, retryAfterMs: 0 };
    },
    async reset() {
      hits.clear();
    },
  };
}

/** One limit: a name (part of every key, so limits never share a count),
 *  per-org and per-IP rules, and what a refused caller is told. */
export interface RateLimitPolicy {
  name: string;
  perOrg?: RateLimitRule;
  perIp?: RateLimitRule;
  message: string;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Every limit the API enforces. Per-IP rules are looser than per-org ones on
 *  authenticated routes: they stop one client spending several orgs'
 *  allowances, not a team sharing an office address. */
export const RATE_LIMITS = {
  /** POST /assessments/run. Each run calls the provider's inventory APIs, and
   *  on AWS, Cost Explorer, which bills per request. */
  assessmentRun: {
    name: "assessment-run",
    perOrg: { max: 10, windowMs: HOUR },
    perIp: { max: 20, windowMs: HOUR },
    message: "Too many assessments in the last hour. Wait a while before running another.",
  },
  /** POST /tf/imports/scan. Reads every Terraform file in a repository. */
  importScan: {
    name: "import-scan",
    perOrg: { max: 30, windowMs: HOUR },
    perIp: { max: 60, windowMs: HOUR },
    message: "Too many repository scans in the last hour. Wait a while and scan again.",
  },
  /** POST /tf/imports, /tf/imports/from-assessment, /connections/:id/adopt,
   *  /workspaces/adopt: each creates a project and work in a customer's
   *  repository or Terraform Cloud organization. */
  importCreate: {
    name: "import-create",
    perOrg: { max: 20, windowMs: HOUR },
    perIp: { max: 40, windowMs: HOUR },
    message: "Too many imports in the last hour. Wait a while before starting another.",
  },
  /** POST /stacks and /stacks/:id/versions: fetch a repository at a commit
   *  and render it to check it (lib/stacks/team.ts). */
  stackRegister: {
    name: "stack-register",
    perOrg: { max: 20, windowMs: HOUR },
    perIp: { max: 40, windowMs: HOUR },
    message: "Too many stack registrations in the last hour. Wait a while and try again.",
  },
  /** Creating, replacing and verifying a connection: each calls the
   *  provider with the credential. */
  connectionVerify: {
    name: "connection-verify",
    perOrg: { max: 30, windowMs: HOUR },
    perIp: { max: 60, windowMs: HOUR },
    message: "Too many connection checks in the last hour. Wait a while and try again.",
  },
  /** Queueing, applying and discarding Terraform Cloud runs. */
  workspaceRun: {
    name: "workspace-run",
    perOrg: { max: 60, windowMs: HOUR },
    perIp: { max: 120, windowMs: HOUR },
    message: "Too many Terraform Cloud run requests in the last hour. Wait a while and try again.",
  },
  /** Provider reads behind GET /connections/:id/unmanaged, counted only when
   *  the cache misses (services/unmanaged.ts). */
  cloudInventory: {
    name: "cloud-inventory",
    perOrg: { max: 10, windowMs: 10 * MINUTE },
    message: "Too many reads of your cloud accounts. Wait a few minutes and try again.",
  },
  /** POST /connections/check-stale (services/connection-checks.ts). */
  connectionCheck: {
    name: "connection-check",
    perOrg: { max: 6, windowMs: 10 * MINUTE },
    message: "Connections were checked a moment ago. They are checked again on their own every day.",
  },
  /** Codegen previews and jobs (services/codegen.ts): CPU-bound renders. */
  codegen: {
    name: "codegen",
    perOrg: { max: 20, windowMs: HOUR },
    message: "Too many codegen requests. Try again later.",
  },
  /** Public lead form, above cfAuth: no org, so per IP only. */
  intakeLead: {
    name: "intake-lead",
    perIp: { max: 5, windowMs: HOUR },
    message: "Too many submissions. Try again later, or email us.",
  },
  /** Public estimator. Running it again with different numbers is the
   *  intended use, so looser than the lead form. */
  intakeEstimate: {
    name: "intake-estimate",
    perIp: { max: 20, windowMs: HOUR },
    message: "Too many estimates. Try again in a little while.",
  },
} as const satisfies Record<string, RateLimitPolicy>;

/** The default store, shared by every limiter in this process. */
const processStore = createMemoryRateLimitStore();

/** Forget every count in the default store. For tests. */
export function resetRateLimits(): Promise<void> {
  return processStore.reset();
}

/** Who is calling, as far as limits are concerned. */
export interface Caller {
  orgId?: string;
  ip?: string;
}

/** Checks one policy against a store. */
export class RateLimiter {
  constructor(
    readonly policy: RateLimitPolicy,
    private readonly store: RateLimitStore = processStore
  ) {}

  /** Counts the call against the IP rule, then the org rule. A call refused
   *  by the org rule has already been counted against the IP rule; that errs
   *  toward refusing, which is the safe side. */
  async decide(caller: Caller, now = Date.now()): Promise<RateLimitDecision> {
    const { name, perIp, perOrg } = this.policy;
    if (perIp && caller.ip) {
      const d = await this.store.consume(`${name}:ip:${caller.ip}`, perIp, now);
      if (!d.allowed) return d;
    }
    if (perOrg && caller.orgId) {
      const d = await this.store.consume(`${name}:org:${caller.orgId}`, perOrg, now);
      if (!d.allowed) return d;
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** decide(), throwing TooManyRequests (429 with Retry-After) on refusal. */
  async check(caller: Caller, now = Date.now()): Promise<void> {
    const d = await this.decide(caller, now);
    if (!d.allowed) throw new TooManyRequests(this.policy.message, retryAfterSeconds(d.retryAfterMs));
  }
}

/** Whole seconds, rounded up, never 0: Retry-After: 0 invites a retry storm. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** Route middleware: the caller's org (after cfAuth) and IP against `policy`.
 *  A refusal reaches the app's errorHandler as TooManyRequests. */
export function rateLimit(policy: RateLimitPolicy, store?: RateLimitStore): RequestHandler {
  const limiter = new RateLimiter(policy, store);
  return (req, _res, next) => {
    limiter.check({ orgId: req.user?.orgId, ip: clientKey(req) }).then(() => next(), next);
  };
}

export function clientKey(req: Pick<Request, "headers" | "ip"> | { headers: Record<string, unknown>; ip?: string }): string {
  // Behind the Cloudflare tunnel, CF-Connecting-IP is the real client. Fall
  // back to the socket address so this still limits something in dev.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip ?? "unknown";
}
