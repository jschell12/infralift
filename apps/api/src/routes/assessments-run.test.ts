import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collect as collectHeroku } from "@infralift/collectors/heroku";

// POST /assessments/run and /from-bundle: a second run of a connection while
// one is going is a 409, and a failed run answers with a sentence and a
// request id, never the provider's or the analyzer's own message.
//
// Prisma is stubbed. The connector is the real Netlify one over a stubbed
// fetch, so the message that must not leak is the one it really throws.

const h = vi.hoisted(() => ({
  connectionFindFirst: vi.fn(),
  assessmentFindFirst: vi.fn(),
  assessmentCreate: vi.fn(),
  assessmentUpdate: vi.fn(),
  analyzeFails: { on: false },
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    providerConnection: { findFirst: h.connectionFindFirst },
    assessment: {
      findFirst: h.assessmentFindFirst,
      create: h.assessmentCreate,
      update: h.assessmentUpdate,
    },
  },
}));
vi.mock("../lib/crypto.js", () => ({ decryptToken: () => "nf-token" }));
vi.mock("../connectors/bundle.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../connectors/bundle.js")>();
  return {
    ...real,
    // An analyzer bug, the only way the bundle path fails after parsing.
    analyzeBundle: (...args: Parameters<typeof real.analyzeBundle>) => {
      if (h.analyzeFails.on) {
        throw new TypeError("Cannot read properties of undefined (reading 'formation')");
      }
      return real.analyzeBundle(...args);
    },
  };
});

const { assessmentsRouter } = await import("./assessments.js");
const { RUN_IN_FLIGHT_WINDOW_MS } = await import("../services/assessments.js");

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

/** Call a route's final handler with a stub req/res. */
async function call(path: string, req: Record<string, unknown>) {
  const layer = (assessmentsRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } }[];
  }).stack.find((l) => l.route?.path === path && l.route.methods.post);
  if (!layer?.route) throw new Error(`no POST ${path}`);
  const out = { status: 200, body: undefined as unknown };
  const res = {
    headersSent: false,
    status: (code: number) => ((out.status = code), res),
    json: (payload: unknown) => ((out.body = payload), res),
  };
  await layer.route.stack.at(-1)!.handle(req, res);
  return out;
}

const user = { orgId: "org_1", userId: "u1", email: "a@b.c", name: null };
const connection = { id: "conn_1", orgId: "org_1", provider: "netlify", encryptedToken: "enc" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let logged: string[];

beforeEach(() => {
  vi.clearAllMocks();
  h.analyzeFails.on = false;
  h.connectionFindFirst.mockResolvedValue(connection);
  h.assessmentFindFirst.mockResolvedValue(null);
  h.assessmentCreate.mockResolvedValue({ id: "asm_new" });
  h.assessmentUpdate.mockResolvedValue({});
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  // Netlify answers 500 to everything, with a body worth not repeating.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("internal upstream trace id=abc", { status: 500 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /assessments/run refuses a second run of the same connection", () => {
  it("answers 409 with the running assessment's id and creates nothing", async () => {
    h.assessmentFindFirst.mockResolvedValue({ id: "asm_running" });

    const res = await call("/run", { body: { connectionId: "conn_1" }, user });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ assessmentId: "asm_running" });
    expect((res.body as { error: string }).error).toMatch(/already running/);
    expect(h.assessmentCreate).not.toHaveBeenCalled();
  });

  it("only counts this org's pending or running runs from inside the window", async () => {
    const before = Date.now();
    await call("/run", { body: { connectionId: "conn_1" }, user });

    const where = h.assessmentFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      orgId: "org_1",
      connectionId: "conn_1",
      status: { in: ["pending", "running"] },
    });
    // A run left "running" by a dead process must not lock the connection
    // out for good: only rows newer than the window count.
    const since = (where.createdAt.gte as Date).getTime();
    expect(since).toBeGreaterThanOrEqual(before - RUN_IN_FLIGHT_WINDOW_MS);
    expect(since).toBeLessThanOrEqual(Date.now() - RUN_IN_FLIGHT_WINDOW_MS);
  });

  it("starts the run when nothing is in flight", async () => {
    await call("/run", { body: { connectionId: "conn_1" }, user });
    expect(h.assessmentCreate).toHaveBeenCalledTimes(1);
  });
});

describe("a failed run does not send the provider's message", () => {
  it("answers 502 with a sentence and a request id, and logs the message under that id", async () => {
    const res = await call("/run", { body: { connectionId: "conn_1" }, user });

    expect(res.status).toBe(502);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("Assessment failed");
    expect(body.assessmentId).toBe("asm_new");
    expect(body).not.toHaveProperty("detail");
    expect(JSON.stringify(body)).not.toMatch(/Netlify API|-> 500|trace id/);
    expect(body.requestId).toMatch(UUID);

    const line = logged.find((l) => l.includes(String(body.requestId)));
    expect(line).toMatch(/Netlify API \/sites\S* -> 500/);
    // The run is still recorded as failed, with the message, for support.
    expect(h.assessmentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: expect.stringMatching(/^Netlify API \/sites\S* -> 500$/) }),
      })
    );
  });

  it("answers a failed snapshot analysis with a sentence, not the analyzer's error", async () => {
    const heroku = JSON.parse(
      readFileSync(new URL("../connectors/__fixtures__/heroku-api.json", import.meta.url), "utf8")
    ) as Record<string, unknown>;
    const serve = async (url: string) => {
      const path = new URL(url).pathname;
      return path in heroku ? Response.json(heroku[path]) : new Response("{}", { status: 404 });
    };
    const snapshot = await collectHeroku({ token: "tok", fetchImpl: serve as unknown as typeof fetch });
    h.analyzeFails.on = true;

    const res = await call("/from-bundle", { body: JSON.parse(JSON.stringify(snapshot)), user });

    expect(res.status).toBe(500);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("Could not read that snapshot");
    expect(body).not.toHaveProperty("detail");
    expect(JSON.stringify(body)).not.toMatch(/Cannot read properties/);
    expect(body.requestId).toMatch(UUID);
    expect(logged.find((l) => l.includes(String(body.requestId)))).toContain(
      "Cannot read properties of undefined"
    );
  });
});
