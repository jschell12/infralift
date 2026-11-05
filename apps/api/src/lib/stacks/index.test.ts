import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TfInputValidationError } from "../tf/render.js";
import { getStack, listStacks, renderStack, resolveStackInputs } from "./index.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/app-foundry-hetzner/${name}`, import.meta.url),
    "utf8"
  );

const stack = getStack("app-foundry-hetzner")!;
const byPath = (files: ReturnType<typeof renderStack>) =>
  new Map(files.map((f) => [f.path, f]));

describe("stack catalog", () => {
  it("lists app-foundry-hetzner", () => {
    expect(listStacks().map((s) => s.slug)).toContain("app-foundry-hetzner");
  });

  it("refuses slugs that could walk out of the stacks directory", () => {
    expect(getStack("../stacks")).toBeNull();
    expect(getStack("nope")).toBeNull();
  });
});

describe("renderStack: app-foundry-hetzner", () => {
  it("reproduces the source repo's own files from its example inputs", () => {
    // The vendored copy came from app-foundry at stack.source.commit, whose
    // deploy/ is live. If templatizing changed a byte, this catches it.
    const files = byPath(renderStack(stack, stack.example));
    expect(files.get("deploy/infra/main.tf")!.content).toBe(fixture("main.tf"));
    expect(files.get("deploy/infra/backend.tf")!.content).toBe(
      fixture("backend.tf").replace(
        "# To use Terraform Cloud instead, replace this file with backends/tfc.tf.\n",
        "# Switching to Terraform Cloud is a change to the project in infralift, which\n# rewrites this file.\n"
      )
    );
  });

  it("puts the customer's settings into main.tf and nowhere leaves a placeholder", () => {
    const files = renderStack(stack, {
      name: "acme-web",
      zone_name: "acme.io",
      subdomain: "app",
      github_repository: "acme-web",
      server_type: "cx33",
    });
    const main = byPath(files).get("deploy/infra/main.tf")!.content;
    expect(main).toContain('name                  = "acme-web"');
    expect(main).toContain('zone_name             = "acme.io"');
    expect(main).toContain('server_type           = "cx33"');
    expect(main).toContain("max_previews          = 3"); // schema default
    for (const f of files) expect(f.content).not.toMatch(/\{\{[#/]?[A-Za-z_]/);
    expect(byPath(files).get("deploy/README.md")!.content).toContain(
      "https://app.acme.io"
    );
  });

  it("marks overrides.tf as seed and everything else as managed", () => {
    const files = renderStack(stack, stack.example);
    const seeds = files.filter((f) => f.ownership === "seed").map((f) => f.path);
    expect(seeds).toEqual(["deploy/infra/overrides.tf"]);
  });

  it("keeps the box scripts executable", () => {
    const files = byPath(renderStack(stack, stack.example));
    for (const p of [
      "deploy/box/bin/deploy.sh",
      "deploy/box/bin/teardown.sh",
      "deploy/box/bin/backup.sh",
      "deploy/box/bin/restore.sh",
      "deploy/box/test-local.sh",
    ]) {
      expect(files.get(p)?.mode, p).toBe("100755");
    }
    expect(files.get("deploy/box/compose.yml")!.mode).toBe("100644");
  });

  it("r2: encrypted S3 backend plus the bootstrap module", () => {
    const files = byPath(renderStack(stack, { ...stack.example, backend: "r2" }));
    expect(files.get("deploy/infra/backend.tf")!.content).toContain("encryption {");
    expect(files.get("deploy/bootstrap/main.tf")!.content).toContain(
      'default = "app-foundry-demo-tfstate"'
    );
    expect(files.has("deploy/infra/backend.r2.hcl.example")).toBe(true);
  });

  it("tfc: a cloud block, and no R2 bootstrap or encryption", () => {
    const files = byPath(
      renderStack(stack, {
        ...stack.example,
        backend: "tfc",
        tfc_organization: "acme",
      })
    );
    const backend = files.get("deploy/infra/backend.tf")!.content;
    expect(backend).toContain('organization = "acme"');
    expect(backend).toContain('name = "app-foundry-demo"'); // workspace defaults to name
    expect(backend).not.toContain("encryption");
    expect([...files.keys()].some((p) => p.startsWith("deploy/bootstrap/"))).toBe(false);
    expect(files.has("deploy/infra/backend.r2.hcl.example")).toBe(false);
  });

  it("rejects inputs the schema does not allow", () => {
    const bad = [
      { ...stack.example, name: "Bad Name" },
      { ...stack.example, zone_name: "not a zone" },
      { ...stack.example, server_type: "ccx99" },
      { ...stack.example, extra: "x" },
      { ...stack.example, backend: "tfc" }, // tfc needs an organization
      { ...stack.example, name: 'x" ; evil = "' },
    ];
    for (const inputs of bad) {
      expect(() => renderStack(stack, inputs), JSON.stringify(inputs)).toThrow(
        TfInputValidationError
      );
    }
  });

  it("does not modify the caller's inputs", () => {
    const inputs = { ...stack.example };
    resolveStackInputs(stack, inputs);
    expect(inputs).toEqual(stack.example);
  });

  it("gitlab-ci: GitLab files and wording, none of GitHub's", () => {
    const files = byPath(
      renderStack(stack, { ...stack.example, delivery: "gitlab-ci", gitlab_project: "acme/web" })
    );
    expect(files.has(".gitlab-ci.yml")).toBe(true);
    expect(files.has("deploy/infra/generated/gitlab.tf")).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith(".github/"))).toBe(false);
    expect(files.has("deploy/infra/generated/github.tf")).toBe(false);
    expect(files.get("deploy/infra/generated/versions.tf")!.content).toContain("gitlabhq/gitlab");
    const readme = files.get("deploy/README.md")!.content;
    expect(readme).toContain("shipped by GitLab CI");
    expect(readme).toContain("merge request");
    expect(readme).not.toContain("GITHUB_TOKEN");
  });

  it("each delivery requires its own repository setting", () => {
    const { github_repository: _, ...noRepo } = stack.example;
    expect(() => renderStack(stack, noRepo)).toThrow(TfInputValidationError);
    expect(() => renderStack(stack, { ...noRepo, delivery: "gitlab-ci" })).toThrow(TfInputValidationError);
    expect(() =>
      renderStack(stack, { ...noRepo, delivery: "gitlab-ci", gitlab_project: "acme/web" })
    ).not.toThrow();
  });
});
