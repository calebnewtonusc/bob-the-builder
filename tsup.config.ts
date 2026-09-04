import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "core/index": "src/core/index.ts",
    "react/index": "src/react/index.ts",
    "audit/index": "src/audit/index.ts",
    "audit/cli": "src/audit/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: "es2022",
  external: ["react", "zod"],
});
