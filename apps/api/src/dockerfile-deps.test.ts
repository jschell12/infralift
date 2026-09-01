import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Why this exists: adding @infralift/collectors as a workspace dependency
// passed lint, all 169 tests, and `pnpm --filter './apps/*' build`, then broke
// the deploy. CI builds in the full checkout, where pnpm has linked every
// workspace package; the API image builds from a curated COPY list that did
// not mention the new one, so `tsc` inside Docker could not resolve it.
//
// The gap is that nothing between "it compiles here" and "it compiles in the
// image" runs on a pull request. Building the image in CI would close it
// properly and costs a couple of minutes; this is the cheap version that
// catches the specific mistake — a workspace dependency the Dockerfile never
// copies — in milliseconds and with no Docker daemon.

const API_PKG = new URL("../package.json", import.meta.url);
const DOCKERFILE = new URL("../Dockerfile", import.meta.url);

describe("the API image copies every workspace package it depends on", () => {
  it("has a COPY line for each workspace:* dependency", () => {
    const pkg = JSON.parse(readFileSync(API_PKG, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dockerfile = readFileSync(DOCKERFILE, "utf8");

    // "@infralift/collectors": "workspace:*"  ->  packages/collectors
    const workspaceDeps = Object.entries(pkg.dependencies ?? {})
      .filter(([, range]) => range.startsWith("workspace:"))
      .map(([name]) => name.replace(/^@infralift\//, ""));

    expect(workspaceDeps.length).toBeGreaterThan(0);

    for (const dir of workspaceDeps) {
      // The manifest has to land before `pnpm install --frozen-lockfile`, or
      // the lockfile no longer matches the workspace it describes.
      expect(
        dockerfile,
        `Dockerfile never copies packages/${dir}/package.json, so pnpm install cannot see it`
      ).toContain(`COPY packages/${dir}/package.json packages/${dir}/`);

      // ...and the sources have to land before the build, or tsc cannot
      // resolve the import and the runtime stage ships without the module.
      expect(
        dockerfile,
        `Dockerfile never copies packages/${dir}, so tsc cannot resolve it inside the image`
      ).toContain(`COPY packages/${dir} packages/${dir}/`);
    }
  });
});
