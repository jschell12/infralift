import { beforeEach, describe, expect, it, vi } from "vitest";

// approveMigration's reuse rule: re-approving reuses the codegen project for
// the same assessment; a same-named project of any other kind is a conflict.

const h = vi.hoisted(() => ({
  assessment: vi.fn(),
  projectFind: vi.fn(),
  projectCreate: vi.fn(async ({ data }: { data: object }) => ({ id: "new", ...data })),
  projectUpdate: vi.fn(async ({ data }: { data: object }) => ({ id: "existing", ...data })),
  jobCreate: vi.fn(async ({ data }: { data: object }) => ({ id: "job1", ...data })),
}));

vi.mock("../lib/db.js", () => ({
  prisma: {
    assessment: { findFirst: h.assessment },
    tfProject: { findFirst: h.projectFind, create: h.projectCreate, update: h.projectUpdate },
    tfJob: { create: h.jobCreate },
  },
}));
vi.mock("../lib/jobs/start.js", () => ({ startJob: vi.fn() }));

const { approveMigration } = await import("./codegen.js");
const { Conflict } = await import("../lib/errors.js");

const input = {
  assessmentId: "as1",
  migrationTarget: "hetzner" as const,
  repo: "acme/infra",
  destPath: "infrastructure",
  destBranch: "main",
  projectName: "acme",
  backend: "local" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assessment.mockResolvedValue({ id: "as1", provider: "vercel", status: "completed" });
});

describe("approveMigration", () => {
  it("creates a codegen project the first time", async () => {
    h.projectFind.mockResolvedValue(null);
    const out = await approveMigration("org-a", input);
    expect(h.projectCreate.mock.calls[0][0].data).toMatchObject({ source: "codegen", assessmentId: "as1", orgId: "org-a" });
    expect(out.job).toMatchObject({ kind: "codegen" });
  });

  it("reuses the codegen project for the same assessment", async () => {
    h.projectFind.mockResolvedValue({ id: "existing", source: "codegen", assessmentId: "as1" });
    await approveMigration("org-a", input);
    expect(h.projectUpdate).toHaveBeenCalled();
    expect(h.projectCreate).not.toHaveBeenCalled();
  });

  it("refuses a same-named project of another kind, even with the same assessment", async () => {
    // An adoption from this assessment shares assessmentId; it must not be
    // rewritten into a codegen project.
    h.projectFind.mockResolvedValue({ id: "existing", source: "imported", assessmentId: "as1" });
    await expect(approveMigration("org-a", input)).rejects.toBeInstanceOf(Conflict);
    expect(h.projectUpdate).not.toHaveBeenCalled();
  });

  it("refuses a codegen project from a different assessment", async () => {
    h.projectFind.mockResolvedValue({ id: "existing", source: "codegen", assessmentId: "other" });
    await expect(approveMigration("org-a", input)).rejects.toThrow(/different assessment/);
  });
});
