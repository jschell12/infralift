import { describe, expect, it } from "vitest";
import type { ResourceInventoryItem } from "@infralift/shared";
import { generateHcl } from "./codegen.js";

function hclFor(inventory: ResourceInventoryItem[], provider = "heroku") {
  const files = generateHcl({
    provider: provider as ResourceInventoryItem["provider"],
    inventory,
    backend: "local",
    migrationTarget: null,
  });
  const body = files.find((f) => f.fileName === `${provider}.tf`);
  return body?.content ?? "";
}

const app: ResourceInventoryItem = {
  provider: "heroku",
  type: "heroku:app",
  externalId: "0f9d5d16-edd7-40fb-967e-03e71123ff2e",
  name: "infralift-test-data",
  region: "us",
  metadata: { stack: "heroku-24" },
};

describe("heroku addon codegen", () => {
  // The addon display name is "app-name: addon-service". Splitting on the
  // first space leaves the app name carrying a trailing colon, which sanitizes
  // to heroku_app.infralift_test_data_ and fails `tofu validate` with
  // "Reference to undeclared resource".
  it("references the owning app without a trailing underscore", () => {
    const addon: ResourceInventoryItem = {
      provider: "heroku",
      type: "heroku:addon",
      externalId: "bb9884f2-555c-4cc2-bc32-1d603b7d8b2d",
      name: "infralift-test-data: heroku-postgresql",
      metadata: { plan: "heroku-postgresql:essential-0" },
    };

    const hcl = hclFor([app, addon]);

    expect(hcl).toContain("app_id = heroku_app.infralift_test_data.id");
    expect(hcl).not.toContain("heroku_app.infralift_test_data_.id");
  });

  it("prefers appName from metadata when the connector recorded it", () => {
    const addon: ResourceInventoryItem = {
      provider: "heroku",
      type: "heroku:addon",
      externalId: "fa2dff36-3e65-4509-8537-0693e037f1f8",
      name: "infralift-test-data: heroku-redis",
      metadata: {
        plan: "heroku-redis:mini",
        appName: "infralift-test-data",
      },
    };

    const hcl = hclFor([app, addon]);

    expect(hcl).toContain("app_id = heroku_app.infralift_test_data.id");
  });

  it("emits a resource the import block can target", () => {
    const addon: ResourceInventoryItem = {
      provider: "heroku",
      type: "heroku:addon",
      externalId: "bb9884f2-555c-4cc2-bc32-1d603b7d8b2d",
      name: "infralift-test-data: heroku-postgresql",
      metadata: { plan: "heroku-postgresql:essential-0", appName: "infralift-test-data" },
    };

    const files = generateHcl({
      provider: "heroku",
      inventory: [app, addon],
      backend: "local",
      migrationTarget: null,
    });
    const imports = files.find((f) => f.fileName === "imports.tf")?.content ?? "";
    const body = files.find((f) => f.fileName === "heroku.tf")?.content ?? "";

    // Every import target must correspond to a declared resource.
    for (const [, address] of imports.matchAll(/to\s+=\s+(\S+)/g)) {
      const [type, name] = address.split(".");
      expect(body).toContain(`resource "${type}" "${name}"`);
    }
  });
});
