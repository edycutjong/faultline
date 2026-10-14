import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      // Every line, branch and function of the engine is exercised; a drop fails the build.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
