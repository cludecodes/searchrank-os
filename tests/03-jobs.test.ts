import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs } from "../src/core/db/schema";
import { seedIdentity, setupTestDb } from "./helpers";
import { appendJobLog, claimJobs, completeJob, enqueueJob, failJob, getJobLogs, getQueueStats } from "../src/core/jobs/queue";
import { processJob, registerJobHandler, runDueJobsOnce } from "../src/core/jobs/runner";

beforeAll(() => {
  registerJobHandler({
    type: "test.success",
    description: "test",
    async run(ctx) {
      await ctx.log("step one");
      return { answered: ctx.input.value };
    },
  });
  registerJobHandler({
    type: "test.fail",
    description: "test",
    async run() {
      throw new Error("intentional failure");
    },
  });
});

describe("durable job queue", () => {
  it("claims only due pending jobs, atomically", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await enqueueJob(db, { workspaceId, type: "test.success", payload: { value: 42 } });
    await enqueueJob(db, { workspaceId, type: "test.success", runAt: new Date(Date.now() + 600_000) });
    const claimed = await claimJobs(db, "worker-a", 10);
    expect(claimed).toHaveLength(1);
    expect(await claimJobs(db, "worker-b", 10)).toHaveLength(0);
    await close();
  });

  it("executes handlers, stores results and writes logs", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const job = await enqueueJob(db, { workspaceId, type: "test.success", payload: { value: "ok" } });
    const claimed = await claimJobs(db, "worker-a");
    expect(claimed[0].id).toBe(job.id);
    const result = await processJob(db, claimed[0]);
    expect(result.status).toBe("succeeded");
    const logs = await getJobLogs(db, job.id);
    expect(logs.map((l) => l.message)).toContain("step one");
    expect((await getQueueStats(db)).succeeded).toBe(1);
    await close();
  });

  it("retries failed jobs with backoff then marks them terminal", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const job = await enqueueJob(db, { workspaceId, type: "test.fail", maxAttempts: 2 });
    let claimed = await claimJobs(db, "worker-a");
    let outcome = await processJob(db, claimed[0]);
    expect(outcome.status).toBe("failed");
    let stored = (await db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
    expect(stored.status).toBe("pending");
    expect(stored.runAt.getTime()).toBeGreaterThan(Date.now());

    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, job.id));
    claimed = await claimJobs(db, "worker-a");
    expect(claimed).toHaveLength(1);
    outcome = await processJob(db, claimed[0]);
    expect(outcome.status).toBe("failed");
    stored = (await db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
    expect(stored.status).toBe("failed");
    expect(stored.lastError).toContain("intentional failure");
    await close();
  });

  it("reclaims jobs abandoned by crashed workers", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const job = await enqueueJob(db, { workspaceId, type: "test.success" });
    await db.update(jobs).set({ status: "running", lockedBy: "dead-worker", lockedAt: new Date(Date.now() - 600_000) }).where(eq(jobs.id, job.id));
    const results = await runDueJobsOnce(db, { workerId: "worker-b", concurrency: 5, pollMs: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("succeeded");
    await close();
  });

  it("records manual completion and explicit failures", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const job = await enqueueJob(db, { workspaceId, type: "test.success" });
    await appendJobLog(db, job.id, "warn", "heads up", { code: 1 });
    await completeJob(db, job.id, { done: true });
    const failed = await failJob(db, { ...job, attempts: job.maxAttempts }, "terminal");
    expect(failed.willRetry).toBe(false);
    expect((await getJobLogs(db, job.id))[0].level).toBe("warn");
    await close();
  });
});
