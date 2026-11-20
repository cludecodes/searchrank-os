import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { AGENT_KEYS, listAgents } from "@/core/agents/framework";
import { registerBuiltinHandlers } from "@/core/jobs/handlers";
import { enqueueJob } from "@/core/jobs/queue";
import { getDb } from "@/core/db/client";

const schema = z.object({
  agent: z.enum(AGENT_KEYS),
  projectId: z.uuid().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export async function GET() {
  try {
    await requirePermission("project:read");
    registerBuiltinHandlers();
    return Response.json({
      agents: listAgents().map((a) => ({
        key: a.key,
        name: a.name,
        mission: a.mission,
        responsibilities: a.responsibilities,
        toolsets: a.toolsets,
        canMutateProduction: a.canMutateProduction,
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission("agent:run");
    registerBuiltinHandlers();
    const parsed = schema.parse(await request.json());
    const job = await enqueueJob(getDb(), {
      type: "agent.run",
      payload: { agent: parsed.agent, ...(parsed.input ?? {}) },
      workspaceId: context.workspaceId,
      projectId: parsed.projectId ?? null,
      priority: "normal",
      createdBy: context.user.id,
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
