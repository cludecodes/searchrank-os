import { apiErrorResponse } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { enqueueJob } from "@/core/jobs/queue";
import { registerBuiltinHandlers } from "@/core/jobs/handlers";
import { safeEqual } from "@/core/security/crypto";

/** Vercel Cron entry point. Requires CRON_SECRET; never enqueues from anonymous requests. */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
    const authorization = request.headers.get("authorization") ?? "";
    if (!safeEqual(authorization, `Bearer ${secret}`)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    registerBuiltinHandlers();
    const job = await enqueueJob(getDb(), {
      type: "scheduler.tick",
      payload: {},
      createdBy: "vercel-cron",
      priority: "high",
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
