import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { contentItems, projects } from "@/core/db/schema";

const schema = z.object({
  title: z.string().min(3).max(200).optional(),
  clusterId: z.uuid().optional().nullable(),
  targetKeywordId: z.uuid().optional().nullable(),
  intent: z.enum(["informational", "navigational", "transactional", "commercial"]).optional(),
  audience: z.string().max(500).optional(),
  uniqueValueProposition: z.string().max(1000).optional(),
  proposedUrl: z.string().max(300).optional(),
  metaTitle: z.string().max(200).optional(),
  metaDescription: z.string().max(300).optional(),
  body: z.string().max(100_000).optional(),
  supportingResearch: z.array(z.string()).optional(),
  internalLinkPlan: z.array(z.string()).optional(),
  notes: z.string().max(1000).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const context = await requirePermission("project:read");
    const { id } = await params;
    const [row] = await getDb()
      .select({ item: contentItems, workspaceId: projects.workspaceId })
      .from(contentItems)
      .innerJoin(projects, eq(contentItems.projectId, projects.id))
      .where(eq(contentItems.id, id))
      .limit(1);
    if (!row || row.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Content not found" }, { status: 404 });
    }
    return Response.json({ content: row.item });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Human edits to a draft/brief. Never changes editorial status. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = await requirePermission("content:write");
    const parsed = schema.parse(await request.json());
    const { id } = await params;
    const db = getDb();
    const [row] = await db
      .select({ workspaceId: projects.workspaceId })
      .from(contentItems)
      .innerJoin(projects, eq(contentItems.projectId, projects.id))
      .where(eq(contentItems.id, id))
      .limit(1);
    if (!row || row.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Content not found" }, { status: 404 });
    }
    const updated = await db
      .update(contentItems)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(contentItems.id, id))
      .returning();
    await writeAuditLog("content.updated", context, { contentId: id, fields: Object.keys(parsed) });
    return Response.json({ content: updated[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
