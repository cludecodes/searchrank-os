import { ensureDatabase, getDb } from "../src/core/db/client";
import { registerBuiltinHandlers } from "../src/core/jobs/handlers";
import { runDueJobsOnce } from "../src/core/jobs/runner";

async function main() {
  registerBuiltinHandlers();
  await ensureDatabase();
  const results = await runDueJobsOnce(getDb(), {
    workerId: `one-shot-${process.pid}`,
    concurrency: 10,
    pollMs: 1000,
  });
  console.log(`[worker-once] processed ${results.length} job(s)`);
  for (const result of results) {
    console.log(`  ${result.jobId} ${result.status}${result.error ? `: ${result.error}` : ""}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("[worker-once] failed:", error);
  process.exitCode = 1;
});
