import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Worker is the only thing here with logic worth testing; the pages
    // are a static export and are covered by the build plus the CI export
    // checks.
    include: ["worker/**/*.test.ts", "lib/**/*.test.ts"],
    globals: true,
  },
});
