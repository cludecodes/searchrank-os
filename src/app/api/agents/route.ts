import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { AGENT_KEYS, listAgents } from "@/core/agents/framework";
import { evaluateRecentRuns } from "@/core/agents/supervisor";
import { registerBuiltinHandlers } from "@/core/jobs/handlers";
import { enqueueJob } from "@/core/jobs/queue";
import { getDb } from "@/core/db/client";
import { agentRuns, approvals } from "@/core/db/schema";

const schema = z.object({
  agent: z.enum(AGENT_KEYS),
  projectId: z.uuid().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    registerBuiltinHandlers();
    const db = getDb();
    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workspaceId, context.workspaceId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(60);
    const pending = await db
      .select()
      .from(approvals)
      .where(eq(approvals.workspaceId, context.workspaceId))
      .orderBy(desc(approvals.createdAt))
      .limit(30);
    const evaluations = await evaluateRecentRuns(db, context.workspaceId, new Date(Date.now() - 30 * 86_400_000));
    return Response.json({
      agents: listAgents().map((a) => ({
        key: a.key,
        name: a.name,
        mission: a.mission,
        responsibilities: a.responsibilities,
        toolsets: a.toolsets,
        canMutateProduction: a.canMutateProduction,
        evaluation: evaluations.find((e) => e.agentKey === a.key) ?? null,
      })),
      runs,
      approvals: pending,
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
