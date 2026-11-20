import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { getAIProvider } from "../ai/provider";
import {
  agentRuns, approvals, auditLogs, contentItems, deployments, indexingSubmissions, jobs,
  keywords, monitoringChecks, pages, projects, searchMetrics, seoAudits,
} from "../db/schema";

const d = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

export async function getExecutiveData(db: Database, workspaceId: string) {
  const projectFilter = eq(projects.workspaceId, workspaceId);
  const projectList = await db.select().from(projects).where(projectFilter).orderBy(desc(projects.updatedAt));

  const [siteStats] = await db.select({
    total: sql<number>`count(*)::int`,
    active: sql<number>`count(*) filter (where ${projects.status} = 'active')::int`,
  }).from(projects).where(projectFilter);

  const [pageStats] = await db.select({
    indexed: sql<number>`count(*) filter (where ${pages.statusCode} = 200)::int`,
    total: sql<number>`count(*)::int`,
    orphans: sql<number>`count(*) filter (where ${pages.isOrphan})::int`,
  }).from(pages).innerJoin(projects, eq(pages.projectId, projects.id)).where(projectFilter);

  const [auditStats] = await db.select({
    count: sql<number>`count(*)::int`,
    averageScore: sql<number | null>`round(avg(${seoAudits.score}))::int`,
    latestScore: sql<number | null>`max(${seoAudits.score})::int`,
  }).from(seoAudits).innerJoin(projects, eq(seoAudits.projectId, projects.id)).where(projectFilter);

  const [searchThisWeek] = await db.select({
    clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
    impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
    position: sql<number | null>`round(avg(${searchMetrics.position})::numeric, 1)::numeric`,
  }).from(searchMetrics).innerJoin(projects, eq(searchMetrics.projectId, projects.id))
    .where(and(projectFilter, gte(searchMetrics.date, d(6)), lte(searchMetrics.date, d(0))));

  const [searchLastWeek] = await db.select({
    clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
    impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
    position: sql<number | null>`round(avg(${searchMetrics.position})::numeric, 1)::numeric`,
  }).from(searchMetrics).innerJoin(projects, eq(searchMetrics.projectId, projects.id))
    .where(and(projectFilter, gte(searchMetrics.date, d(13)), lte(searchMetrics.date, d(7))));

  const [rankingStats] = await db.select({
    top3: sql<number>`count(*) filter (where ${searchMetrics.position} <= 3)::int`,
    top10: sql<number>`count(*) filter (where ${searchMetrics.position} <= 10)::int`,
    conversions: sql<number>`coalesce(sum(${searchMetrics.conversions}), 0)::int`,
  }).from(searchMetrics).innerJoin(projects, eq(searchMetrics.projectId, projects.id)).where(projectFilter);

  const [keywordStats] = await db.select({ total: sql<number>`count(*)::int` })
    .from(keywords).innerJoin(projects, eq(keywords.projectId, projects.id)).where(projectFilter);

  const contentStats = await db.select({ status: contentItems.status, total: sql<number>`count(*)::int` })
    .from(contentItems).innerJoin(projects, eq(contentItems.projectId, projects.id))
    .where(projectFilter).groupBy(contentItems.status);

  const [issueStats] = await db.select({
    total: sql<number>`count(*)::int`,
    bad: sql<number>`count(*) filter (where ${monitoringChecks.status} != 'ok')::int`,
  }).from(monitoringChecks).innerJoin(projects, eq(monitoringChecks.projectId, projects.id)).where(projectFilter);

  const [indexStats] = await db.select({ total: sql<number>`count(*)::int` })
    .from(indexingSubmissions).innerJoin(projects, eq(indexingSubmissions.projectId, projects.id)).where(projectFilter);

  const deploymentStats = await db.select({ state: deployments.state, total: sql<number>`count(*)::int` })
    .from(deployments).innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(projectFilter).groupBy(deployments.state);

  const jobStats = await db.select({ status: jobs.status, total: sql<number>`count(*)::int` })
    .from(jobs).where(eq(jobs.workspaceId, workspaceId)).groupBy(jobs.status);

  const [approvalStats] = await db.select({ pending: sql<number>`count(*) filter (where status = 'pending')::int` })
    .from(approvals).where(eq(approvals.workspaceId, workspaceId));

  const agentStats = await db.select({
    agentKey: agentRuns.agentKey,
    status: agentRuns.status,
    total: sql<number>`count(*)::int`,
  }).from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId)).groupBy(agentRuns.agentKey, agentRuns.status);

  const activity = await db.select({
    action: auditLogs.action, createdAt: auditLogs.createdAt, targetId: auditLogs.targetId,
  }).from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId))
    .orderBy(desc(auditLogs.createdAt)).limit(12);

  const perProject = await Promise.all(projectList.map(async (project) => {
    const [audit] = await db.select({ score: seoAudits.score })
      .from(seoAudits).where(eq(seoAudits.projectId, project.id))
      .orderBy(desc(seoAudits.createdAt)).limit(1);
    const [kw] = await db.select({ total: sql<number>`count(*)::int` }).from(keywords).where(eq(keywords.projectId, project.id));
    const [metric] = await db.select({ clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int` })
      .from(searchMetrics).where(eq(searchMetrics.projectId, project.id));
    const [content] = await db.select({ total: sql<number>`count(*)::int` }).from(contentItems).where(eq(contentItems.projectId, project.id));
    const [deploy] = await db.select({ state: deployments.state })
      .from(deployments).where(eq(deployments.projectId, project.id))
      .orderBy(desc(deployments.createdAt)).limit(1);
    return {
      id: project.id,
      name: project.name,
      domain: project.domain,
      status: project.status,
      auditScore: audit?.score ?? null,
      keywords: Number(kw?.total ?? 0),
      clicks: Number(metric?.clicks ?? 0),
      content: Number(content?.total ?? 0),
      deployment: deploy?.state ?? null,
    };
  }));

  const ai = getAIProvider();
  const clicks = Number(searchThisWeek?.clicks ?? 0);
  const previousClicks = Number(searchLastWeek?.clicks ?? 0);
  const impressions = Number(searchThisWeek?.impressions ?? 0);
  const previousImpressions = Number(searchLastWeek?.impressions ?? 0);
  const pct = (current: number, previous: number) =>
    previous === 0 ? null : Math.round(((current - previous) / previous) * 100);

  return {
    generatedAt: new Date().toISOString(),
    sites: { total: Number(siteStats?.total ?? 0), active: Number(siteStats?.active ?? 0) },
    pages: {
      indexed: Number(pageStats?.indexed ?? 0),
      total: Number(pageStats?.total ?? 0),
      orphans: Number(pageStats?.orphans ?? 0),
    },
    audits: {
      count: Number(auditStats?.count ?? 0),
      averageScore: auditStats?.averageScore ?? null,
    },
    search: {
      clicks,
      impressions,
      ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      averagePosition: searchThisWeek?.position ? Number(searchThisWeek.position) : null,
      clicksChangePct: pct(clicks, previousClicks),
      impressionsChangePct: pct(impressions, previousImpressions),
      top3: Number(rankingStats?.top3 ?? 0),
      top10: Number(rankingStats?.top10 ?? 0),
      conversions: Number(rankingStats?.conversions ?? 0),
    },
    keywords: { total: Number(keywordStats?.total ?? 0) },
    content: contentStats.map((row) => ({ status: row.status, total: Number(row.total) })),
    indexing: {
      submissions: Number(indexStats?.total ?? 0),
      checks: Number(issueStats?.total ?? 0),
      issues: Number(issueStats?.bad ?? 0),
    },
    deployments: deploymentStats.map((row) => ({ state: row.state, total: Number(row.total) })),
    jobs: jobStats.map((row) => ({ status: row.status, total: Number(row.total) })),
    approvals: { pending: Number(approvalStats?.pending ?? 0) },
    agents: agentStats.map((row) => ({ agentKey: row.agentKey, status: row.status, total: Number(row.total) })),
    activity,
    perProject,
    ai: { name: ai.name, configured: ai.name !== "none" },
  };
}

export type ExecutiveData = Awaited<ReturnType<typeof getExecutiveData>>;
