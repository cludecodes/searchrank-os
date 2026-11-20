import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/core/db/client";
import { users, workspaceMembers, workspaces } from "@/core/db/schema";
import { hashPassword } from "@/core/security/password";
import { checkRateLimit } from "@/core/security/rate-limit";
import { createSession } from "@/core/security/sessions";
import { apiErrorResponse, requestMeta } from "@/core/auth/request";

const bodySchema = z.object({
  email: z.email(),
  password: z.string().min(12, "Use at least 12 characters."),
  name: z.string().min(2).max(120).optional(),
  workspaceName: z.string().min(2).max(120).optional(),
});
const COOKIE = process.env.SESSION_COOKIE_NAME || "sr_session";

export async function POST(request: Request) {
  try {
    const parsed = bodySchema.parse(await request.json());
    const db = getDb();
    const meta = await requestMeta();
    const subject = meta.ipAddress ?? parsed.email;
    const limit = await checkRateLimit(db, "register", subject, 5, 60 * 60_000);
    if (!limit.allowed) return Response.json({ error: "Too many registration attempts." }, { status: 429 });

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    const allowSignups = process.env.ALLOW_SIGNUPS === "true";
    if (count > 0 && !allowSignups) {
      return Response.json({ error: "Registration is closed. Ask an administrator for an account." }, { status: 403 });
    }

    const email = parsed.email.toLowerCase();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return Response.json({ error: "An account with that email already exists." }, { status: 409 });

    const created = await db
      .insert(users)
      .values({
        email,
        name: parsed.name ?? email.split("@")[0],
        passwordHash: await hashPassword(parsed.password),
        globalRole: count === 0 ? "SUPERADMIN" : "USER",
      })
      .returning();
    const slug = `${email.split("@")[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now().toString(36)}`;
    const workspace = await db
      .insert(workspaces)
      .values({ name: parsed.workspaceName ?? "My Workspace", slug, ownerId: created[0].id })
      .returning();
    await db.insert(workspaceMembers).values({ workspaceId: workspace[0].id, userId: created[0].id, role: "OWNER" });

    const { token, expiresAt } = await createSession(db, created[0].id, meta);
    const response = Response.json({ ok: true, userId: created[0].id, workspaceId: workspace[0].id }, { status: 201 });
    response.headers.append(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
