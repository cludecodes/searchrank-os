import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { createPipeline, listPipelines } from "@/core/automation/pipeline";

const schema = z.object({
  projectId: z.uuid(),
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  changes: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().max(200_000) })).min(1).max(50),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    return Response.json({ pipelines: await listPipelines(getDb(), context.workspaceId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Creates a proposal + approval request. It never touches a repository. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("content:write");
    const parsed = schema.parse(await request.json());
    const { pipeline, approvalId } = await createPipeline(getDb(), {
      ...parsed,
      workspaceId: context.workspaceId,
      createdBy: context.user.id,
    });
    return Response.json({ pipeline, approvalId }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
