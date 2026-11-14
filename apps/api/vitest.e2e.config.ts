import { defineConfig } from "vitest/config";

// The e2e suite (`pnpm e2e` at the repository root, or `make e2e`): runs
// against docker-compose.e2e.yml, never against a real account. One file at
// a time, because the files share one API, one fake and one database.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    globalSetup: ["e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
