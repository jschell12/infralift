import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";

// The Worker is the only place on the marketing site with branching logic, and
// /a/lead is the branch that costs money when it is wrong: a dropped lead is a
// lost customer, not a missing row in a chart.

interface Env {
  ASSETS: { fetch: (r: Request) => Promise<Response> };
  ANALYTICS: { writeDataPoint: (p: unknown) => void };
  ANALYTICS_SALT?: string;
  LEAD_INTAKE_URL?: string;
  LEAD_INTAKE_CF_CLIENT_ID?: string;
  LEAD_INTAKE_CF_CLIENT_SECRET?: string;
}

const assetResponse = new Response("static asset", { status: 200 });

function env(over: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => assetResponse.clone()) },
    ANALYTICS: { writeDataPoint: vi.fn() },
    LEAD_INTAKE_URL: "https://api.infralift.dev",
    ...over,
  };
}

function leadRequest(
  body: unknown,
  init: { ua?: string; ip?: string; country?: string; method?: string } = {}
): Request {
  const method = init.method ?? "POST";
  const req = new Request("https://infralift.dev/a/lead", {
    method,
    headers: {
      "Content-Type": "application/json",
      "user-agent": init.ua ?? "Mozilla/5.0 (Macintosh) Safari/605.1.15",
      "cf-connecting-ip": init.ip ?? "203.0.113.5",
    },
    // GET and HEAD cannot carry a body per the fetch spec.
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  Object.defineProperty(req, "cf", {
    value: { country: init.country ?? "US" },
  });
  return req;
}

const VALID = { email: "dev@northwind.example", provider: "Vercel" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker routing", () => {
  it("serves static assets for everything it does not handle", async () => {
    const e = env();
    const res = await worker.fetch(
      new Request("https://infralift.dev/docs/security"),
      e as never
    );
    expect(res.status).toBe(200);
    expect(e.ASSETS.fetch).toHaveBeenCalled();
  });

  it("rejects non-POST on the lead endpoint", async () => {
    const res = await worker.fetch(
      leadRequest(VALID, { method: "GET" }),
      env() as never
    );
    expect(res.status).toBe(405);
  });
});

describe("lead intake", () => {
  it("forwards a valid submission and reports success", async () => {
    const res = await worker.fetch(leadRequest(VALID), env() as never);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.infralift.dev/intake/lead");
    expect(JSON.parse(init.body as string)).toMatchObject(VALID);
  });

  it("passes the visitor's IP through so the API rate-limits the right party", async () => {
    await worker.fetch(
      leadRequest(VALID, { ip: "198.51.100.22" }),
      env() as never
    );
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    // Without this the API would see the Worker's egress address and one
    // abusive visitor would rate-limit everybody.
    expect(headers["CF-Connecting-IP"]).toBe("198.51.100.22");
    expect(headers["CF-IPCountry"]).toBe("US");
  });

  it("sends Access service-token headers only when both halves are set", async () => {
    await worker.fetch(
      leadRequest(VALID),
      env({
        LEAD_INTAKE_CF_CLIENT_ID: "id",
        LEAD_INTAKE_CF_CLIENT_SECRET: "secret",
      }) as never
    );
    let headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("id");
    expect(headers["CF-Access-Client-Secret"]).toBe("secret");

    // Half a credential pair is not a credential; sending it would leak the id
    // and still fail Access.
    fetchMock.mockClear();
    await worker.fetch(
      leadRequest(VALID),
      env({ LEAD_INTAKE_CF_CLIENT_ID: "id" }) as never
    );
    headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["CF-Access-Client-Id"]).toBeUndefined();
  });

  it("answers 503 when intake is not configured, rather than pretending", async () => {
    const res = await worker.fetch(
      leadRequest(VALID),
      env({ LEAD_INTAKE_URL: undefined }) as never
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("absorbs bots without telling them and without bothering the API", async () => {
    const res = await worker.fetch(
      leadRequest(VALID, { ua: "python-requests/2.31" }),
      env() as never
    );
    // Indistinguishable from success on the wire...
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    // ...but nothing was forwarded.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized body before parsing it", async () => {
    const res = await worker.fetch(
      leadRequest("x".repeat(9000)),
      env() as never
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a 400", async () => {
    const res = await worker.fetch(leadRequest("{not json"), env() as never);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an Access login redirect to a clear failure", async () => {
    // 302 here means the service token is missing or wrong, which is a
    // deployment problem, not a problem with what the visitor typed.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const res = await worker.fetch(leadRequest(VALID), env() as never);
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it("passes a rate limit back rather than reporting a server error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const res = await worker.fetch(leadRequest(VALID), env() as never);
    expect(res.status).toBe(429);
  });

  it("surfaces a validation failure as something the visitor can act on", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
    const res = await worker.fetch(leadRequest(VALID), env() as never);
    expect(res.status).toBe(400);
  });

  it("does not swallow a network failure the way the analytics beacon does", async () => {
    fetchMock.mockRejectedValueOnce(new Error("upstream unreachable"));
    const res = await worker.fetch(leadRequest(VALID), env() as never);

    // /a/e returns 204 on any error because a lost pageview is cheap. A lost
    // lead is not, so the browser has to hear about it.
    expect(res.status).toBe(502);
    expect(res.status).not.toBe(204);
  });
});

describe("analytics beacon still behaves", () => {
  function beacon(body: unknown): Request {
    return new Request("https://infralift.dev/a/e", {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" },
      body: JSON.stringify(body),
    });
  }

  it("records a pageview", async () => {
    const e = env();
    const res = await worker.fetch(beacon({ p: "/leaving/vercel" }), e as never);
    expect(res.status).toBe(204);
    expect(e.ANALYTICS.writeDataPoint).toHaveBeenCalled();
  });

  it("stays silent on malformed input", async () => {
    const e = env();
    const res = await worker.fetch(
      new Request("https://infralift.dev/a/e", { method: "POST", body: "{oops" }),
      e as never
    );
    // Unlike the lead path, dropping this quietly is the correct behaviour.
    expect(res.status).toBe(204);
    expect(e.ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
  });
});
