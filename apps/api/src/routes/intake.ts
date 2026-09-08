// Public lead intake. The only unauthenticated write path in the system.
//
// Everything else sits behind cfAuth, so this route has to carry its own
// guards rather than lean on the ones the rest of the API gets for free:
// a size cap, a shape check, a rate limit, and a honeypot. It writes one row
// and returns; it never creates an Org or a User, because an anonymous
// submission has no tenant to belong to.

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { clientKey, createRateLimiter } from "../lib/rate-limit.js";

export const intakeRouter = Router();

const leadSchema = z.object({
  // trim() runs before the email check; without it a pasted address with a
  // trailing space is a 400, which is a miserable first interaction.
  email: z.string().trim().email().max(200),
  name: z.string().max(120).optional(),
  company: z.string().max(160).optional(),
  provider: z.string().max(60).optional(),
  monthlySpend: z.string().max(60).optional(),
  message: z.string().max(4000).optional(),
  sourcePath: z.string().max(300).optional(),
  referrer: z.string().max(300).optional(),
  utmSource: z.string().max(120).optional(),
  utmMedium: z.string().max(120).optional(),
  utmCampaign: z.string().max(120).optional(),
  // Honeypot. Real users never see this field, so anything in it is a bot.
  // Named to look worth filling in.
  website: z.string().max(300).optional(),
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const limiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
});

/** Exported for tests. */
export function resetRateLimit(): void {
  limiter.reset();
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

intakeRouter.post("/", async (req, res) => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid submission", detail: parsed.error.flatten() });
  }
  const input = parsed.data;

  // A filled honeypot is a bot. Answer exactly as if it worked, so the bot
  // has nothing to learn and no reason to retry with a different shape.
  if (input.website && input.website.trim().length > 0) {
    return res.status(202).json({ ok: true });
  }

  if (limiter.limited(clientKey(req), Date.now())) {
    return res
      .status(429)
      .json({ error: "Too many submissions. Try again later, or email us." });
  }

  const country = req.headers["cf-ipcountry"];

  try {
    const lead = await prisma.inboundLead.create({
      data: {
        email: input.email.trim().toLowerCase(),
        name: input.name?.trim() || null,
        company: input.company?.trim() || null,
        provider: input.provider?.trim() || null,
        monthlySpend: input.monthlySpend?.trim() || null,
        message: input.message?.trim() || null,
        sourcePath: input.sourcePath || null,
        referrer: input.referrer || null,
        utmSource: input.utmSource || null,
        utmMedium: input.utmMedium || null,
        utmCampaign: input.utmCampaign || null,
        country: typeof country === "string" ? country : null,
      },
      select: { id: true },
    });
    // The id is deliberately not returned: it is a database identifier and the
    // submitter has no use for it.
    console.log(`inbound lead ${lead.id} from ${input.email}`);
    return res.status(202).json({ ok: true });
  } catch (err) {
    console.error("inbound lead write failed:", err);
    return res
      .status(500)
      .json({ error: "Could not record that. Please try again." });
  }
});
