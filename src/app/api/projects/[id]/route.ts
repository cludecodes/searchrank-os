import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects } from "@/core/db/schema";

const updateSchema = z.object({
  name: z.string().min(2).max(160).optional(),
  status: z.enum(["discovered", "active", "archived", "error"]).optional(),
  productionUrl: z.url().optional().nullable(),
  seoConfig: z.record(z.string(), z.unknown()).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const context = await requirePermission("project:read");
    const { id } = await params;
    const rows = await getDb()
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.workspaceId, context.workspaceId)))
      .limit(1);
    if (!rows.length) return Response.json({ error: "Project not found" }, { status: 404 });
    return Response.json({ project: rows[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const context = await requirePermission("project:write");
    const { id } = await params;
    const db = getDb();
    const removed = await db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.workspaceId, context.workspaceId)))
      .returning({ id: projects.id });
    if (!removed.length) return Response.json({ error: "Project not found" }, { status: 404 });
    await writeAuditLog("project.deleted", context, { projectId: id });
    return Response.json({ ok: true, id });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = await requirePermission("project:write");
    const parsed = updateSchema.parse(await request.json());
    const { id } = await params;
    const updated = await getDb()
      .update(projects)
      .set({ ...parsed, updatedAt: new Date() })
      .where(and(eq(projects.id, id), eq(projects.workspaceId, context.workspaceId)))
      .returning();
    if (!updated.length) return Response.json({ error: "Project not found" }, { status: 404 });
    await writeAuditLog("project.updated", context, { projectId: id, fields: Object.keys(parsed) });
    return Response.json({ project: updated[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
