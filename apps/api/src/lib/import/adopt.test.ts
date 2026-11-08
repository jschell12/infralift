import { describe, expect, it } from "vitest";
import type { ResourceInventoryItem } from "@infralift/shared";
import { AdoptInputError, planAdoption, renderAdoption, validateBackend } from "./adopt.js";
import { renderImportCheck } from "./check.js";

const item = (type: string, externalId: string, name: string): ResourceInventoryItem => ({
  provider: "digitalocean",
  type,
  externalId,
  name,
});

describe("planAdoption", () => {
  it("maps what it can, names what it cannot, and never reuses an address", () => {
    const plan = planAdoption("digitalocean", [
      item("digitalocean:droplet", "1", "web"),
      item("digitalocean:droplet", "2", "web"),
      item("digitalocean:domain", "example.com", "example.com"),
      item("digitalocean:app", "a", "site"),
      item("digitalocean:droplet", 'x" } resource "evil', "evil"),
    ]);
    expect(plan.imports.map((i) => [i.to, i.id])).toEqual([
      ["digitalocean_droplet.web", "1"],
      ["digitalocean_droplet.web_2", "2"],
      ["digitalocean_domain.example_com", "example.com"],
    ]);
    expect(plan.skipped.map((s) => [s.type, s.reason.slice(0, 20)])).toEqual([
      ["digitalocean:app", "no Terraform import "],
      ["digitalocean:droplet", "its id has character"],
    ]);
  });

  it("adopts Azure resources by ARM id and Cloudflare zones by zone id", () => {
    const az = planAdoption("azure", [
      { provider: "azure", type: "azure:storage_account", externalId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acme", name: "acme" },
    ]);
    expect(az.imports[0]).toMatchObject({ to: "azurerm_storage_account.acme" });
    const cf = planAdoption("cloudflare", [
      { provider: "cloudflare", type: "cloudflare:zone", externalId: "023e105f4ecef8ad9ca31a8372d0c353", name: "acme.dev" },
    ]);
    expect(cf.imports[0]).toEqual({ to: "cloudflare_zone.acme_dev", id: "023e105f4ecef8ad9ca31a8372d0c353", type: "cloudflare:zone", name: "acme.dev" });
  });
});

describe("renderAdoption", () => {
  const plan = planAdoption("digitalocean", [item("digitalocean:droplet", "123", "web")]);

  it("writes imports, a provider and an R2 backend, and no resource code", () => {
    const { files, root } = renderAdoption({
      provider: "digitalocean",
      plan,
      backend: { kind: "r2", bucket: "acme-state", key: "do.tfstate", accountId: "0123456789abcdef0123456789abcdef" },
      path: "infra/do",
      label: "infra/do",
    });
    const all = files.map((f) => f.content).join("\n");
    expect(all).not.toMatch(/^resource /m);
    expect(all).toContain('endpoints                   = { s3 = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" }');
    expect(all).toContain('provider "digitalocean" {}');
    expect(root).toMatchObject({ backend: { kind: "r2" }, resources: 1, generateConfig: true, readiness: "ready", tool: "tofu" });
  });

  it("feeds a check that generates code, commits it, and may push only to its branch", () => {
    const { root } = renderAdoption({
      provider: "digitalocean",
      plan,
      backend: { kind: "s3", bucket: "acme-state", key: "do.tfstate", region: "us-east-1" },
      path: "infra/do",
      label: "infra/do",
    });
    const { content } = renderImportCheck(root);
    expect(content).toContain("  contents: write");
    expect(content).toContain("ref: ${{ github.head_ref || github.ref_name }}");
    expect(content).toContain("if: hashFiles('infra/do/generated.tf') == ''");
    expect(content).toContain("plan -input=false -lock=false -no-color -generate-config-out=generated.tf");
    expect(content).toContain("if: always() && steps.gen.outcome == 'success'");
    expect(content).toContain('git commit -m "infralift: generated code for imported resources"');
    expect(content).toContain('git push origin "HEAD:$BRANCH"');
    // The repo-scan check stays read-only on contents.
    expect(renderImportCheck({ ...root, generateConfig: false }).content).toContain("  contents: read");
  });

  it("refuses bad backend settings and an empty adoption", () => {
    expect(() => validateBackend({ kind: "s3", bucket: "acme", key: "../x", region: "us-east-1" })).toThrow(AdoptInputError);
    expect(() => validateBackend({ kind: "r2", bucket: "acme", key: "x", accountId: "nope" })).toThrow(AdoptInputError);
    expect(() =>
      renderAdoption({
        provider: "digitalocean",
        plan: { imports: [], skipped: [] },
        backend: { kind: "s3", bucket: "acme", key: "x", region: "us-east-1" },
        path: "",
        label: "",
      })
    ).toThrow(/nothing in this account/);
  });
});
