import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { rateLimits } from "../db/schema";

export interface RateLimitResult {
  allowed: boolean;
  hits: number;
  limit: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * Durable sliding-window rate limiter backed by Postgres. Each (bucket,
 * subject) has one row per fixed window; concurrent increments are atomic.
 */
export async function checkRateLimit(
  db: Database,
  bucket: string,
  subject: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);

  const rows = await db
    .insert(rateLimits)
    .values({ bucket, subject, windowStart, hits: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.bucket, rateLimits.subject, rateLimits.windowStart],
      set: { hits: sql`${rateLimits.hits} + 1` },
    })
    .returning({ hits: rateLimits.hits });

  const hits = rows[0]?.hits ?? 1;
  return {
    allowed: hits <= limit,
    hits,
    limit,
    resetAt,
    retryAfterSeconds: Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
  };
}

export async function pruneRateLimits(db: Database, olderThanMs = 86_400_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = await db
    .delete(rateLimits)
    .where(sql`${rateLimits.windowStart} < ${cutoff.toISOString()}::timestamptz`)
    .returning({ id: rateLimits.id });
  return stale.length;
}
