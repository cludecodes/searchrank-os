import { and, eq, lte, sql } from "drizzle-orm";
import { jobSchedules, projects } from "../db/schema";
import { runAgent, type AgentKey } from "../agents/framework";
import { registerAllAgents } from "../agents/definitions";
import { enqueueJob } from "./queue";
import { registerJobHandler } from "./runner";

let registered = false;

/** Registers all job handlers and the twelve agents exactly once. */
export function registerBuiltinHandlers(): void {
  if (registered) return;
  registered = true;
  registerAllAgents();

  registerJobHandler({
    type: "agent.run",
    description: "Run one AI agent with persisted run history",
    async run(ctx) {
      const agent = ctx.input.agent as AgentKey | undefined;
      if (!agent) throw new Error("agent.run requires an 'agent' in its payload");
      const result = await runAgent(ctx.db, agent, {
        workspaceId: ctx.job.workspaceId,
        projectId: ctx.job.projectId,
        jobId: ctx.job.id,
        input: ctx.input,
      });
      return { agent, runId: result.runId, summary: result.result.summary };
    },
  });

  for (const [type, agent, description] of [
    ["supervisor.daily", "CHIEF_SUPERVISOR", "Daily supervisor planning"],
    ["discovery.sync", "PROJECT_DISCOVERY_AGENT", "Sync GitHub/Vercel project registry"],
    ["seo.audit", "TECHNICAL_SEO_AGENT", "Run a live technical SEO audit"],
    ["seo.artifacts.generate", "TECHNICAL_SEO_AGENT", "Generate framework-aware SEO artifact proposals"],
    ["seo.site.analysis", "TECHNICAL_SEO_AGENT", "Detect duplicate content and orphan pages"],
    ["keywords.sync", "KEYWORD_INTELLIGENCE_AGENT", "Import real GSC keyword data"],
    ["competitor.monitor", "COMPETITOR_INTELLIGENCE_AGENT", "Analyze registered competitors"],
    ["content.strategy", "CONTENT_STRATEGY_AGENT", "Generate evidence-based content briefs"],
    ["content.produce", "CONTENT_PRODUCTION_AGENT", "Draft approved content"],
    ["links.authority", "LINK_AUTHORITY_AGENT", "Find legitimate referral candidates"],
    ["developer.propose", "DEVELOPER_AGENT", "Create approval-gated code changes"],
    ["indexing.submit", "INDEXING_AGENT", "Submit verified URLs after approval"],
    ["search.sitemap.submit", "INDEXING_AGENT", "Submit sitemap to GSC and Bing after approval"],
    ["search.url.inspect", "INDEXING_AGENT", "Inspect a URL via Google Search Console"],
    ["search.bing.urls", "INDEXING_AGENT", "Submit URLs to Bing within quota after approval"],
    ["analytics.sync", "ANALYTICS_AGENT", "Sync search performance metrics"],
    ["search.sync", "ANALYTICS_AGENT", "Sync performance from both search engines"],
    ["search.issues.monitor", "ANALYTICS_AGENT", "Monitor sitemap and crawl issues"],
    ["quality.review", "QUALITY_SECURITY_AGENT", "Review generated content and approvals"],
  ] as const) {
    registerJobHandler({
      type,
      description,
      async run(ctx) {
        const result = await runAgent(ctx.db, agent as AgentKey, {
          workspaceId: ctx.job.workspaceId,
          projectId: ctx.job.projectId,
          jobId: ctx.job.id,
          input: ctx.job.payload,
        });
        if (result.result.requiresApproval) {
          await ctx.warn("Agent requested human approval", { runId: result.runId });
        }
        return {
          agent,
          runId: result.runId,
          summary: result.result.summary,
          skippedReason: result.result.skippedReason ?? null,
          requiresApproval: result.result.requiresApproval ?? false,
        };
      },
    });
  }

  registerJobHandler({
    type: "monitoring.uptime",
    description: "Check production site availability",
    async run(ctx) {
      const { monitoringChecks } = await import("../db/schema");
      const list = ctx.job.projectId
        ? await ctx.db.select().from(projects).where(eq(projects.id, ctx.job.projectId))
        : ctx.job.workspaceId
          ? await ctx.db.select().from(projects).where(eq(projects.workspaceId, ctx.job.workspaceId))
          : [];
      let checked = 0;
      for (const project of list) {
        if (!project.productionUrl) continue;
        const started = Date.now();
        let status = "down";
        let httpStatus: number | null = null;
        try {
          const response = await fetch(project.productionUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; SearchRankOS/1.0)" },
            signal: AbortSignal.timeout(12_000),
          });
          httpStatus = response.status;
          status = response.ok ? "up" : "degraded";
        } catch {
          status = "down";
        }
        await ctx.db.insert(monitoringChecks).values({
          projectId: project.id,
          kind: "uptime",
          status,
          httpStatus,
          latencyMs: Date.now() - started,
        });
        checked++;
      }
      return { checked };
    },
  });

  registerJobHandler({
    type: "scheduler.tick",
    description: "Enqueue jobs whose schedules are due",
    async run(ctx) {
      const now = new Date();
      const due = await ctx.db
        .select()
        .from(jobSchedules)
        .where(and(eq(jobSchedules.enabled, true), lte(jobSchedules.nextRunAt, now)));
      let enqueued = 0;
      for (const schedule of due) {
        await enqueueJob(ctx.db, {
          type: schedule.jobType,
          payload: schedule.payload,
          workspaceId: schedule.workspaceId,
          createdBy: `schedule:${schedule.id}`,
        });
        await ctx.db
          .update(jobSchedules)
          .set({ lastRunAt: now, nextRunAt: nextOccurrence(schedule.frequency, now) })
          .where(eq(jobSchedules.id, schedule.id));
        enqueued++;
      }
      return { enqueued, due: due.length };
    },
  });

  registerJobHandler({
    type: "report.generate",
    description: "Generate an executive report from persisted data only",
    async run(ctx) {
      const { reports, searchMetrics, seoAudits, contentItems, jobs: jobsTable } = await import("../db/schema");
      if (!ctx.job.workspaceId) throw new Error("report.generate requires a workspaceId");
      const periodEnd = new Date().toISOString().slice(0, 10);
      const periodStart = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const metrics = await ctx.db
        .select({
          clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
          impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
        })
        .from(searchMetrics)
        .where(eq(searchMetrics.projectId, ctx.job.projectId ?? "00000000-0000-0000-0000-000000000000"));
      const created = await ctx.db
        .insert(reports)
        .values({
          workspaceId: ctx.job.workspaceId,
          projectId: ctx.job.projectId ?? null,
          type: ctx.job.projectId ? "project" : "executive",
          periodStart,
          periodEnd,
          data: {
            clicks: Number(metrics[0]?.clicks ?? 0),
            impressions: Number(metrics[0]?.impressions ?? 0),
            note: "All figures are aggregates of persisted rows; no synthetic data is added.",
          } as Record<string, unknown>,
        })
        .returning({ id: reports.id });
      void seoAudits;
      void contentItems;
      void jobsTable;
      return { reportId: created[0].id, periodStart, periodEnd };
    },
  });
}

/** Ensures agents and handlers are registered (idempotent). */
export function ensureAgents(): void {
  registerBuiltinHandlers();
}

function nextOccurrence(frequency: string, from: Date): Date {
  const date = new Date(from);
  if (frequency === "hourly") date.setHours(date.getHours() + 1);
  else if (frequency === "daily") date.setDate(date.getDate() + 1);
  else if (frequency === "weekly") date.setDate(date.getDate() + 7);
  else if (frequency === "monthly") date.setMonth(date.getMonth() + 1);
  else date.setDate(date.getDate() + 1);
  return date;
}
