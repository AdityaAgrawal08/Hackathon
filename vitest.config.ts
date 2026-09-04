import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    // Determinism guard: no fake timers, no parallel file races on shared fixtures
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
    // Isolate tests from production DB — use test database in data/
    env: {
      ARBITER_DB_PATH: "data/arbiter_test.sqlite",
      ARBITER_DB_TOKEN: "",
    },
  },
});

