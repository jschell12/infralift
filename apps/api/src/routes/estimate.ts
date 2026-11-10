// Public cost estimator. The second unauthenticated route in the system, and
// the only one that is a pure function: it reads nothing and writes nothing,
// so there is no tenant to scope it to and no row for an abuser to create.
//
// What it still needs, because it sits above cfAuth like /intake/lead does, is
// its own bounds. Every numeric field is capped, not for correctness, since
// sizing.ts is total, but because the caller supplies the numbers the sizing
// loops iterate over, and an uncapped instance count behind a free public
// route is a CPU amplifier.

import { Router } from "express";
import { z } from "zod";
import { clientKey, createRateLimiter } from "../lib/rate-limit.js";
import { estimate, DEFAULT_HOURLY_RATE_USD } from "../lib/estimate.js";
import { PRICES_VERIFIED_AT } from "../lib/pricing.js";

export const estimateRouter = Router();

const tier = z.enum(["none", "small", "large"]);

const estimateSchema = z.object({
  sourceProvider: z.string().max(60).optional(),
  // Coerced because it arrives from a text input. A blank field is "I don't
  // know", which the model answers rather than rejects, so this is optional
  // rather than defaulted to zero. Zero is a claim, absence is not.
  monthlySpendUsd: z.coerce.number().min(0).max(10_000_000).optional(),
  webInstances: z.coerce.number().int().min(0).max(200),
  workerInstances: z.coerce.number().int().min(0).max(200),
  ramPerInstanceMb: z.coerce.number().int().min(128).max(131_072),
  postgres: tier,
  redis: tier,
  runtime: z.enum(["js", "other"]),
  bandwidthGbMonth: z.coerce.number().min(0).max(1_000_000),
  requestsMillionsMonth: z.coerce.number().min(0).max(100_000),
  objectStorageGb: z.coerce.number().min(0).max(1_000_000),
  hourlyRateUsd: z.coerce.number().min(0).max(2_000).optional(),
  // Honeypot, same as the lead form. Real users never see this field.
  website: z.string().max(300).optional(),
});

// Twenty an hour. More generous than the lead form's five because running the
// calculator repeatedly with different numbers is the intended behaviour, not
// a symptom of one.
const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

/** Exported for tests. */
export function resetRateLimit(): void {
  limiter.reset();
}

estimateRouter.post("/", (req, res) => {
  const parsed = estimateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid input", detail: parsed.error.flatten() });
  }
  const input = parsed.data;

  // A filled honeypot is a bot. Answer with a shape it cannot distinguish from
  // success, so it has nothing to learn.
  if (input.website && input.website.trim().length > 0) {
    return res.json({
      targets: [],
      bestSlug: null,
      assumptions: [],
      pricesVerifiedAt: PRICES_VERIFIED_AT,
    });
  }

  if (limiter.limited(clientKey(req), Date.now())) {
    return res
      .status(429)
      .json({ error: "Too many estimates. Try again in a little while." });
  }

  const result = estimate({
    sourceProvider: input.sourceProvider,
    monthlySpendUsd: input.monthlySpendUsd,
    webInstances: input.webInstances,
    workerInstances: input.workerInstances,
    ramPerInstanceMb: input.ramPerInstanceMb,
    postgres: input.postgres,
    redis: input.redis,
    runtime: input.runtime,
    bandwidthGbMonth: input.bandwidthGbMonth,
    requestsMillionsMonth: input.requestsMillionsMonth,
    objectStorageGb: input.objectStorageGb,
    hourlyRateUsd: input.hourlyRateUsd ?? DEFAULT_HOURLY_RATE_USD,
  });

  return res.json(result);
});
