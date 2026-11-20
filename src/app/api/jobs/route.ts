import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { jobs } from "@/core/db/schema";
import { enqueueJob } from "@/core/jobs/queue";
import { listJobHandlers } from "@/core/jobs/runner";
import { registerBuiltinHandlers } from "@/core/jobs/handlers";

const ALLOWED = new Set([
  "agent.run", "supervisor.daily", "discovery.sync", "seo.audit",
  "seo.artifacts.generate", "seo.site.analysis", "keywords.sync",
  "competitor.monitor", "content.strategy", "content.produce", "links.authority",
  "developer.propose", "indexing.submit", "search.sitemap.submit", "search.url.inspect",
  "search.bing.urls", "analytics.sync", "search.sync", "search.issues.monitor", "quality.review",
  "pipeline.advance", "pipeline.rollback",
  "monitoring.uptime", "scheduler.tick", "report.generate",
]);

const schema = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  projectId: z.uuid().optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
});

export async function GET() {
  try {
    const context = await requirePermission("project:read");
    registerBuiltinHandlers();
    const list = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.workspaceId, context.workspaceId))
      .orderBy(desc(jobs.createdAt))
      .limit(100);
    return Response.json({ jobs: list, availableHandlers: listJobHandlers() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePermission("agent:run");
    const parsed = schema.parse(await request.json());
    if (!ALLOWED.has(parsed.type)) return Response.json({ error: "Unknown job type" }, { status: 400 });
    const job = await enqueueJob(getDb(), {
      type: parsed.type,
      payload: parsed.payload ?? {},
      workspaceId: context.workspaceId,
      projectId: parsed.projectId ?? null,
      priority: parsed.priority ?? "normal",
      createdBy: context.user.id,
    });
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
