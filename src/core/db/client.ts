import path from "node:path";
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { migrate as migratePgliteDriver } from "drizzle-orm/pglite/migrator";
import { migrate as migrateNeonDriver } from "drizzle-orm/neon-http/migrator";
import * as schema from "./schema";

/** Drizzle's PGlite database type is the canonical shape used throughout the app.
 *  Both drivers speak the same Postgres dialect; the Neon instance is adapted to
 *  this type so application code never branches on the backing provider. */
export type Database = PgliteDatabase<typeof schema>;
export type DatabaseMode = "pglite" | "neon";

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "src/core/db/migrations");

let cachedDb: Database | null = null;
let cachedClient: PGlite | null = null;
let cachedMode: DatabaseMode = "pglite";

/** Next.js compiles route handlers and server components into separate module
 *  graphs. PGlite is an in-process engine, so both graphs must share one
 *  instance or they would read separate snapshots of the same data directory. */
const shared = globalThis as typeof globalThis & {
  __searchrankDb?: Database;
  __searchrankPglite?: PGlite;
  __searchrankMode?: DatabaseMode;
};

export function databaseMode(): DatabaseMode {
  return cachedMode;
}

export function isNeonConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);
}

/**
 * Returns the process-wide database. Local development and tests use embedded
 * PGlite (real Postgres in WASM). Setting DATABASE_URL switches to Neon HTTP.
 */
export function getDb(): Database {
  if (cachedDb) return cachedDb;
  if (shared.__searchrankDb) {
    cachedDb = shared.__searchrankDb;
    cachedClient = shared.__searchrankPglite ?? null;
    cachedMode = shared.__searchrankMode ?? "pglite";
    return cachedDb;
  }

  if (isNeonConfigured()) {
    const sql = neon(process.env.DATABASE_URL!);
    cachedDb = drizzleNeon(sql, { schema }) as unknown as Database;
    cachedMode = "neon";
  } else {
    const dataDir = process.env.PGLITE_DATA_DIR || "./.data/pglite";
    mkdirSync(path.resolve(/* turbopackIgnore: true */ dataDir), { recursive: true });
    cachedClient = new PGlite(dataDir);
    cachedDb = drizzlePglite(cachedClient, { schema });
    cachedMode = "pglite";
  }
  shared.__searchrankDb = cachedDb;
  shared.__searchrankPglite = cachedClient ?? undefined;
  shared.__searchrankMode = cachedMode;
  return cachedDb;
}

/** Creates an isolated in-memory Postgres for tests. */
export function createTestDatabase(): {
  db: Database;
  client: PGlite;
  close: () => Promise<void>;
} {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  return {
    db,
    client,
    close: () => client.close(),
  };
}

/** Applies all generated migrations to the given database. */
export async function runMigrations(db: Database, mode: DatabaseMode = cachedMode): Promise<void> {
  if (mode === "neon") {
    await migrateNeonDriver(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    await migratePgliteDriver(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

/** Convenience used by scripts and the dev server bootstrap. */
export async function ensureDatabase(): Promise<Database> {
  const db = getDb();
  await runMigrations(db);
  return db;
}
