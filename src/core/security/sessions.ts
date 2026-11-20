import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions, users, type User } from "../db/schema";
import { hashToken, randomToken } from "./crypto";

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 168);

export interface SessionMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Creates a session and returns the raw token (never stored in plaintext). */
export async function createSession(
  db: Database,
  userId: string,
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { token, expiresAt };
}

/** Resolves a valid, unexpired, unrevoked session to its user. */
export async function getSessionUser(
  db: Database,
  token: string,
): Promise<{ user: User; sessionId: string } | null> {
  const rows = await db
    .select({ user: users, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        isNull(sessions.revokedAt),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessionsForUser(db: Database, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function deleteExpiredSessions(db: Database): Promise<number> {
  const expired = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return expired.length;
}
