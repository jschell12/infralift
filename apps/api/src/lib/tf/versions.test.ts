import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyProviders,
  classifyRelease,
  classifyRequiredVersion,
  classifyVersion,
  constraintFloor,
  factsFromFiles,
  parseLockFile,
  parseRootConstraints,
  parseVersion,
  worstStatus,
} from "./versions.js";

// Both lock files are real, copied verbatim from repositories `terraform
// init` and `tofu init` wrote them in (hashes and all): one Terraform lock
// with three providers, one OpenTofu lock with four. The terraform block
// beside the first is the one from the same root module, minus its cloud
// block, which named an organization.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8");
const TERRAFORM_LOCK = fixture("lock-terraform-three-providers.hcl");
const TOFU_LOCK = fixture("lock-tofu-four-providers.hcl");
const TERRAFORM_MAIN = `terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.41"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
`;

describe("parseVersion and constraintFloor", () => {
  it.each([
    ["5.28.1", [5, 28, 1]],
    ["1.5", [1, 5, 0]],
    ["v1.10.0", [1, 10, 0]],
    ["1.10.0-beta1", null],
    ["latest", null],
  ])("parses %s", (text, want) => {
    expect(parseVersion(text)).toEqual(want);
  });

  it.each([
    ["~> 5.28", [5, 28, 0]],
    ["~> 6.73.0", [6, 73, 0]],
    [">= 1.5", [1, 5, 0]],
    ["5.24.0", [5, 24, 0]],
    ["= 5.24.0", [5, 24, 0]],
    // Two files each setting required_version: all must hold, so the higher.
    [">= 1.6, >= 1.8", [1, 8, 0]],
    [">= 1.0, < 2.0", [1, 0, 0]],
    ["< 2.0", null],
    ["", null],
  ])("reads the lowest version %j allows", (constraint, want) => {
    expect(constraintFloor(constraint)).toEqual(want);
  });
});

describe("classifyVersion", () => {
  it.each([
    [[5, 28, 0], [5, 28, 0], "current"],
    [[5, 30, 2], [5, 28, 0], "current"],
    [[6, 0, 0], [5, 28, 0], "current"],
    [[5, 22, 0], [5, 28, 0], "behind-minor"],
    [[6, 73, 0], [6, 73, 1], "behind-minor"],
    [[4, 52, 0], [5, 28, 0], "behind-major"],
  ] as const)("%j against %j is %s", (have, want, status) => {
    expect(classifyVersion(have, want)).toBe(status);
  });

  it("ranks behind over unknown over current", () => {
    expect(worstStatus([])).toBe("current");
    expect(worstStatus(["current", "unknown"])).toBe("unknown");
    expect(worstStatus(["unknown", "behind-minor", "current"])).toBe("behind-minor");
    expect(worstStatus(["behind-major", "behind-minor"])).toBe("behind-major");
  });
});

describe("parseLockFile", () => {
  it("reads every provider of a real Terraform lock file, registry host dropped", () => {
    expect(parseLockFile(TERRAFORM_LOCK)).toEqual([
      { source: "cloudflare/cloudflare", registry: "registry.terraform.io", version: "5.22.0" },
      { source: "hashicorp/random", registry: "registry.terraform.io", version: "3.9.0" },
      { source: "hetznercloud/hcloud", registry: "registry.terraform.io", version: "1.66.0" },
    ]);
  });

  it("reads an OpenTofu lock file the same way", () => {
    expect(parseLockFile(TOFU_LOCK)).toEqual([
      { source: "cloudflare/cloudflare", registry: "registry.opentofu.org", version: "5.28.1" },
      { source: "hashicorp/tls", registry: "registry.opentofu.org", version: "4.4.2" },
      { source: "hetznercloud/hcloud", registry: "registry.opentofu.org", version: "1.70.2" },
      { source: "integrations/github", registry: "registry.opentofu.org", version: "6.13.0" },
    ]);
  });

  it("is empty for an empty lock file, not an error", () => {
    expect(parseLockFile("# This file is maintained automatically by \"terraform init\".\n")).toEqual([]);
  });
});

describe("parseRootConstraints", () => {
  it("reads required_providers and joins required_version across files", () => {
    const r = parseRootConstraints([
      { path: "infra/main.tf", content: TERRAFORM_MAIN },
      { path: "infra/versions.tf", content: 'terraform {\n  required_version = ">= 1.6"\n}\n' },
      { path: "infra/backend.tf", content: 'terraform {\n  required_version = ">= 1.8"\n  backend "s3" {}\n}\n' },
    ]);
    expect(r.requiredVersion).toBe(">= 1.6, >= 1.8");
    expect(r.constraints).toEqual([
      { source: "cloudflare/cloudflare", constraint: "~> 5.0" },
      { source: "hashicorp/random", constraint: "~> 3.6" },
      { source: "hetznercloud/hcloud", constraint: "~> 1.41" },
    ]);
    expect(r.notes).toEqual([]);
  });

  it("names a file that does not parse and keeps the rest", () => {
    const r = parseRootConstraints([
      { path: "infra/broken.tf", content: "terraform {\n  required_version = \n" },
      { path: "infra/main.tf", content: TERRAFORM_MAIN },
    ]);
    expect(r.notes).toEqual(["infra/broken.tf could not be parsed and was left out."]);
    expect(r.constraints).toHaveLength(3);
    expect(r.requiredVersion).toBeNull();
  });
});

