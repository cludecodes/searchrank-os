import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { readPipeline } from "@/core/automation/pipeline";
import { enqueueJob } from "@/core/jobs/queue";

const schema = z.object({ rollbackApprovalId: z.uuid().optional() });

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const context = await requirePermission("content:write");
    const { id } = await params;
    const parsed = schema.parse(await request.json());
    const pipeline = await readPipeline(getDb(), context.workspaceId, id);
    if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });

    const job = await enqueueJob(getDb(), {
      type: parsed.rollbackApprovalId ? "pipeline.rollback" : "pipeline.advance",
      payload: { pipelineId: id, approvalId: parsed.rollbackApprovalId },
      workspaceId: context.workspaceId,
      projectId: pipeline.projectId,
      createdBy: context.user.id,
      priority: "high",
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
