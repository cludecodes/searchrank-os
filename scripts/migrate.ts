import { databaseMode, getDb, runMigrations } from "../src/core/db/client";

async function main() {
  const db = getDb();
  await runMigrations(db);
  console.log(`[migrate] migrations applied (${databaseMode()})`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
});
