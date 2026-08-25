import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    // Determinism guard: no fake timers, no parallel file races on shared fixtures
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
