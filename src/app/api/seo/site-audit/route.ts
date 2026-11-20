import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects } from "@/core/db/schema";
import { enqueueJob } from "@/core/jobs/queue";

const schema = z.object({ projectId: z.uuid() });

export async function POST(request: Request) {
  try {
    const context = await requirePermission("audit:run");
    const parsed = schema.parse(await request.json());
    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, parsed.projectId))
      .limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    const job = await enqueueJob(getDb(), {
      type: "seo.site.analysis",
      payload: { mode: "site-analysis" },
      workspaceId: context.workspaceId,
      projectId: project.id,
      createdBy: context.user.id,
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
