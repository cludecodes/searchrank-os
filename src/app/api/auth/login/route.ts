import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { verifyPassword } from "@/core/security/password";
import { checkRateLimit } from "@/core/security/rate-limit";
import { createSession } from "@/core/security/sessions";
import { apiErrorResponse, requestMeta, writeAuditLog } from "@/core/auth/request";

const bodySchema = z.object({ email: z.email(), password: z.string().min(1) });
const COOKIE = process.env.SESSION_COOKIE_NAME || "sr_session";

export async function POST(request: Request) {
  try {
    const parsed = bodySchema.parse(await request.json());
    const db = getDb();
    const meta = await requestMeta();
    const subject = meta.ipAddress ?? parsed.email;
    const limit = await checkRateLimit(db, "login", subject, 10, 15 * 60_000);
    if (!limit.allowed) {
      return Response.json({ error: "Too many login attempts. Try again later." }, { status: 429 });
    }

    const record = await db.select().from(users).where(eq(users.email, parsed.email.toLowerCase())).limit(1);
    const user = record[0];
    const valid = user ? await verifyPassword(parsed.password, user.passwordHash) : false;
    if (!user || !valid || !user.isActive) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const { token, expiresAt } = await createSession(db, user.id, meta);
    await writeAuditLog("auth.login", { workspaceId: null, user }, { email: user.email });

    const response = Response.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
    response.headers.append(
      "Set-Cookie",
      `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
