import { apiErrorResponse, requirePermission, writeAuditLog } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { buildWorkflowPlan, executeWorkflowPlan } from "@/core/agents/supervisor";

/** Read-only preview of the supervisor's evidence-driven plan. */
export async function GET() {
  try {
    const context = await requirePermission("project:read");
    const plan = await buildWorkflowPlan(getDb(), context.workspaceId);
    return Response.json({ plan });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Executes the plan by persisting real jobs and an audit event. */
export async function POST() {
  try {
    const context = await requirePermission("agent:run");
    const { plan, enqueued } = await executeWorkflowPlan(getDb(), context.workspaceId, context.user.id);
    await writeAuditLog("supervisor.plan_requested", context, { planned: plan.totalPlanned, enqueued: enqueued.length });
    return Response.json({ enqueued, plan }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
