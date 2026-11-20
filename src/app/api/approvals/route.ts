import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { approvals } from "@/core/db/schema";

const schema = z.object({
  approvalId: z.uuid(),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const list = await getDb()
      .select()
      .from(approvals)
      .where(eq(approvals.workspaceId, context.workspaceId))
      .orderBy(desc(approvals.createdAt))
      .limit(100);
    return Response.json({ approvals: list });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission("approval:decide");
    const parsed = schema.parse(await request.json());
    const db = getDb();
    const updated = await db
      .update(approvals)
      .set({
        status: parsed.decision === "approve" ? "approved" : "rejected",
        decidedBy: context.user.id,
        decidedAt: new Date(),
        decisionNote: parsed.note ?? null,
      })
      .where(eq(approvals.id, parsed.approvalId))
      .returning();
    if (!updated.length) return Response.json({ error: "Approval not found" }, { status: 404 });
    await writeAuditLog("approval.decided", context, {
      approvalId: parsed.approvalId,
      decision: parsed.decision,
    });
    return Response.json({ approval: updated[0] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
