import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { contentItems, projects } from "@/core/db/schema";
import { classifyIntent } from "@/core/keywords/intelligence";

const schema = z.object({
  projectId: z.uuid(),
  title: z.string().min(3).max(200),
  keyword: z.string().min(2).max(200).optional(),
  proposedUrl: z.string().max(300).optional(),
  intent: z.enum(["informational", "navigational", "transactional", "commercial"]).optional(),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const rows = await getDb()
      .select({ item: contentItems, projectName: projects.name })
      .from(contentItems)
      .innerJoin(projects, eq(contentItems.projectId, projects.id))
      .where(eq(projects.workspaceId, context.workspaceId))
      .orderBy(desc(contentItems.updatedAt))
      .limit(300);
    return Response.json({ content: rows });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Creates an editorial idea. No article text is generated here. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("content:write");
    const parsed = schema.parse(await request.json());
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, parsed.projectId)).limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    const created = await db
      .insert(contentItems)
      .values({
        projectId: project.id,
        title: parsed.title,
        proposedUrl: parsed.proposedUrl ?? null,
        intent: parsed.intent ?? (parsed.keyword ? classifyIntent(parsed.keyword) : "informational"),
        status: "idea",
        createdByAgent: "manual",
      })
      .returning();
    await writeAuditLog("content.created", context, { contentId: created[0].id });
    return Response.json({ content: created[0] }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
