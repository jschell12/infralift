import { describe, expect, it } from "vitest";
import {
  DependencyCycleError,
  NotTemplatizableError,
  WiringError,
  adoptedTemplateSlug,
  assertPublicHost,
  isPrivateAddress,
  tfcCredentialSchema,
  UnsafeHostError,
  applyOrder,
  destroyOrder,
  missingOutputs,
  renderWiring,
  snapshotInputs,
  templatizeAdopted,
  type StoredInput,
} from "./extensions.js";
import { renderTemplate, validateArguments, TfInputValidationError } from "./render.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const inputs: StoredInput[] = [
  { key: "region", category: "terraform", hcl: false, sensitive: false, description: "AWS region", value: "us-east-1" },
  { key: "instance-count", category: "terraform", hcl: true, sensitive: false, description: "", value: "2" },
  { key: "db_password", category: "terraform", hcl: false, sensitive: true, description: "" },
  { key: "AWS_ACCESS_KEY_ID", category: "env", hcl: false, sensitive: true, description: "" },
];

function adopt(overrides: Partial<Parameters<typeof templatizeAdopted>[0]> = {}) {
  return templatizeAdopted({
    workspaceName: "core-network",
    repoUrl: "https://github.com/acme/infra",
    workingDirectory: "envs/prod",
    commitSha: SHA,
    inputs,
    ...overrides,
  });
}

describe("snapshotInputs", () => {
  it("never keeps a sensitive value, even if the API returned one", () => {
    const out = snapshotInputs([
      { key: "b", value: "leaked", category: "terraform", hcl: false, sensitive: true, description: "" },
      { key: "a", value: "kept", category: "terraform", hcl: false, sensitive: false, description: "" },
    ]);
    expect(out.map((i) => i.key)).toEqual(["a", "b"]);
    expect(out[0].value).toBe("kept");
    expect(out[1]).not.toHaveProperty("value");
    expect(JSON.stringify(out)).not.toContain("leaked");
  });
});

describe("templatizeAdopted", () => {
  it("pins the module source to the adopted commit and working directory", () => {
    const t = adopt();
    expect(t.templateBody).toContain(
      `source = "git::https://github.com/acme/infra.git//envs/prod?ref=${SHA}"`
    );
    expect(t.templateBody).toContain("Frozen");
  });

  it("omits the subdirectory separator for a root working directory", () => {
    const t = adopt({ workingDirectory: null });
    expect(t.templateBody).toContain(`git::https://github.com/acme/infra.git?ref=${SHA}`);
  });

  it("passes sensitive variables through and never makes them inputs", () => {
    const t = adopt();
    expect(t.templateBody).toContain('variable "db_password" {\n  sensitive = true\n}');
    expect(t.templateBody).toMatch(/^  db_password += var\.db_password$/m);
    expect(Object.keys(t.inputSchema.properties as object)).not.toContain("db_password");
  });

  it("leaves env variables out, and says so", () => {
    const t = adopt();
    expect(t.templateBody).not.toContain("AWS_ACCESS_KEY_ID");
    expect(t.skipped).toEqual([
      { key: "AWS_ACCESS_KEY_ID", reason: "environment variable, not a module input" },
    ]);
  });

  it("renders through the real renderer with the adopted values", () => {
    const t = adopt();
    const args = { region: "us-west-2", instance_count: "3" };
    validateArguments(t.inputSchema, args);
    const out = renderTemplate(t.templateBody, args);
    expect(out).toMatch(/^  region += "us-west-2"$/m);
    // HCL variable keeps its hyphenated Terraform name, rendered unquoted.
    expect(out).toMatch(/^  instance-count = 3$/m);
  });

  it.each([
    ['us-east-1" } resource "null_resource" "x" {'],
    ["${file(\"/etc/passwd\")}"],
    ["%{ if true }x%{ endif }"],
    ["line\nbreak"],
    ["back\\slash"],
  ])("rejects a string value that could escape its quotes: %s", (region) => {
    const t = adopt();
    expect(() => validateArguments(t.inputSchema, { region, instance_count: "1" })).toThrow(
      TfInputValidationError
    );
  });

  it("refuses a workspace with no VCS source", () => {
    expect(() => adopt({ repoUrl: null })).toThrow(NotTemplatizableError);
  });

  it("refuses a missing or malformed commit", () => {
    expect(() => adopt({ commitSha: null })).toThrow(NotTemplatizableError);
    expect(() => adopt({ commitSha: "main" })).toThrow(NotTemplatizableError);
  });

  it("refuses a working directory that walks out of the repo", () => {
    expect(() => adopt({ workingDirectory: "../other" })).toThrow(NotTemplatizableError);
  });
});

