import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { databaseMode } from "../db/client";
import { getAIProvider } from "../ai/provider";
import {
  agentRuns, approvals, contentItems, deployments, indexingSubmissions, integrations,
  jobs, keywords, monitoringChecks, projects, searchMetrics, seoAudits, auditLogs,
} from "../db/schema";
import { OAUTH_PROVIDERS } from "../integrations/oauth";

export async function getDashboardData(db: Database, workspaceId: string) {
  const workspaceFilter = eq(projects.workspaceId, workspaceId);

  const [projectStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
    })
    .from(projects)
    .where(workspaceFilter);

  const [auditStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      averageScore: sql<number | null>`round(avg(score))::int`,
    })
    .from(seoAudits)
    .innerJoin(projects, eq(seoAudits.projectId, projects.id))
    .where(workspaceFilter);

  const [keywordStats] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(keywords)
    .innerJoin(projects, eq(keywords.projectId, projects.id))
    .where(workspaceFilter);

  const [contentStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      published: sql<number>`count(*) filter (where ${contentItems.status} = 'published')::int`,
      drafts: sql<number>`count(*) filter (where ${contentItems.status} in ('draft','in_review'))::int`,
    })
    .from(contentItems)
    .innerJoin(projects, eq(contentItems.projectId, projects.id))
    .where(workspaceFilter);

  const [metricStats] = await db
    .select({
      clicks: sql<number>`coalesce(sum(clicks), 0)::int`,
      impressions: sql<number>`coalesce(sum(impressions), 0)::int`,
    })
    .from(searchMetrics)
    .innerJoin(projects, eq(searchMetrics.projectId, projects.id))
    .where(workspaceFilter);

  const [approvalStats] = await db
    .select({ pending: sql<number>`count(*) filter (where status = 'pending')::int` })
    .from(approvals)
    .where(eq(approvals.workspaceId, workspaceId));

  const jobStats = await db
    .select({ status: jobs.status, total: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.workspaceId, workspaceId))
    .groupBy(jobs.status);

  const projectList = await db
    .select()
    .from(projects)
    .where(workspaceFilter)
    .orderBy(desc(projects.updatedAt))
    .limit(12);

  const recentAudits = await db
    .select({ id: seoAudits.id, score: seoAudits.score, createdAt: seoAudits.createdAt, projectName: projects.name })
    .from(seoAudits)
    .innerJoin(projects, eq(seoAudits.projectId, projects.id))
    .where(workspaceFilter)
    .orderBy(desc(seoAudits.createdAt))
    .limit(6);

  const recentRuns = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, workspaceId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(8);

  const recentJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.workspaceId, workspaceId))
    .orderBy(desc(jobs.createdAt))
    .limit(8);

  const connected = await db
    .select({ provider: integrations.provider, status: integrations.status, displayName: integrations.displayName })
    .from(integrations)
    .where(eq(integrations.workspaceId, workspaceId));

  const [indexStats] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(indexingSubmissions)
    .innerJoin(projects, eq(indexingSubmissions.projectId, projects.id))
    .where(workspaceFilter);

  const [monitorStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      down: sql<number>`count(*) filter (where ${monitoringChecks.status} = 'down')::int`,
    })
    .from(monitoringChecks)
    .innerJoin(projects, eq(monitoringChecks.projectId, projects.id))
    .where(workspaceFilter);

  const [deployStats] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(workspaceFilter);

  const [auditLogStats] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(eq(auditLogs.workspaceId, workspaceId));

  const ai = getAIProvider();
  const jobMap: Record<string, number> = {};
  for (const row of jobStats) jobMap[row.status] = row.total;

  return {
    projects: { total: projectStats?.total ?? 0, active: projectStats?.active ?? 0 },
    audits: { total: auditStats?.total ?? 0, averageScore: auditStats?.averageScore ?? null },
    keywords: { total: keywordStats?.total ?? 0 },
    content: {
      total: contentStats?.total ?? 0,
      published: contentStats?.published ?? 0,
      inProgress: contentStats?.drafts ?? 0,
    },
    search: { clicks: metricStats?.clicks ?? 0, impressions: metricStats?.impressions ?? 0 },
    approvals: { pending: approvalStats?.pending ?? 0 },
    jobs: jobMap,
    indexing: { total: indexStats?.total ?? 0 },
    monitoring: { total: monitorStats?.total ?? 0, down: monitorStats?.down ?? 0 },
    deployments: { total: deployStats?.total ?? 0 },
    auditLogs: { total: auditLogStats?.total ?? 0 },
    projectList,
    recentAudits,
    recentRuns,
    recentJobs,
    connectedIntegrations: connected,
    configuration: {
      database: databaseMode(),
      ai: { configured: ai.name !== "none", provider: ai.name },
      providers: Object.values(OAUTH_PROVIDERS).map((p) => ({
        provider: p.provider,
        label: p.label,
        configured: p.isConfigured(),
      })),
      indexNow: Boolean(process.env.INDEXNOW_KEY && process.env.INDEXNOW_KEY_LOCATION),
    },
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;
