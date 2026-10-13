import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Live checks against real Nebius. Never part of `npm test`: they spend real (if tiny)
 * money and need credentials. Run with the env loaded:
 *
 *   npm run test:live -- tests/live/g5-conditional-put.live.ts
 *
 * Each writes what it measured to evidence/, which is what the README cites.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.ts"],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60_000,
  },
});
