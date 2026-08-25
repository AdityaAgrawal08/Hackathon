import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.ARBITER_DB_PATH ?? "file:./data/arbiter.sqlite",
  },
  verbose: true,
  strict: true,
});
