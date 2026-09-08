/**
 * First-party analytics collector for infralift.dev.
 *
 * The marketing site is a static export; this Worker script sits in front
 * of the assets and handles exactly one dynamic route: POST /a/e, the
 * beacon endpoint (see the inline script in app/layout.tsx). Events are
 * written to the Workers Analytics Engine dataset `marketing_analytics`;
 * everything else falls through to the static assets.
 *
 * Blob layout (the nightly rollup in apps/api depends on this — keep in
 * sync with apps/api/src/analytics/rollup.ts):
 *   index1: site ("infralift")
 *   blob1:  site
 *   blob2:  path
 *   blob3:  referrer host (external only; "" for same-site/direct)
 *   blob4:  utm_source
 *   blob5:  utm_medium
 *   blob6:  utm_campaign
 *   blob7:  country (from request.cf)
 *   blob8:  daily visitor hash — SHA-256(salt+day | site | ip | ua),
 *           first 8 bytes hex. Raw IP/UA are never stored; the hash
 *           rotates daily so it cannot be correlated across days.
 */

// Minimal ambient types so this file type-checks under the web app's
// tsconfig (DOM lib) without adding @cloudflare/workers-types as a dep.
interface AnalyticsEngineDataset {
  writeDataPoint(point: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
  ANALYTICS: AnalyticsEngineDataset;
  /** Optional Worker secret mixed into the daily visitor hash. */
  ANALYTICS_SALT?: string;
  /** Base URL of the API behind the public intake paths, e.g.
   * https://api.infralift.dev. Unset means they are not wired up yet and
   * /a/lead and /a/estimate answer 503.
   *
   * Named for the lead form because that came first. It is the same API base
   * for both, and renaming it would mean re-putting a live Worker secret. */
  LEAD_INTAKE_URL?: string;
  /** Cloudflare Access service token, when the intake URL sits behind Access.
   * Both halves are required or neither header is sent. The same token covers
   * both intake paths; each path needs its own Access application in
   * schellout, because those are scoped to an exact path. */
  LEAD_INTAKE_CF_CLIENT_ID?: string;
  LEAD_INTAKE_CF_CLIENT_SECRET?: string;
}

interface IncomingRequestCf {
  country?: string;
}

const BOT_UA =
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|scan|python|curl|wget|httpx|monitor|uptime|facebookexternalhit/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/a/e") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return collect(request, env, "infralift");
    }
    if (url.pathname === "/a/lead") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return submitLead(request, env);
    }
    if (url.pathname === "/a/estimate") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return runEstimate(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function collect(
  request: Request,
  env: Env,
  site: string
): Promise<Response> {
  try {
    const text = await request.text();
    if (text.length > 2048) return new Response(null, { status: 204 });
    const body = JSON.parse(text) as { p?: unknown; r?: unknown; q?: unknown };

    const path =
      typeof body.p === "string" && body.p.startsWith("/")
        ? body.p.slice(0, 256)
        : null;
    const ua = request.headers.get("user-agent") || "";
    const purpose =
      request.headers.get("sec-purpose") || request.headers.get("purpose") || "";
    if (!path || !ua || BOT_UA.test(ua) || purpose.includes("prefetch")) {
      return new Response(null, { status: 204 });
    }

    // Only keep external referrer hosts; same-host navigation is not a
    // traffic source.
    let refHost = "";
    try {
      if (typeof body.r === "string" && body.r) {
        const u = new URL(body.r);
        if (u.hostname !== new URL(request.url).hostname) refHost = u.hostname;
      }
    } catch {
      // unparseable referrer — treat as direct
    }

    const q =
      typeof body.q === "string"
        ? new URLSearchParams(body.q.slice(0, 512))
        : new URLSearchParams();

    // Daily-rotating visitor hash: salt + UTC day + site + IP + UA. The
    // raw IP/UA never leave this function.
    const ip = request.headers.get("cf-connecting-ip") || "";
    const day = new Date().toISOString().slice(0, 10);
    const salt = (env.ANALYTICS_SALT || "") + day;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${salt}|${site}|${ip}|${ua}`)
    );
    const visitor = [...new Uint8Array(digest).slice(0, 8)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const cf = (request as Request & { cf?: IncomingRequestCf }).cf;
    env.ANALYTICS.writeDataPoint({
      indexes: [site],
      blobs: [
        site,
        path,
        refHost,
        q.get("utm_source") || "",
        q.get("utm_medium") || "",
        q.get("utm_campaign") || "",
        (cf && cf.country) || "",
        visitor,
      ],
    });
  } catch {
    // Analytics must never break the site — swallow everything.
  }
  return new Response(null, { status: 204 });
}


/**
 * Lead intake, proxied to the API.
 *
 * The browser posts here rather than straight to the API for two reasons: it
 * is same-origin, so there is no CORS preflight and no credentialed public
 * origin to widen; and the API lives behind the Cloudflare tunnel, so the
 * Worker is the only place that can hold a service token for it.
 *
 * Unlike /a/e, this does NOT swallow failures. An analytics event that goes
 * missing costs a row in a chart; a lead that goes missing costs a customer,
 * so the browser is told the truth and the visitor can try again.
 */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Headers every proxied intake call needs. The visitor IP matters: the API
 * rate-limits on it, so sending the Worker's egress address would put every
 * visitor in the world into one bucket. */
function upstreamHeaders(request: Request, env: Env): Record<string, string> {
  const cf = (request as { cf?: IncomingRequestCf }).cf;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": request.headers.get("cf-connecting-ip") ?? "0.0.0.0",
    "CF-IPCountry": cf?.country ?? "",
  };
  if (env.LEAD_INTAKE_CF_CLIENT_ID && env.LEAD_INTAKE_CF_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.LEAD_INTAKE_CF_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.LEAD_INTAKE_CF_CLIENT_SECRET;
  }
  return headers;
}

async function submitLead(request: Request, env: Env): Promise<Response> {
  if (!env.LEAD_INTAKE_URL) {
    return json(
      { error: "Lead intake is not configured on this environment." },
      503
    );
  }

  let payload: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) return json({ error: "Too large." }, 413);
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "Malformed submission." }, 400);
  }

  const ua = request.headers.get("user-agent") ?? "";
  if (BOT_UA.test(ua)) {
    // Same shape as success: a bot learns nothing from being refused.
    return json({ ok: true }, 202);
  }

  const headers = upstreamHeaders(request, env);

  try {
    const upstream = await fetch(`${env.LEAD_INTAKE_URL}/intake/lead`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (upstream.ok) return json({ ok: true }, 202);

    // An Access login redirect means the service token is missing or wrong.
    // Say so rather than reporting a generic failure that looks like a bug in
    // the form.
    if (upstream.status === 302 || upstream.status === 401) {
      return json(
        { error: "Lead intake is not reachable. We have been notified." },
        502
      );
    }
    if (upstream.status === 429) {
      return json({ error: "Too many submissions. Try again later." }, 429);
    }
    if (upstream.status === 400) {
      return json({ error: "Please check the details and try again." }, 400);
    }
    return json({ error: "Could not record that. Please try again." }, 502);
  } catch {
    return json({ error: "Could not reach us. Please try again." }, 502);
  }
}


/**
 * Cost estimator, proxied to the API for the same reasons as the lead form.
 *
 * It differs in one way that matters: the upstream body is the product, so it
 * is passed through rather than collapsed to {ok:true}. The API route is a
 * pure function, so there is nothing here to make idempotent and no row a
 * retry could duplicate.
 */
async function runEstimate(request: Request, env: Env): Promise<Response> {
  if (!env.LEAD_INTAKE_URL) {
    return json(
      { error: "The estimator is not configured on this environment." },
      503
    );
  }

  let payload: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 8192) return json({ error: "Too large." }, 413);
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "Malformed submission." }, 400);
  }

  const ua = request.headers.get("user-agent") ?? "";
  if (BOT_UA.test(ua)) {
    // An empty result rather than a refusal, matching the API's honeypot
    // response: nothing to learn from, and nothing computed for free.
    return json({ targets: [], bestSlug: null, assumptions: [] }, 200);
  }

  try {
    const upstream = await fetch(`${env.LEAD_INTAKE_URL}/intake/estimate`, {
      method: "POST",
      headers: upstreamHeaders(request, env),
      body: JSON.stringify(payload),
    });

    if (upstream.ok) {
      const body = await upstream.text();
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // An Access login redirect means the service token is missing, or that the
    // /intake/estimate Access application was never created. Those look
    // identical from here and have the same fix.
    if (upstream.status === 302 || upstream.status === 401) {
      return json(
        { error: "The estimator is not reachable. We have been notified." },
        502
      );
    }
    if (upstream.status === 429) {
      return json({ error: "Too many estimates. Try again later." }, 429);
    }
    if (upstream.status === 400) {
      return json({ error: "Please check the numbers and try again." }, 400);
    }
    return json({ error: "Could not work that out. Please try again." }, 502);
  } catch {
    return json({ error: "Could not reach us. Please try again." }, 502);
  }
}
