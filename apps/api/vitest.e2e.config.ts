import { defineConfig } from "vitest/config";

// The e2e suite (`pnpm e2e` at the repository root, or `make e2e`): runs
// against docker-compose.e2e.yml, never against a real account. One file at
// a time, because the files share one API, one fake and one database.
export default defineConfig({
  test: {
    // fixtures-match-specs.test.ts runs here too, because Render's subset
    // exists only once setup has written it (it is not committed).
    include: ["e2e/**/*.e2e.test.ts", "e2e/specs/fixtures-match-specs.test.ts"],
    env: { E2E_REQUIRE_RENDER_SPEC: "1" },
    globalSetup: ["e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
