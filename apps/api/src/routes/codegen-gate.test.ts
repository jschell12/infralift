import { describe, it, expect, vi, beforeEach } from "vitest";
import { toCodegenSample } from "../lib/tf/sample.js";
import type { GeneratedFile } from "../lib/tf/codegen.js";

// The free assessment stays free. The applyable Terraform is the deliverable,
// and before this it went to any signed-in user — harmless while Access
// admitted one person, not harmless once anyone can sign up with Google.

const ORG = { id: "org_1", codegenUnlocked: false };

const findUniqueAssessment = vi.fn();
const findUniqueOrg = vi.fn(async () => ORG);

const updateOrg = vi.fn(async ({ data }: { data: { codegenUnlocked: boolean } }) => ({
  id: ORG.id,
  name: "Acme",
  codegenUnlocked: data.codegenUnlocked,
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    assessment: { findUnique: (a: never) => findUniqueAssessment(a) },
    org: { findUnique: () => findUniqueOrg(), update: (a: never) => updateOrg(a) },
  },
}));

// Admins come only from ADMIN_EMAILS; set before cf-auth is loaded.
process.env.ADMIN_EMAILS = "owner@example.com";
const { tfRouter, resetCodegenRateLimit } = await import("./tf.js");

type Handler = (req: unknown, res: unknown) => unknown;

function route(method: string, path: string) {
  const layer = (
    tfRouter as unknown as {
      stack: {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: { handle: Handler }[];
        };
      }[];
    }
  ).stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  return layer.route;
}

async function call(path: string, req: Record<string, unknown>) {
  const stack = route("post", path).stack;
  const out = { status: 200, body: {} as Record<string, unknown> };
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
  await stack[stack.length - 1].handle(req, res);
  return out;
}

const INVENTORY = [
  {
    provider: "heroku",
    type: "heroku:app",
    externalId: "app_1",
    name: "shop-api",
    region: "us",
    monthlyCostCents: null,
    metadata: {},
  },
  {
    provider: "heroku",
    type: "heroku:dyno",
    externalId: "app_1:web",
    name: "shop-api web (standard-2x x2)",
    region: null,
    monthlyCostCents: 10000,
    metadata: { size: "standard-2x", quantity: 2 },
  },
];

function assessment() {
  return {
    id: "asm_1",
    orgId: ORG.id,
    provider: "heroku",
    status: "completed",
    inventory: INVENTORY,
  };
}

// /codegen maps DB rows through `?? undefined`, so nulls are fine there. The
// preview route takes JSON straight from the caller and its schema is
// optional() rather than nullable(), so nulls are a 400. Send what a real
// caller would.
const PREVIEW_INVENTORY = INVENTORY.map(({ region, monthlyCostCents, ...rest }) => ({
  ...rest,
  ...(region ? { region } : {}),
  ...(monthlyCostCents ? { monthlyCostCents } : {}),
}));

const CUSTOMER = {
  orgId: ORG.id,
  userId: "u1",
  email: "stranger@example.com",
  name: null,
};
const OWNER = { ...CUSTOMER, email: "owner@example.com" };

beforeEach(() => {
  resetCodegenRateLimit();
  ORG.codegenUnlocked = false;
  findUniqueAssessment.mockResolvedValue(assessment());
});