describe("adoptedTemplateSlug", () => {
  it("embeds the org so two orgs adopting the same name do not collide", () => {
    expect(adoptedTemplateSlug("orgA1", "Core_Network")).toMatch(/^adopted-orga1-core-network-[0-9a-f]{8}$/);
    expect(adoptedTemplateSlug("orgA1", "x")).not.toBe(adoptedTemplateSlug("orgB2", "x"));
  });

  it("keeps names apart that normalize to the same slug", () => {
    expect(adoptedTemplateSlug("o", "foo_bar")).not.toBe(adoptedTemplateSlug("o", "foo-bar"));
  });

  it("stays within the catalog's slug alphabet", () => {
    expect(adoptedTemplateSlug("o", "Weird Name!!".repeat(20))).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("snapshotInputs on env variables", () => {
  it("drops env values even when not marked sensitive", () => {
    const out = snapshotInputs([
      { key: "AWS_SECRET_ACCESS_KEY", value: "oops", category: "env", hcl: false, sensitive: false, description: "" },
    ]);
    expect(out[0]).not.toHaveProperty("value");
  });
});

describe("module label", () => {
  it("is a valid HCL label when the workspace name starts with a digit", () => {
    const t = adopt({ workspaceName: "2024-network" });
    expect(t.templateBody).toContain('module "ws_2024-network" {');
  });
});

describe("TFE hostname safety", () => {
  it.each(["localhost", "10.0.0.2", "127.0.0.1", "tfe.internal:8443", "intranet"])(
    "rejects %s at the schema",
    (hostname) => {
      expect(tfcCredentialSchema.safeParse({ hostname, organization: "a", token: "t" }).success).toBe(false);
    }
  );

  it("accepts a public DNS name and defaults to HCP Terraform", () => {
    expect(tfcCredentialSchema.parse({ organization: "a", token: "t" }).hostname).toBe("app.terraform.io");
    expect(tfcCredentialSchema.safeParse({ hostname: "tfe.acme.com", organization: "a", token: "t" }).success).toBe(true);
  });

  it.each(["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.2"])(
    "treats %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true)
  );

  it.each(["1.1.1.1", "52.1.2.3", "2606:4700::1111"])("treats %s as public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false)
  );

  it("refuses a public-looking name that resolves privately", async () => {
    await expect(
      assertPublicHost("tfe.evil.example", async () => [{ address: "52.1.2.3" }, { address: "10.0.0.2" }])
    ).rejects.toBeInstanceOf(UnsafeHostError);
    await expect(assertPublicHost("tfe.acme.com", async () => [{ address: "52.1.2.3" }])).resolves.toBeUndefined();
  });
});

describe("applyOrder / destroyOrder", () => {
  it("applies bases before extensions, and destroys in reverse", () => {
    // app reads db and network; db reads network.
    const edges = [
      { workspaceId: "app", dependsOnId: "db" },
      { workspaceId: "app", dependsOnId: "network" },
      { workspaceId: "db", dependsOnId: "network" },
    ];
    expect(applyOrder(["app", "db", "network"], edges)).toEqual(["network", "db", "app"]);
    expect(destroyOrder(["app", "db", "network"], edges)).toEqual(["app", "db", "network"]);
  });

  it("is stable for independent workspaces", () => {
    expect(applyOrder(["c", "a", "b"], [])).toEqual(["a", "b", "c"]);
  });

  it("names the cycle instead of returning a partial order", () => {
    const edges = [
      { workspaceId: "a", dependsOnId: "b" },
      { workspaceId: "b", dependsOnId: "c" },
      { workspaceId: "c", dependsOnId: "a" },
    ];
    try {
      applyOrder(["a", "b", "c"], edges);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyCycleError);
      expect((err as DependencyCycleError).cycle).toEqual(["a", "b", "c", "a"]);
    }
  });

  it("rejects an edge to a workspace outside the graph", () => {
    expect(() => applyOrder(["a"], [{ workspaceId: "a", dependsOnId: "zz" }])).toThrow(/outside the graph/);
  });
});

describe("renderWiring", () => {
  const wiring = () =>
    renderWiring({
      hostname: "app.terraform.io",
      organization: "acme",
      bases: [
        { workspaceName: "core-network", outputs: { vpc_id: "vpc_id", subnets: "private_subnet_ids" } },
        { workspaceName: "data", outputs: { db_url: "connection_string" } },
      ],
    });

  it("reads each base through remote state, by workspace name", () => {
    const hcl = wiring();
    expect(hcl).toContain('data "terraform_remote_state" "core_network" {');
    expect(hcl).toContain('      name = "core-network"');
    expect(hcl).toContain('    organization = "acme"');
    expect(hcl).toMatch(/^  subnets += data\.terraform_remote_state\.core_network\.outputs\.private_subnet_ids$/m);
    expect(hcl).toMatch(/^  db_url += data\.terraform_remote_state\.data\.outputs\.connection_string$/m);
  });

  it("does not use the tfe provider, which would need a token in the workspace", () => {
    expect(wiring()).not.toMatch(/tfe_outputs|provider "tfe"|TFE_TOKEN/);
  });

  it("rejects one local wired from two bases", () => {
    expect(() =>
      renderWiring({
        hostname: "app.terraform.io",
        organization: "acme",
        bases: [
          { workspaceName: "a", outputs: { id: "id" } },
          { workspaceName: "b", outputs: { id: "id" } },
        ],
      })
    ).toThrow(WiringError);
  });

  it("rejects two bases that collapse to one label", () => {
    expect(() =>
      renderWiring({
        hostname: "app.terraform.io",
        organization: "acme",
        bases: [
          { workspaceName: "a-b", outputs: {} },
          { workspaceName: "a_b", outputs: {} },
        ],
      })
    ).toThrow(/same label/);
  });

  it("rejects names that would inject HCL", () => {
    expect(() =>
      renderWiring({
        hostname: "app.terraform.io",
        organization: "acme",
        bases: [{ workspaceName: "a", outputs: { "x = 1\n y": "id" } }],
      })
    ).toThrow(WiringError);
  });
});

describe("missingOutputs", () => {
  it("lists requested outputs the base does not have", () => {
    expect(missingOutputs({ a: "vpc_id", b: "nope" }, [{ name: "vpc_id" }])).toEqual(["nope"]);
  });
});
