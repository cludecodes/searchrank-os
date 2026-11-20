import { cookies } from "next/headers";
import { getRequestContext, apiErrorResponse } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { revokeSession } from "@/core/security/sessions";

const COOKIE = process.env.SESSION_COOKIE_NAME || "sr_session";

export async function POST() {
  try {
    const token = (await cookies()).get(COOKIE)?.value;
    if (token) await revokeSession(getDb(), token);
    void getRequestContext;
    const response = Response.json({ ok: true });
    response.headers.append("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
