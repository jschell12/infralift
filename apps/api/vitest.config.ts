import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "e2e/github-fake/*.test.ts", "e2e/specs/*.test.ts", "e2e/harness/*.test.ts"],
    globals: true,
  },
});
