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
    expect(cf.imports[0]).toEqual({
      to: "cloudflare_zone.acme_dev",
      id: "023e105f4ecef8ad9ca31a8372d0c353",
      type: "cloudflare:zone",
      name: "acme.dev",
      // The connector's id, which the managed-resource ledger is keyed on.
      externalId: "023e105f4ecef8ad9ca31a8372d0c353",
    });
  });
});

describe("renderAdoption: names from the provider", () => {
  it("keeps a name with a newline on its comment line", () => {
    const plan = planAdoption("digitalocean", [item("digitalocean:droplet", "9", "web\nresource \"x\" \"y\" {}")]);
    const { files } = renderAdoption({
      provider: "digitalocean",
      plan,
      backend: { kind: "s3", bucket: "acme-state", key: "k", region: "us-east-1" },
      path: "",
      label: "",
    });
    const imports = files.find((f) => f.path === "imports.tf")!.content;
    expect(imports).not.toMatch(/^resource /m);
    expect(imports).toContain('# digitalocean:droplet: web resource "x" "y" {}');
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
    expect(all).toContain('s3 = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"');
    expect(all).toContain('provider "digitalocean" {}');
    expect(root).toMatchObject({ backend: { kind: "r2" }, resources: 1, generateConfig: true, readiness: "ready", tool: "tofu" });
    expect(all).toContain('required_version = ">= 1.10"');
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
    expect(content).toContain("  checks: write");
    // Forks check out the merge ref and never commit.
    expect(content).toContain("ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || '' }}");
    expect(content).toContain(
      "if: always() && steps.gen.outcome == 'success' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
    );
    // The generated commit gets this check's result recorded on it.
    expect(content).toContain('gh api "repos/$GITHUB_REPOSITORY/check-runs" -f name="Plan changes nothing" -f head_sha="$(git rev-parse HEAD)"');
    expect(content).toContain("GATE: ${{ steps.gate.outcome }}");
    expect(content).toContain("if: hashFiles('infra/do/generated.tf') == ''");
    expect(content).toContain("plan -input=false -lock=false -no-color -generate-config-out=generated.tf");
    expect(content).toContain("if: always() && steps.gen.outcome == 'success'");
    expect(content).toContain('git commit -m "infralift: generated code for imported resources"');
    expect(content).toContain('git push origin "HEAD:$BRANCH"');
    // The repo-scan check stays read-only on contents.
    const plain = renderImportCheck({ ...root, generateConfig: false }).content;
    expect(plain).toContain("  contents: read");
    expect(plain).not.toContain("checks: write");
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
