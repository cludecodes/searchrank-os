import { ensureDatabase, getDb } from "../src/core/db/client";
import { registerBuiltinHandlers } from "../src/core/jobs/handlers";
import { listJobHandlers, startWorker } from "../src/core/jobs/runner";

async function main() {
  registerBuiltinHandlers();
  await ensureDatabase();
  const db = getDb();
  const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
  const stop = await startWorker(db, {
    workerId,
    concurrency: Number(process.env.WORKER_CONCURRENCY || 4),
    pollMs: Number(process.env.WORKER_POLL_MS || 2000),
  });
  console.log(`[worker] ${workerId} online with ${listJobHandlers().length} handlers`);
  const shutdown = () => {
    console.log("[worker] shutting down");
    stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[worker] failed:", error);
  process.exitCode = 1;
});
