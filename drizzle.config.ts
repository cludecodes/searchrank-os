import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/core/db/schema.ts",
  out: "./src/core/db/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  dbCredentials: {
    // drizzle-kit only needs a valid URL to read dialect metadata.
    // Set DATABASE_URL for Neon, or PGLITE_URL for local generation.
    url: process.env.DATABASE_URL ?? "postgresql://local:local@localhost:5432/searchrank",
  },
});
