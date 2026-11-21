import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { conversions, projects } from "@/core/db/schema";
import { recordConversion } from "@/core/growth/engine";

const schema = z.object({
  projectId: z.uuid(),
  kind: z.enum(["lead", "sale", "signup", "call", "quote"]),
  count: z.number().int().positive().max(10000).optional(),
  revenue: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  qualified: z.boolean().optional(),
  sourceUrl: z.string().max(2000).optional(),
  landingPage: z.string().max(2000).optional(),
  keyword: z.string().max(500).optional(),
});

/** Records real, operator-supplied conversions. Nothing is estimated. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("project:write");
    const parsed = schema.parse(await request.json());
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, parsed.projectId)).limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    const record = await recordConversion(db, { ...parsed, submittedBy: context.user.id });
    await writeAuditLog("conversion.recorded", context, { conversionId: record.id, projectId: project.id });
    return Response.json({ conversion: record }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

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
    const rows = await db.select().from(conversions).where(eq(conversions.projectId, projectId)).limit(200);
    return Response.json({ conversions: rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
