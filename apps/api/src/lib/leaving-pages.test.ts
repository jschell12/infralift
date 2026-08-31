import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDemoVercelAssessment,
  buildDemoHerokuAssessment,
  buildDemoRenderAssessment,
  buildDemoRailwayAssessment,
  buildDemoDigitaloceanAssessment,
  buildDemoFirebaseAssessment,
} from "./demo-fixture.js";
import { computeFootprint, sizeTarget } from "./sizing.js";

// The /leaving/<provider> landing pages carry hard-coded dollar figures, and
// apps/web/lib/leaving.ts says of them: "Every number here comes from the demo
// assessment pipeline ... When a fixture or price table changes, update this
// file to match."
//
// Nothing enforced that. A change to sizing.ts or to a demo fixture would
// leave six public marketing pages quoting numbers the product no longer
// produces, and the failure is silent: the pages still render, they are just
// wrong. This is the enforcement.
//
// It reads the marketing file as text rather than importing it, because
// apps/api does not and should not depend on apps/web.

const LEAVING_TS = join(process.cwd(), "..", "web", "lib", "leaving.ts");

const PAGES = [
  { slug: "vercel", build: buildDemoVercelAssessment, target: "cloudflare" },
  { slug: "heroku", build: buildDemoHerokuAssessment, target: "hetzner" },
  { slug: "render", build: buildDemoRenderAssessment, target: "hetzner" },
  { slug: "railway", build: buildDemoRailwayAssessment, target: "hetzner" },
  {
    slug: "digitalocean",
    build: buildDemoDigitaloceanAssessment,
    target: "hetzner",
  },
  { slug: "firebase", build: buildDemoFirebaseAssessment, target: "cloudflare" },
] as const;

/** Same formatting the marketing file uses: whole dollars, thousands
 * separated, "/mo" suffix. */
function usd(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US") + "/mo";
}

interface PublishedPage {
  billTotal: string;
  exitTotal: string;
  exitSavings: string;
  exitName: string;
}

/** Pull each page's headline figures out of the marketing source. */
function readPublished(): Map<string, PublishedPage> {
  const source = readFileSync(LEAVING_TS, "utf8");
  const out = new Map<string, PublishedPage>();

  // Split on the slug so each block is scoped to one page.
  const blocks = source.split(/\n\s*\{\s*\n\s*slug:\s*"/).slice(1);
  for (const block of blocks) {
    const slug = block.slice(0, block.indexOf('"'));
    const field = (name: string) =>
      block.match(new RegExp(`${name}:\\s*"([^"]*)"`))?.[1];
    const billTotal = field("billTotal");
    const exitTotal = field("exitTotal");
    const exitSavings = field("exitSavings");
    const exitName = field("exitName");
    if (billTotal && exitTotal && exitSavings && exitName) {
      out.set(slug, { billTotal, exitTotal, exitSavings, exitName });
    }
  }
  return out;
}

describe("marketing /leaving pages match the pricing pipeline", () => {
  const published = readPublished();

  it("covers every page the pipeline can price", () => {
    // If a page is added to the marketing site without a fixture, or the
    // parser stops matching after a refactor, this catches it rather than
    // letting the per-page assertions below silently skip.
    expect([...published.keys()].sort()).toEqual(
      PAGES.map((p) => p.slug).sort()
    );
  });

  for (const page of PAGES) {
    it(`${page.slug}: published figures equal what the engine computes`, () => {
      const live = published.get(page.slug);
      expect(live, `no published block for ${page.slug}`).toBeDefined();

      const { inventory, estimatedMonthlyCostCents } = page.build();
      const billCents = estimatedMonthlyCostCents ?? 0;
      const sizing = sizeTarget(page.target, computeFootprint(inventory));
      expect(sizing, `${page.target} lost its sizing model`).not.toBeNull();
      const exitCents = sizing!.monthlyCents;

      const expected = {
        billTotal: usd(billCents),
        exitTotal: usd(exitCents),
        exitSavings: usd(billCents - exitCents),
      };

      expect(
        {
          billTotal: live!.billTotal,
          exitTotal: live!.exitTotal,
          exitSavings: live!.exitSavings,
        },
        `apps/web/lib/leaving.ts is stale for /leaving/${page.slug}. ` +
          `Update it to match, or the public page quotes a number the ` +
          `product no longer produces.`
      ).toEqual(expected);
    });
  }

  it("names a target the codegen can actually build", () => {
    // "Hetzner + Neon + Upstash" and "Cloudflare Workers" are promises that
    // infralift can execute this migration. Only two targets have sizing
    // models and codegen, so a page naming anything else is overselling.
    for (const page of PAGES) {
      const name = published.get(page.slug)!.exitName.toLowerCase();
      expect(
        name.includes(page.target),
        `/leaving/${page.slug} names "${published.get(page.slug)!.exitName}" ` +
          `but is priced against ${page.target}`
      ).toBe(true);
    }
  });

  it("never publishes a savings figure that is not a real saving", () => {
    for (const page of PAGES) {
      const savings = published.get(page.slug)!.exitSavings;
      expect(
        savings.startsWith("-"),
        `/leaving/${page.slug} publishes negative savings (${savings}), ` +
          `which means the page argues against its own migration`
      ).toBe(false);
    }
  });
});
