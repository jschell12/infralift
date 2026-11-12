import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdoptBackendDefaults, CloudflareAccountRef } from "@infralift/shared";
import { applyBackendDefaults, defaultAdoptForm } from "../lib/adopt-account";
import { AdoptTargetForm } from "./adopt-target-form";

// The R2 account select as the page renders it, after the page has applied
// the list's backendDefaults (lib/__fixtures__/unmanaged-api.json, recaptured
// through the API harness; see its _source).
const fx = JSON.parse(readFileSync(new URL("../lib/__fixtures__/unmanaged-api.json", import.meta.url), "utf8")) as {
  full: { body: { backendDefaults: AdoptBackendDefaults } };
};
const one = fx.full.body.backendDefaults.cloudflareAccounts;
// A second account beside the fixture's, as a token that sees two would list.
const two: CloudflareAccountRef[] = [...one, { id: "9f1c3e7a2b4d6f8091a2b3c4d5e6f708", name: "Client: Northwind" }];

function render(accounts: CloudflareAccountRef[]) {
  const form = applyBackendDefaults(defaultAdoptForm("cloudflare"), { cloudflareAccounts: accounts, awsRegion: null });
  return renderToStaticMarkup(<AdoptTargetForm form={form} onChange={() => {}} gitConnections={[]} cloudflareAccounts={accounts} />);
}

/** The option the select shows, from React's server markup (selected=""). */
const selectedOption = (html: string) => /<option[^>]*selected=""[^>]*>([^<]*)<\/option>/.exec(html)?.[1] ?? null;

describe("AdoptTargetForm R2 account", () => {
  it("preselects the only account the connection sees", () => {
    expect(selectedOption(render(one))).toBe("Demo Account · 023e105f");
  });

  it("starts on Choose an account when the connection sees two, and preselects neither", () => {
    const html = render(two);
    expect(selectedOption(html)).toBe("Choose an account");
    expect(html).toContain("Client: Northwind · 9f1c3e7a");
    expect(html).not.toContain('id="adopt-account-id"');
  });

  it("asks for the id as text when no account is known", () => {
    const html = render([]);
    expect(html).not.toContain('id="adopt-account"');
    expect(html).toContain('id="adopt-account-id"');
  });
});
