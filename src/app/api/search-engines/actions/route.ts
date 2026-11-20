import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiErrorResponse, requirePermission } from "@/core/auth/request";
import { getDb } from "@/core/db/client";
import { projects } from "@/core/db/schema";
import { enqueueJob } from "@/core/jobs/queue";

const schema = z.object({
  projectId: z.uuid(),
  action: z.enum(["sync", "monitor", "inspect", "submit-sitemap", "submit-bing-urls"]),
  url: z.string().max(2000).optional(),
  sitemapUrl: z.string().max(2000).optional(),
  approvalId: z.uuid().optional(),
  urls: z.array(z.string().max(2000)).max(500).optional(),
});

const JOB_FOR_ACTION: Record<z.infer<typeof schema>["action"], string> = {
  sync: "search.sync",
  monitor: "search.issues.monitor",
  inspect: "search.url.inspect",
  "submit-sitemap": "search.sitemap.submit",
  "submit-bing-urls": "search.bing.urls",
};

/** All actions are enqueued; write actions still require an approval id. */
export async function POST(request: Request) {
  try {
    const context = await requirePermission("project:read");
    const parsed = schema.parse(await request.json());
    const [project] = await getDb().select().from(projects).where(eq(projects.id, parsed.projectId)).limit(1);
    if (!project || project.workspaceId !== context.workspaceId) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    if ((parsed.action === "submit-sitemap" || parsed.action === "submit-bing-urls") && !parsed.approvalId) {
      return Response.json({ error: "An approved request is required for submissions. Run the agent once to request approval." }, { status: 403 });
    }
    const payload: Record<string, unknown> = { mode: parsed.action === "sync" ? "sync-both" : parsed.action === "monitor" ? "monitor-issues" : parsed.action };
    if (parsed.url) payload.url = parsed.url;
    if (parsed.sitemapUrl) payload.sitemapUrl = parsed.sitemapUrl;
    if (parsed.approvalId) payload.approvalId = parsed.approvalId;
    if (parsed.urls) payload.urls = parsed.urls;

    const job = await enqueueJob(getDb(), {
      type: JOB_FOR_ACTION[parsed.action],
      payload,
      workspaceId: context.workspaceId,
      projectId: project.id,
      createdBy: context.user.id,
      priority: parsed.action === "inspect" ? "high" : "normal",
    });
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
