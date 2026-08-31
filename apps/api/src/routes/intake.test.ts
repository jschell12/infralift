import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route writes one row; the guards around that write are the part worth
// testing, so Prisma is stubbed and the assertions are about what reaches it.
const created: unknown[] = [];
const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
  created.push(args.data);
  return { id: "lead_1" };
});

vi.mock("../lib/db.js", () => ({
  prisma: { inboundLead: { create: (a: never) => create(a) } },
}));

const { intakeRouter, resetRateLimit } = await import("./intake.js");

type Handler = (req: unknown, res: unknown) => Promise<void> | void;

/** Pull the POST handler straight off the router rather than standing up a
 * server; there is exactly one and this keeps the test synchronous. */
function handler(): Handler {
  const layer = (
    intakeRouter as unknown as {
      stack: { route?: { stack: { handle: Handler }[] } }[];
    }
  ).stack.find((l) => l.route);
  return layer!.route!.stack[0].handle;
}

interface Result {
  status: number;
  body: Record<string, unknown>;
}

async function post(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Result> {
  const out: Result = { status: 200, body: {} };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      out.body = payload;
      return this;
    },
  };
  await handler()({ body, headers, ip: "127.0.0.1" }, res);
  return out;
}

const VALID = { email: "dev@northwind.example", name: "Dev", provider: "vercel" };

beforeEach(() => {
  resetRateLimit();
  created.length = 0;
  create.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public lead intake", () => {
  it("accepts a valid submission and records it", async () => {
    const r = await post(VALID, { "cf-ipcountry": "US" });

    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    expect(created).toHaveLength(1);

    const row = created[0] as Record<string, unknown>;
    expect(row.email).toBe("dev@northwind.example");
    expect(row.country).toBe("US");
  });

  it("normalizes the email so the same person is one lead", async () => {
    await post({ ...VALID, email: "  Dev@Northwind.Example  " });
    expect((created[0] as Record<string, unknown>).email).toBe(
      "dev@northwind.example"
    );
  });

  it("rejects a submission without a usable email", async () => {
    const r = await post({ name: "no email" });
    expect(r.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("swallows a honeypot hit without telling the bot", async () => {
    const r = await post({ ...VALID, website: "http://spam.example" });

    // Looks identical to success from the outside...
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    // ...but nothing was written.
    expect(create).not.toHaveBeenCalled();
  });

  it("rate limits per client IP, not globally", async () => {
    const a = { "cf-connecting-ip": "203.0.113.10" };
    const b = { "cf-connecting-ip": "203.0.113.99" };

    for (let i = 0; i < 5; i++) {
      expect((await post(VALID, a)).status).toBe(202);
    }
    expect((await post(VALID, a)).status).toBe(429);

    // A different visitor is unaffected by the first one's burst.
    expect((await post(VALID, b)).status).toBe(202);
    expect(create).toHaveBeenCalledTimes(6);
  });

  it("prefers the Cloudflare client IP over the socket address", async () => {
    const viaCf = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < 5; i++) await post(VALID, viaCf);
    expect((await post(VALID, viaCf)).status).toBe(429);

    // Same socket ip, different CF client: must not inherit the limit.
    expect(
      (await post(VALID, { "cf-connecting-ip": "198.51.100.8" })).status
    ).toBe(202);
  });

  it("keeps attribution when the form sends it", async () => {
    await post({
      ...VALID,
      sourcePath: "/leaving/vercel",
      utmSource: "reddit",
      utmCampaign: "egress",
    });
    const row = created[0] as Record<string, unknown>;
    expect(row.sourcePath).toBe("/leaving/vercel");
    expect(row.utmSource).toBe("reddit");
    expect(row.utmCampaign).toBe("egress");
  });

  it("does not leak the database id back to the submitter", async () => {
    const r = await post(VALID);
    expect(Object.keys(r.body)).toEqual(["ok"]);
  });

  it("reports a write failure instead of pretending it worked", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await post(VALID);
    // A silently dropped lead is worse than a visible error.
    expect(r.status).toBe(500);
    expect(r.body.ok).toBeUndefined();
  });
});
