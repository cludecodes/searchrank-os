import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects, seoAudits } from "@/core/db/schema";
import { enqueueJob } from "@/core/jobs/queue";

const schema = z.object({
  projectId: z.uuid().optional(),
  url: z.url().optional(),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const db = getDb();
    const list = await db
      .select({ audit: seoAudits, projectName: projects.name })
      .from(seoAudits)
      .innerJoin(projects, eq(seoAudits.projectId, projects.id))
      .where(eq(projects.workspaceId, context.workspaceId))
      .orderBy(desc(seoAudits.createdAt))
      .limit(50);
    return Response.json({ audits: list });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission("audit:run");
    const parsed = schema.parse(await request.json());
    const db = getDb();
    let projectId = parsed.projectId ?? null;
    let url = parsed.url ?? null;
    if (projectId) {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!rows.length || rows[0].workspaceId !== context.workspaceId) {
        return Response.json({ error: "Project not found" }, { status: 404 });
      }
      url = url ?? rows[0].productionUrl;
    }
    if (!url) return Response.json({ error: "Provide a projectId or a url." }, { status: 400 });
    const job = await enqueueJob(db, {
      type: "seo.audit",
      payload: { url },
      workspaceId: context.workspaceId,
      projectId,
      priority: "high",
      createdBy: context.user.id,
    });
    return Response.json({ jobId: job.id, status: job.status }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
