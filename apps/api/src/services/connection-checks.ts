import { prisma } from "../lib/db.js";
import { TooManyRequests } from "../lib/errors.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { CHECK_CLAIM_MS, claimCheck, runCheck, runClaimedCheck } from "./connections.js";

// ---------------------------------------------------------------------------
// Connections are checked again on their own, so a credential that stopped
// working shows as invalid before someone tries to use it.
//
//   sweep       every SWEEP_EVERY_MS (plus jitter), beside the drift sweep:
//               up to SWEEP_BATCH connections not checked in STALE_AFTER_MS,
//               never-checked first, oldest next
//   on demand   POST /connections/check-stale, when a page shows a stale
//               connection: the same selection for one org, rate limited per
//               org, claimed before the response so the page can show
//               "Checking..." at once, checked in the background
//   one at once both run each check through runCheck/claimCheck
//               (services/connections.ts), so one connection is never
//               verified twice at the same time (a queued check whose claim
//               could lapse is dropped, not run), and through one slot pool
//               of CHECK_CONCURRENCY, so a sweep and a page load together
//               still make at most that many provider calls at once
//
// No retries. A check of any outcome sets lastCheckedAt, a timeout and a
// refusal included, so the next attempt is STALE_AFTER_MS away whatever
// happened. Every verify call is read-only (connectors/*.ts verify/check).
// ---------------------------------------------------------------------------

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Up to this much is added to each sweep interval, and to the first sweep's
 *  delay after boot, so a restart does not line every check up on one tick. */
export const SWEEP_JITTER_MS = 10 * 60 * 1000;
export const SWEEP_BATCH = 25;
/** Connections one org's page load may queue at once. */
export const ORG_BATCH = 20;
/** Provider verify calls this process makes at once, sweep and pages together. */
export const CHECK_CONCURRENCY = 4;

const ON_DEMAND_PER_WINDOW = 6;
const ON_DEMAND_WINDOW_MS = 10 * 60 * 1000;
const onDemand = createRateLimiter({ windowMs: ON_DEMAND_WINDOW_MS, max: ON_DEMAND_PER_WINDOW });

// -- the slot pool ------------------------------------------------------------------

/** A counting semaphore: at most `size` tasks run at once, the rest wait in
 *  order. Exported for tests, which check the cap. */
export function createSlots(size: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve));
      running++;
      try {
        return await task();
      } finally {
        running--;
        waiting.shift()?.();
      }
    },
    get running() {
      return running;
    },
  };
}

const slots = createSlots(CHECK_CONCURRENCY);

// -- selection ------------------------------------------------------------------

/** Connections due a check: never checked or checked more than STALE_AFTER_MS
 *  ago, and not held by a live claim. Never-checked first, then oldest. */
export async function dueForCheck(now = new Date(), limit = SWEEP_BATCH, orgId?: string) {
  return prisma.providerConnection.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      AND: [
        { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } }] },
        { OR: [{ verifyingSince: null }, { verifyingSince: { lt: new Date(now.getTime() - CHECK_CLAIM_MS) } }] },
      ],
    },
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });
}

function logFailure(id: string, err: unknown): void {
  // Only the error's class and our own message: never a provider body.
  console.error(`connection check ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
}

// -- the sweep ------------------------------------------------------------------

/** One sweep: every due connection, CHECK_CONCURRENCY at a time. Returns how
 *  many were checked; one claimed elsewhere first is skipped, not counted. */
export async function sweepConnectionChecks(now = new Date()): Promise<number> {
  const due = await dueForCheck(now);
  const results = await Promise.all(
    due.map((connection) =>
      slots.run(() => runCheck(connection, { now })).then(
        (row) => (row ? 1 : 0),
        (err) => {
          logFailure(connection.id, err);
          return 0;
        }
      )
    )
  );
  return results.reduce<number>((a, b) => a + b, 0);
}

/** Starts the sweep for this process: the first a random 1 to 11 minutes
 *  after boot, then every SWEEP_EVERY_MS plus jitter. Unref'd, so it never
 *  holds a shutdown. */
export function startConnectionCheckSweep(random: () => number = Math.random): void {
  const schedule = (base: number) => {
    setTimeout(() => {
      void sweepConnectionChecks()
        .then((n) => {
          if (n) console.log(`connection checks: checked ${n} connection(s)`);
        })
        .catch((err) => console.error("connection check sweep failed:", err))
        .finally(() => schedule(SWEEP_EVERY_MS));
    }, base + Math.floor(random() * SWEEP_JITTER_MS)).unref();
  };
  schedule(60_000);
}

// -- on demand ------------------------------------------------------------------

/** Claims every due connection of the org and checks them in the background.
 *  Returns the ids it claimed, which already read checking: true. 429 past
 *  ON_DEMAND_PER_WINDOW calls in ON_DEMAND_WINDOW_MS for one org. */
export async function checkStaleForOrg(orgId: string, now = new Date()): Promise<string[]> {
  if (onDemand.limited(orgId, now.getTime())) {
    throw new TooManyRequests("Connections were checked a moment ago. They are checked again on their own every day.");
  }
  const claimed = [];
  for (const connection of await dueForCheck(now, ORG_BATCH, orgId)) {
    if (await claimCheck(connection.id, now)) claimed.push(connection);
  }
  for (const connection of claimed) {
    void slots.run(() => runClaimedCheck(connection, now)).catch((err) => logFailure(connection.id, err));
  }
  return claimed.map((c) => c.id);
}

/** For tests. */
export function resetConnectionCheckState(): void {
  onDemand.reset();
}
