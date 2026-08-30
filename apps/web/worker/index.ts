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
