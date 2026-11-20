import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { metricsDelta, readPipeline } from "@/core/automation/pipeline";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const context = await requirePermission("project:read");
    const { id } = await params;
    const pipeline = await readPipeline(getDb(), context.workspaceId, id);
    if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });
    return Response.json({
      pipeline,
      delta: metricsDelta(pipeline.beforeMetrics, pipeline.afterMetrics),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
