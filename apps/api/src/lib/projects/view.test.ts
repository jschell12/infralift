import { describe, expect, it } from "vitest";
import { ProjectShapeError, toProjectView, type ProjectRow } from "./view.js";

const base = {
  id: "p1",
  orgId: "o1",
  name: "acme",
  source: "stack",
  templateVersionId: null,
  assessmentId: null,
  migrationTarget: null,
  stackSlug: "app-foundry-hetzner",
  importJson: null,
  importCheckJson: null,
  gitHost: "github",
  gitConnectionId: "c1",
  tfcConnectionId: null,
  createRepo: false,
  destRepo: "acme/app",
  destPath: "",
  destBranch: "main",
  providerConfig: { name: "acme" },
  createdAt: new Date("2026-11-08T00:00:00Z"),
  templateVersion: null,
  renderings: [],
} as unknown as ProjectRow;

describe("toProjectView", () => {
  it("gives each kind only its own fields", () => {
    const stack = toProjectView(base);
    expect(stack).toMatchObject({ kind: "stack", stackSlug: "app-foundry-hetzner", providerConfig: { name: "acme" } });
    expect(stack).not.toHaveProperty("importJson");
    expect(stack).not.toHaveProperty("templateVersion");

    const imported = toProjectView({ ...base, source: "imported", stackSlug: null, importJson: { path: "infra" } } as ProjectRow);
    expect(imported).toMatchObject({ kind: "imported", importJson: { path: "infra" }, importCheckJson: null });
    expect(imported).not.toHaveProperty("stackSlug");

    const tpl = toProjectView({
      ...base,
      source: "template",
      templateVersion: { releaseTag: "v1", template: { slug: "s" } },
      renderings: [{ id: "r", fileName: "f.tf", commitSha: null, createdAt: new Date("2026-11-01T00:00:00Z") }],
    } as ProjectRow);
    expect(tpl).toMatchObject({ kind: "template", templateVersion: { releaseTag: "v1" }, renderings: [{ createdAt: "2026-11-01T00:00:00.000Z" }] });

    expect(toProjectView({ ...base, source: "adopted" } as ProjectRow)).toEqual(expect.objectContaining({ kind: "adopted" }));
  });

  it("reports a row missing what its kind requires", () => {
    expect(() => toProjectView({ ...base, stackSlug: null } as ProjectRow)).toThrow(ProjectShapeError);
    expect(() => toProjectView({ ...base, source: "codegen" } as ProjectRow)).toThrow(/codegen project has no assessment/);
    expect(() => toProjectView({ ...base, source: "mystery" } as ProjectRow)).toThrow(/unknown kind/);
  });
});
