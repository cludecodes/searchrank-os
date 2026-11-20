import { desc, eq } from "drizzle-orm";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { reports } from "@/core/db/schema";
import { enqueueJob } from "@/core/jobs/queue";

export async function GET() {
  try {
    const context = await requirePermission("report:read");
    const list = await getDb()
      .select()
      .from(reports)
      .where(eq(reports.workspaceId, context.workspaceId))
      .orderBy(desc(reports.periodEnd))
      .limit(50);
    return Response.json({ reports: list });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST() {
  try {
    const context = await requirePermission("report:read");
    const job = await enqueueJob(getDb(), {
      type: "report.generate",
      workspaceId: context.workspaceId,
      createdBy: context.user.id,
      priority: "low",
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
