import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderConnectionSummary } from "@infralift/shared";
import { ConnectionTile } from "./connection-tile";

// Rows as GET /connections sends them (toSummary in
// apps/api/src/services/connections.ts).
const base: ProviderConnectionSummary = {
  id: "c1",
  provider: "aws",
  label: "production",
  createdAt: "2026-10-01T00:00:00.000Z",
  lastVerifiedAt: "2026-11-10T00:00:00.000Z",
  status: "valid",
  lastError: null,
  expiresAt: null,
};

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("ConnectionTile", () => {
  it("shows a valid connection as a neutral check, not a colored chip", () => {
    const html = render(<ConnectionTile c={base} />);
    expect(html).toContain("AWS");
    expect(html).toContain("production");
    expect(html).toContain("✓ ");
    expect(html).not.toMatch(/text-danger|text-warn/);
  });

  it("shows an invalid connection in danger with its reason", () => {
    const html = render(<ConnectionTile c={{ ...base, status: "invalid", lastError: "Token revoked (403)" }} />);
    expect(html).toContain("invalid");
    expect(html).toContain("text-danger");
    expect(html).toContain("Token revoked (403)");
  });

  it("does not color an unverified connection as a failure", () => {
    const html = render(<ConnectionTile c={{ ...base, status: "unverified", lastVerifiedAt: null }} />);
    expect(html).toContain("unverified");
    expect(html).toContain("Not verified yet");
    expect(html).not.toMatch(/text-danger|text-warn/);
  });

  it("names Terraform Cloud", () => {
    expect(render(<ConnectionTile c={{ ...base, provider: "tfc" as ProviderConnectionSummary["provider"] }} />)).toContain(
      "Terraform Cloud"
    );
  });

  it("is one link when given href, with no buttons inside it", () => {
    const html = render(<ConnectionTile c={base} href="/connections" />);
    expect(html).toMatch(/^<li[^>]*><a [^>]*href="\/connections"/);
    expect(html).not.toContain("<button");
  });

  it("puts actions at the bottom of the tile", () => {
    const html = render(<ConnectionTile c={base} actions={<button type="button">Verify</button>} />);
    expect(html).toContain("<button");
    expect(html).not.toContain("<a ");
  });
});
