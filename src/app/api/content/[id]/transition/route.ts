import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { contentItems, projects, type ContentStatus } from "@/core/db/schema";
import { canTransition, validateContentItem } from "@/core/content/workflow";

const schema = z.object({
  action: z.enum(["draft", "submit", "approve", "reject", "publish", "revert"]),
  note: z.string().max(1000).optional(),
});

const ACTION_TARGET: Record<z.infer<typeof schema>["action"], ContentStatus> = {
  draft: "draft",
  submit: "in_review",
  approve: "approved",
  reject: "rejected",
  publish: "published",
  revert: "draft",
};

type Params = { params: Promise<{ id: string }> };

/** Editorial state machine. High-risk transitions require approval permission. */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await requirePermission("content:write");
    const parsed = schema.parse(await request.json());
    if ((parsed.action === "approve" || parsed.action === "publish") && context.role !== "OWNER" && context.role !== "ADMIN") {
      return Response.json({ error: "Only admins can approve or publish content." }, { status: 403 });
    }
    const { id } = await params;
    const db = getDb();
    const [row] = await db
      .select({ item: contentItems, workspaceId: projects.workspaceId })
      .from(contentItems)
      .innerJoin(projects, eq(contentItems.projectId, projects.id))
      .where(eq(contentItems.id, id))
      .limit(1);
    if (!row || row.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Content not found" }, { status: 404 });
    }

    const from = row.item.status;
    const to = ACTION_TARGET[parsed.action];
    if (!canTransition(from, to)) {
      return Response.json({ error: `Cannot transition ${from} → ${to}` }, { status: 409 });
    }
    if (to === "in_review" || to === "approved" || to === "published") {
      const missing = validateContentItem({
        ...row.item,
        status: to,
      });
      if (missing.length) {
        return Response.json({ error: `Missing required fields: ${missing.join(", ")}` }, { status: 422 });
      }
    }

    const updated = await db
      .update(contentItems)
      .set({
        status: to,
        approvedBy: to === "approved" || to === "published" ? context.user.id : row.item.approvedBy,
        publishedAt: to === "published" ? new Date() : row.item.publishedAt,
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, id))
      .returning();
    await writeAuditLog("content.transition", context, {
      contentId: id,
      from,
      to,
      note: parsed.note ?? null,
    });
    return Response.json({ content: updated[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
