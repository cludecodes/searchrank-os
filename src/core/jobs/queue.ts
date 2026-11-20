import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { jobs, jobLogs, type Job, type JobPriority } from "../db/schema";

/** Normalizes the row shape returned by PGlite and Neon HTTP drivers. */
export async function rowsOf<T>(result: unknown): Promise<T[]> {
  const value = result as { rows?: T[] } | T[];
  if (Array.isArray(value)) return value;
  return value?.rows ?? [];
}

export interface EnqueueJobInput {
  type: string;
  payload?: Record<string, unknown>;
  workspaceId?: string | null;
  projectId?: string | null;
  priority?: JobPriority;
  runAt?: Date;
  maxAttempts?: number;
  createdBy?: string;
}

export async function enqueueJob(db: Database, input: EnqueueJobInput): Promise<Job> {
  const inserted = await db
    .insert(jobs)
    .values({
      type: input.type,
      payload: input.payload ?? {},
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      priority: input.priority ?? "normal",
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return inserted[0];
}

const PRIORITY_ORDER = sql`CASE ${jobs.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

/** Atomically claims up to `limit` due jobs using a single UPDATE ... RETURNING. */
export async function claimJobs(db: Database, workerId: string, limit = 1): Promise<Job[]> {
  const claimed = await rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE ${jobs}
      SET status = 'running',
          locked_at = now(),
          locked_by = ${workerId},
          attempts = ${jobs.attempts} + 1,
          updated_at = now()
      WHERE id IN (
        SELECT id FROM ${jobs}
        WHERE status = 'pending' AND run_at <= now()
        ORDER BY ${PRIORITY_ORDER}, run_at ASC
        LIMIT ${limit}
      )
      RETURNING id
    `),
  );
  if (!claimed.length) return [];
  return db.select().from(jobs).where(inArray(jobs.id, claimed.map((c) => c.id)));
}

export async function completeJob(db: Database, jobId: string, result: Record<string, unknown>): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "succeeded",
      result,
      lockedAt: null,
      lockedBy: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

/** Failed jobs retry with exponential backoff until maxAttempts is reached. */
export async function failJob(db: Database, job: Job, error: string): Promise<JobStatusAfterFailure> {
  const willRetry = job.attempts < job.maxAttempts;
  const delayMs = Math.min(1000 * 2 ** Math.max(0, job.attempts - 1), 300_000);
  const updated = await db
    .update(jobs)
    .set(
      willRetry
        ? {
            status: "pending",
            runAt: new Date(Date.now() + delayMs),
            lastError: error,
            lockedAt: null,
            lockedBy: null,
            updatedAt: new Date(),
          }
        : {
            status: "failed",
            lastError: error,
            lockedAt: null,
            lockedBy: null,
            finishedAt: new Date(),
            updatedAt: new Date(),
          },
    )
    .where(eq(jobs.id, job.id))
    .returning();
  return { job: updated[0], willRetry, retryAt: willRetry ? new Date(Date.now() + delayMs) : null };
}

export interface JobStatusAfterFailure {
  job: Job;
  willRetry: boolean;
  retryAt: Date | null;
}

export async function cancelJob(db: Database, jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "cancelled", lockedAt: null, lockedBy: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

export async function appendJobLog(
  db: Database,
  jobId: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(jobLogs).values({ jobId, level, message, metadata });
}

export async function getJobLogs(db: Database, jobId: string) {
  return db.select().from(jobLogs).where(eq(jobLogs.jobId, jobId)).orderBy(asc(jobLogs.createdAt));
}

/** Reclaims jobs abandoned by a crashed worker. */
export async function recoverStaleJobs(db: Database, staleAfterMs = 120_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const recovered = await db
    .update(jobs)
    .set({ status: "pending", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(and(eq(jobs.status, "running"), lte(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return recovered.length;
}

export async function getQueueStats(db: Database) {
  const result = await rowsOf<{ status: string; count: string }>(
    await db.execute(sql`SELECT status, COUNT(*)::text as count FROM ${jobs} GROUP BY status`),
  );
  const stats: Record<string, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of result) stats[row.status] = Number(row.count);
  return stats;
}
