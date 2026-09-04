import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node by default; React tests opt into jsdom with a per-file docblock, so
    // the fast majority of the suite is not paying for a DOM it never touches.
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/audit/cli.ts", "src/**/index.ts"],
      reporter: ["text", "html"],
    },
  },
});
