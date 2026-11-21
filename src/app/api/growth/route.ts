import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects } from "@/core/db/schema";
import { buildGrowthPlan, getGrowthMetrics, listOpportunities } from "@/core/growth/engine";

const schema = z.object({ projectId: z.uuid() });

export async function GET(request: Request) {
  try {
    const context = await requirePermission("project:read");
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    return Response.json({
      opportunities: await listOpportunities(db, projectId),
      metrics: await getGrowthMetrics(db, projectId),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Builds a plan from persisted evidence only. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("keyword:write");
    const parsed = schema.parse(await request.json());
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, parsed.projectId)).limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    const result = await buildGrowthPlan(db, project.id);
    await writeAuditLog("growth.plan_built", context, { projectId: project.id, created: result.created });
    return Response.json({ ...result, opportunities: await listOpportunities(db, project.id) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