describe("classifyProviders", () => {
  it("compares each locked provider with the baseline, and says why one is not compared", () => {
    const facts = factsFromFiles({ ref: "main", path: "infra", tfFiles: [{ path: "infra/main.tf", content: TERRAFORM_MAIN }], lockFile: TERRAFORM_LOCK });
    expect(classifyProviders(facts)).toEqual([
      // Baseline ~> 5.28: same major, older minor.
      { name: "cloudflare/cloudflare", have: "5.22.0", want: "~> 5.28", status: "behind-minor", note: null },
      // Not in baseline.ts: unknown, never current by default.
      {
        name: "hashicorp/random",
        have: "3.9.0",
        want: null,
        status: "unknown",
        note: "infralift's baseline does not pin this provider, so there is nothing to compare it with.",
      },
      { name: "hetznercloud/hcloud", have: "1.66.0", want: "~> 1.70", status: "behind-minor", note: null },
    ]);
  });

  it("calls a major behind behind-major and one at the baseline current", () => {
    const facts = factsFromFiles({ ref: "main", path: "", tfFiles: [], lockFile: TOFU_LOCK });
    const baseline = { "cloudflare/cloudflare": "~> 6.0", "hashicorp/tls": "~> 4.0", "hetznercloud/hcloud": "~> 1.70", "integrations/github": "~> 6.14" };
    const byName = Object.fromEntries(classifyProviders(facts, baseline).map((i) => [i.name, i.status]));
    expect(byName).toEqual({
      "cloudflare/cloudflare": "behind-major",
      "hashicorp/tls": "current",
      "hetznercloud/hcloud": "current",
      "integrations/github": "behind-minor",
    });
    // Written by tofu against today's baseline: all four current.
    expect(classifyProviders(facts).map((i) => i.status)).toEqual(["current", "current", "current", "current"]);
  });

  it("does not guess from constraints when there is no lock file", () => {
    const facts = factsFromFiles({ ref: "main", path: "infra", tfFiles: [{ path: "infra/main.tf", content: TERRAFORM_MAIN }], lockFile: null });
    const items = classifyProviders(facts);
    expect(items.map((i) => i.status)).toEqual(["unknown", "unknown", "unknown"]);
    expect(items[0]).toMatchObject({ have: null, want: "~> 5.28" });
    expect(items[0]!.note).toBe("No .terraform.lock.hcl in infra, so the installed version is not known (the code asks for ~> 5.0).");
  });

  it("is empty when nothing is declared or locked", () => {
    expect(classifyProviders(factsFromFiles({ ref: "main", path: "", tfFiles: [], lockFile: null }))).toEqual([]);
  });

  it("marks a provider declared but missing from the lock file unknown", () => {
    const facts = factsFromFiles({
      ref: "main",
      path: "",
      tfFiles: [{ path: "main.tf", content: 'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.0" }\n  }\n}\n' }],
      lockFile: TOFU_LOCK,
    });
    const aws = classifyProviders(facts).find((i) => i.name === "hashicorp/aws");
    expect(aws).toMatchObject({ status: "unknown", have: null, note: "Declared as ~> 6.0 but not in the lock file. The next init adds it." });
  });

  it("notes a lock file that does not parse and compares nothing from it", () => {
    const facts = factsFromFiles({ ref: "main", path: "", tfFiles: [], lockFile: 'provider "registry.terraform.io/hashicorp/aws" {\n  version = \n' });
    expect(facts.notes).toEqual([".terraform.lock.hcl could not be parsed."]);
    expect(facts.locked).toEqual([]);
  });
});

describe("classifyRequiredVersion", () => {
  const facts = (requiredVersion: string | null) => ({ ...factsFromFiles({ ref: "main", path: "infra", tfFiles: [], lockFile: null }), requiredVersion });

  it("holds a stack to the stack floor and others to the generated floor", () => {
    expect(classifyRequiredVersion(facts(">= 1.6"), "stack")).toMatchObject({ status: "current", want: ">= 1.6" });
    expect(classifyRequiredVersion(facts(">= 1.5"), "stack")).toMatchObject({ status: "behind-minor" });
    expect(classifyRequiredVersion(facts(">= 1.5"), "generated")).toMatchObject({ status: "current" });
    expect(classifyRequiredVersion(facts(">= 0.14"), "generated")).toMatchObject({ status: "behind-major" });
  });

  it("is unknown when nothing pins it", () => {
    expect(classifyRequiredVersion(facts(null), "generated")).toMatchObject({
      status: "unknown",
      note: "No required_version in infra: any Terraform or OpenTofu version may run it.",
    });
  });
});

describe("classifyRelease", () => {
  it("compares releases and leaves an unrecorded one unknown", () => {
    expect(classifyRelease("1.0.0", "1.0.0", "x").status).toBe("current");
    expect(classifyRelease("1.0.0", "1.2.0", "x").status).toBe("behind-minor");
    expect(classifyRelease("1.4.0", "2.0.0", "x").status).toBe("behind-major");
    expect(classifyRelease(null, "1.0.0", "Made before releases were recorded.")).toEqual({
      name: "stack release",
      have: null,
      want: "1.0.0",
      status: "unknown",
      note: "Made before releases were recorded.",
    });
  });
});
