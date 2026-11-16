import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectVersions } from "@infralift/shared";
import { VersionCard, VersionStatusChip, VersionSummary, versionSummaryText } from "./version-table";

// Rows as GET /tf/versions sends them (toProjectVersions in
// apps/api/src/services/versions.ts), with the provider versions of the real
// lock file its tests read (lib/tf/__fixtures__/lock-terraform-three-providers.hcl).
const base: ProjectVersions = {
  projectId: "proj_1",
  name: "web",
  kind: "stack",
  destRepo: "acme/web",
  status: "behind-minor",
  stack: { name: "stack release", have: "1.0.0", want: "1.0.0", status: "current", note: null },
  terraform: { name: "terraform", have: ">= 1.6", want: ">= 1.6", status: "current", note: null },
  providers: [
    { name: "cloudflare/cloudflare", have: "5.22.0", want: "~> 5.28", status: "behind-minor", note: null },
    {
      name: "hashicorp/random",
      have: "3.9.0",
      want: null,
      status: "unknown",
      note: "infralift's baseline does not pin this provider, so there is nothing to compare it with.",
    },
  ],
  checkedAt: "2026-11-16T12:00:00.000Z",
  ref: "main",
  path: "infra/network-baseline",
  problem: null,
  notes: [],
};

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("VersionStatusChip", () => {
  it("colours only what is behind: major in danger, minor in warn", () => {
    expect(render(<VersionStatusChip status="behind-major" />)).toContain("text-danger");
    expect(render(<VersionStatusChip status="behind-minor" />)).toContain("text-warn");
  });

  it("keeps current and unknown neutral", () => {
    for (const s of ["current", "unknown"] as const) {
      expect(render(<VersionStatusChip status={s} />)).not.toMatch(/text-danger|text-warn|bg-accent/);
    }
    expect(render(<VersionStatusChip status="current" />)).toContain("current");
    expect(render(<VersionStatusChip status="unknown" />)).toContain("unknown");
  });
});

describe("versionSummaryText", () => {
  it("names what is behind", () => {
    expect(versionSummaryText(base)).toBe("1 provider behind");
    expect(
      versionSummaryText({
        ...base,
        stack: { ...base.stack!, have: "1.0.0", want: "2.0.0", status: "behind-major" },
        providers: [base.providers[0]!, { ...base.providers[0]!, name: "hetznercloud/hcloud" }],
      })
    ).toBe("stack 1.0.0 of 2.0.0 · 2 providers behind");
  });

  it("says when nothing has been read, and shows a failed read's problem", () => {
    expect(versionSummaryText({ ...base, checkedAt: null, terraform: null, providers: [] })).toBe("Versions not read yet.");
    expect(versionSummaryText({ ...base, problem: "No GitHub connection to read the repository with." })).toBe(
      "No GitHub connection to read the repository with."
    );
  });

  it("does not call a project with unknowns current", () => {
    const v = { ...base, status: "unknown" as const, providers: [base.providers[1]!] };
    expect(versionSummaryText(v)).toBe("Some versions could not be compared.");
    expect(versionSummaryText({ ...base, status: "current", providers: [] })).toBe("Stack, Terraform and providers are current.");
  });
});

describe("VersionSummary", () => {
  it("renders nothing until the versions load", () => {
    expect(render(<VersionSummary v={undefined} />)).toBe("");
  });

  it("links to the project's row in the versions view with a full-height target", () => {
    const html = render(<VersionSummary v={base} />);
    expect(html).toMatch(/<a [^>]*class="[^"]*min-h-11[^"]*"[^>]*href="\/projects\/versions#proj_1"/);
  });
});

describe("VersionCard", () => {
  it("lists every item with what it has, what infralift asks for, and why one is unknown", () => {
    const html = render(<VersionCard v={base} />);
    expect(html).toContain('id="proj_1"');
    expect(html).toContain("stack release");
    expect(html).toContain("cloudflare/cloudflare");
    expect(html).toContain("5.22.0 · infralift ~&gt; 5.28");
    expect(html).toContain("nothing to compare it with");
    expect(html).toContain("acme/web@main · infra/network-baseline");
  });

  it("shows a project never read as such, not as an empty current list", () => {
    const html = render(<VersionCard v={{ ...base, status: "unknown", stack: null, terraform: null, providers: [], checkedAt: null, ref: null, path: null }} />);
    expect(html).toContain("Not read yet.");
    expect(html).toContain("Never read");
    expect(html).not.toContain("current");
  });

  it("shows the read's problem in words and a check error as an alert", () => {
    const html = render(
      <VersionCard v={{ ...base, problem: "GitHub refused the connection; reconnect it under Connections to read versions." }} checkError="Versions were checked a moment ago." />
    );
    expect(html).toContain("GitHub refused the connection");
    expect(html).toMatch(/role="alert"[^>]*>Versions were checked a moment ago\./);
  });

  it("offers Check now as a full-height button, and Checking... while it runs", () => {
    expect(render(<VersionCard v={base} onCheck={() => {}} />)).toMatch(/<button[^>]*min-h-11[^>]*>Check now<\/button>/);
    expect(render(<VersionCard v={base} onCheck={() => {}} checking />)).toMatch(/<button[^>]*disabled=""[^>]*>Checking\.\.\.<\/button>/);
    expect(render(<VersionCard v={base} />)).not.toContain("Check now");
  });
});