describe("POST /codegen is gated", () => {
  it("returns a sample to a locked org, not the configuration", async () => {
    const res = await call("/codegen", {
      body: { assessmentId: "asm_1", migrationTarget: "hetzner" },
      user: CUSTOMER,
    });

    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(true);
    expect((res.body.withheld as unknown[]).length).toBeGreaterThan(0);

    // The sample must never contain a withheld file.
    const shown = new Set(
      (res.body.files as GeneratedFile[]).map((f) => f.fileName)
    );
    for (const w of res.body.withheld as { fileName: string }[]) {
      expect(shown.has(w.fileName)).toBe(false);
    }
  });

  it("returns everything to an org an admin cleared", async () => {
    ORG.codegenUnlocked = true;
    const res = await call("/codegen", {
      body: { assessmentId: "asm_1", migrationTarget: "hetzner" },
      user: CUSTOMER,
    });

    expect(res.body.locked).toBe(false);
    expect(res.body.withheld).toBeUndefined();
    expect((res.body.files as GeneratedFile[]).length).toBeGreaterThan(2);
  });

  it("returns everything to an admin regardless of the org flag", async () => {
    const res = await call("/codegen", {
      body: { assessmentId: "asm_1", migrationTarget: "hetzner" },
      user: OWNER,
    });
    expect(res.body.locked).toBe(false);
  });

  it("meters locked callers", async () => {
    let last = { status: 0 };
    for (let i = 0; i < 25; i++) {
      last = await call("/codegen", {
        body: { assessmentId: "asm_1", migrationTarget: "hetzner" },
        user: CUSTOMER,
      });
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
  });
});

describe("POST /codegen/preview is gated the same way", () => {
  // This route renders an inventory the caller types in, so leaving it open
  // would have made the gate on /codegen decorative.
  it("samples for a locked org", async () => {
    const res = await call("/codegen/preview", {
      body: {
        provider: "heroku",
        inventory: PREVIEW_INVENTORY,
        migrationTarget: "hetzner",
      },
      user: CUSTOMER,
    });
    expect(res.body.locked).toBe(true);
    expect((res.body.withheld as unknown[]).length).toBeGreaterThan(0);
  });

  it("rejects an unbounded inventory", async () => {
    const res = await call("/codegen/preview", {
      body: {
        provider: "heroku",
        inventory: Array.from({ length: 1001 }, () => PREVIEW_INVENTORY[0]),
        migrationTarget: "hetzner",
      },
      user: CUSTOMER,
    });
    expect(res.status).toBe(400);
  });
});

describe("toCodegenSample", () => {
  const files: GeneratedFile[] = [
    { fileName: "README.md", content: "# plan\nreplaces X\n" },
    { fileName: "versions.tf", content: 'terraform {\n  required_providers {}\n}\n' },
    {
      fileName: "target-hetzner.tf",
      content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
    },
    { fileName: "variables.tf", content: 'variable "x" {}\n' },
    { fileName: "outputs.tf", content: 'output "y" {}\n' },
  ];

  it("shows the plan and the pinned versions in full", () => {
    const s = toCodegenSample(files);
    const byName = Object.fromEntries(s.files.map((f) => [f.fileName, f.content]));
    expect(byName["README.md"]).toBe(files[0].content);
    expect(byName["versions.tf"]).toBe(files[1].content);
  });

  it("excerpts the target file and says how much is missing", () => {
    const s = toCodegenSample(files);
    const target = s.files.find((f) => f.fileName === "target-hetzner.tf")!;
    expect(target.content).toContain("line 0");
    expect(target.content).toContain("line 14");
    expect(target.content).not.toContain("line 15");
    expect(target.content).toContain("45 more lines");
  });

  it("withholds a short target file rather than excerpting all of it", () => {
    const s = toCodegenSample([
      { fileName: "target-cloudflare.tf", content: "a\nb\nc\n" },
    ]);
    expect(s.files).toHaveLength(0);
    expect(s.withheld[0].fileName).toBe("target-cloudflare.tf");
  });

  it("never emits a file that was not in the input", () => {
    const s = toCodegenSample(files);
    const inputNames = new Set(files.map((f) => f.fileName));
    for (const f of s.files) expect(inputNames.has(f.fileName)).toBe(true);
    for (const w of s.withheld) expect(inputNames.has(w.fileName)).toBe(true);
  });

  it("accounts for every input file exactly once", () => {
    const s = toCodegenSample(files);
    expect(s.files.length + s.withheld.length).toBe(files.length);
  });
});

describe("POST /unlock", () => {
  it("is admin-only", async () => {
    const { requireAdmin } = await import("../lib/cf-auth.js");
    const handlers = route("post", "/unlock").stack.map((l) => l.handle);
    expect(handlers).toContain(requireAdmin);
  });

  it("sets the org flag", async () => {
    const res = await call("/unlock", {
      body: { orgId: ORG.id, unlocked: true },
      user: OWNER,
    });
    expect(res.body.codegenUnlocked).toBe(true);
    expect(updateOrg).toHaveBeenCalledWith(
      expect.objectContaining({ data: { codegenUnlocked: true } })
    );
  });
});
