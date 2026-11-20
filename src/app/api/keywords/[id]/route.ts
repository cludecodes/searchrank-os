import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { keywords, projects } from "@/core/db/schema";

const schema = z.object({
  targetUrl: z.url().optional().nullable(),
  priority: z.number().int().min(-100).max(100).optional(),
  notes: z.string().max(1000).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = await requirePermission("keyword:write");
    const parsed = schema.parse(await request.json());
    const { id } = await params;
    const db = getDb();
    const [row] = await db
      .select({ keyword: keywords, workspaceId: projects.workspaceId })
      .from(keywords)
      .innerJoin(projects, eq(keywords.projectId, projects.id))
      .where(eq(keywords.id, id))
      .limit(1);
    if (!row || row.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Keyword not found" }, { status: 404 });
    }
    const updated = await db
      .update(keywords)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(keywords.id, id))
      .returning();
    await writeAuditLog("keyword.updated", context, { keywordId: id, fields: Object.keys(parsed) });
    return Response.json({ keyword: updated[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
