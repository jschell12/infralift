// Rate limiting for the public routes, the handful registered above cfAuth
// that therefore have no tenant, no session, and nothing else standing
// between them and the open internet.
//
// This lived inside routes/intake.ts until the estimate route needed the same
// thing. A second copy would have meant two sweep thresholds, two window
// constants, and two places to fix the day CF-Connecting-IP handling changes.
// Each caller gets its own bucket map, so a burst of calculator traffic cannot
// spend the lead form's budget.

export interface RateLimiter {
  /** True when this key has already used its allowance for the window. */
  limited(key: string, now: number): boolean;
  /** Exported for tests; there is no production caller. */
  reset(): void;
}

/** Sliding-window limiter: each key keeps the timestamps of its recent hits,
 * and a hit is refused when `max` of them fall inside the last `windowMs`.
 * In-process and therefore per-instance: a second API replica would allow a
 * second bucket. That is an acceptable ceiling for routes that write one small
 * row or run a pure function, and it avoids adding Redis to the request path
 * for them. */
export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
}): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    limited(key: string, now: number): boolean {
      const recent = (hits.get(key) ?? []).filter(
        (t) => now - t < opts.windowMs
      );
      if (recent.length >= opts.max) {
        hits.set(key, recent);
        return true;
      }
      recent.push(now);
      hits.set(key, recent);

      // Opportunistic sweep so the map cannot grow without bound.
      if (hits.size > 5000) {
        for (const [k, times] of hits) {
          const live = times.filter((t) => now - t < opts.windowMs);
          if (live.length === 0) hits.delete(k);
          else hits.set(k, live);
        }
      }
      return false;
    },
    reset(): void {
      hits.clear();
    },
  };
}

export function clientKey(req: {
  headers: Record<string, unknown>;
  ip?: string;
}): string {
  // Behind the Cloudflare tunnel, CF-Connecting-IP is the real client. Fall
  // back to the socket address so this still limits something in dev.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip ?? "unknown";
}
