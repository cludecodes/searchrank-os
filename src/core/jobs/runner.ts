import type { Database } from "../db/client";
import type { Job } from "../db/schema";
import { appendJobLog, claimJobs, completeJob, failJob, recoverStaleJobs, type EnqueueJobInput } from "./queue";
import { enqueueJob } from "./queue";

export interface JobContext {
  db: Database;
  job: Job;
  input: Record<string, unknown>;
  log: (message: string, metadata?: Record<string, unknown>) => Promise<void>;
  warn: (message: string, metadata?: Record<string, unknown>) => Promise<void>;
  /** Enqueue a follow-up job as part of this job's workflow. */
  enqueue: (input: EnqueueJobInput) => Promise<Job>;
}

export type JobResult = Record<string, unknown>;

export interface JobHandler {
  type: string;
  description: string;
  run: (ctx: JobContext) => Promise<JobResult>;
}

const registry = new Map<string, JobHandler>();

export function registerJobHandler(handler: JobHandler): void {
  if (registry.has(handler.type)) {
    throw new Error(`Duplicate job handler: ${handler.type}`);
  }
  registry.set(handler.type, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return registry.get(type);
}

export function listJobHandlers(): Array<{ type: string; description: string }> {
  return [...registry.values()].map(({ type, description }) => ({ type, description }));
}

export interface ProcessResult {
  jobId: string;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
}

export async function processJob(db: Database, job: Job): Promise<ProcessResult> {
  const handler = registry.get(job.type);
  const log = (message: string, metadata: Record<string, unknown> = {}) =>
    appendJobLog(db, job.id, "info", message, metadata);
  const warn = (message: string, metadata: Record<string, unknown> = {}) =>
    appendJobLog(db, job.id, "warn", message, metadata);

  if (!handler) {
    const error = `No handler registered for job type "${job.type}"`;
    await appendJobLog(db, job.id, "error", error);
    const outcome = await failJob(db, job, error);
    return { jobId: job.id, status: "failed", error: outcome.willRetry ? error : `${error} (terminal)` };
  }

  try {
    await log(`Starting ${job.type}`);
    const result = await handler.run({
      db,
      job,
      input: job.payload,
      log,
      warn,
      enqueue: (input) =>
        enqueueJob(db, {
          ...input,
          workspaceId: input.workspaceId ?? job.workspaceId,
          projectId: input.projectId ?? job.projectId,
          createdBy: input.createdBy ?? `job:${job.id}`,
        }),
    });
    await completeJob(db, job.id, result ?? {});
    await log(`Completed ${job.type}`, { keys: Object.keys(result ?? {}) });
    return { jobId: job.id, status: "succeeded" };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await appendJobLog(db, job.id, "error", message, { stack: error instanceof Error ? error.stack : undefined });
    const outcome = await failJob(db, job, message);
    await warn(outcome.willRetry ? `Retry scheduled at ${outcome.retryAt?.toISOString()}` : "Job exhausted retries");
    return { jobId: job.id, status: "failed", error: message };
  }
}

export interface WorkerOptions {
  workerId: string;
  concurrency: number;
  pollMs: number;
  staleAfterMs?: number;
  signal?: AbortSignal;
}

/** Processes currently due jobs once. Safe to call from cron or tests. */
export async function runDueJobsOnce(db: Database, options: WorkerOptions): Promise<ProcessResult[]> {
  await recoverStaleJobs(db, options.staleAfterMs ?? 120_000);
  const claimed = await claimJobs(db, options.workerId, options.concurrency);
  const results: ProcessResult[] = [];
  for (const job of claimed) results.push(await processJob(db, job));
  return results;
}

/** Long-running worker loop with graceful shutdown. */
export async function startWorker(db: Database, options: WorkerOptions): Promise<() => void> {
  let busy = false;
  let stopped = false;
  const controller = new AbortController();
  if (options.signal) options.signal.addEventListener("abort", () => controller.abort(), { once: true });

  const tick = async () => {
    if (busy || stopped || controller.signal.aborted) return;
    busy = true;
    try {
      const results = await runDueJobsOnce(db, options);
      for (const result of results) {
        if (result.status === "failed") {
          console.error(`[worker:${options.workerId}] job ${result.jobId} failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error(`[worker:${options.workerId}] poll error:`, error);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, options.pollMs);
  void tick();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    controller.abort();
  };
  return stop;
}
