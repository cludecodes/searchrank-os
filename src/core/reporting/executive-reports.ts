import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvals, contentItems, conversions, jobs, monitoringChecks, projects,
  reports, searchMetrics, seoAudits,
} from "../db/schema";

export interface ExecutiveReport {
  periodStart: string;
  periodEnd: string;
  workCompleted: Record<string, number>;
  issuesDiscovered: Record<string, number>;
  issuesResolved: Record<string, number>;
  movements: {
    clicks: number;
    previousClicks: number;
    clicksChangePct: number | null;
    impressions: number;
    previousImpressions: number;
    top3: number;
    top10: number;
  };
  conversions: { leads: number; qualified: number; revenue: number };
  nextActions: string[];
  note: string;
}

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000);
const iso = (date: Date) => date.toISOString().slice(0, 10);

/** Builds a report strictly from persisted rows in the given window. */
export async function buildExecutiveReport(
  db: Database,
  workspaceId: string,
  options: { days?: number } = {},
): Promise<ExecutiveReport> {
  const days = options.days ?? 7;
  const periodEnd = iso(day(0));
  const periodStart = iso(day(days - 1));
  const previousStart = iso(day(days * 2 - 1));
  const previousEnd = iso(day(days));

  const countInWindow = async (table: typeof jobs, dateColumn: typeof jobs.createdAt) => {
    const [row] = await db.select({ value: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), gte(dateColumn, day(days)), lte(dateColumn, day(0))));
    return Number(row?.value ?? 0);
  };

  const [succeeded] = await db.select({ value: sql<number>`count(*) filter (where ${jobs.status} = 'succeeded')::int` })
    .from(jobs).where(and(eq(jobs.workspaceId, workspaceId), gte(jobs.createdAt, day(days))));
  const [failed] = await db.select({ value: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int` })
    .from(jobs).where(and(eq(jobs.workspaceId, workspaceId), gte(jobs.createdAt, day(days))));
  const audits = await db.select({ value: sql<number>`count(*)::int`, score: seoAudits.score })
    .from(seoAudits).innerJoin(projects, eq(seoAudits.projectId, projects.id))
    .where(and(eq(projects.workspaceId, workspaceId), gte(seoAudits.createdAt, day(days))))
    .groupBy(seoAudits.score);
  const published = await db.select({ value: sql<number>`count(*)::int` })
    .from(contentItems).innerJoin(projects, eq(contentItems.projectId, projects.id))
    .where(and(eq(projects.workspaceId, workspaceId), gte(contentItems.publishedAt, day(days))));
  const issues = await db.select({ status: monitoringChecks.status, value: sql<number>`count(*)::int` })
    .from(monitoringChecks).innerJoin(projects, eq(monitoringChecks.projectId, projects.id))
    .where(and(eq(projects.workspaceId, workspaceId), gte(monitoringChecks.checkedAt, day(days))))
    .groupBy(monitoringChecks.status);

  const metricsForWindow = async (start: string, end: string) => {
    const [row] = await db.select({
      clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
      top3: sql<number>`count(*) filter (where ${searchMetrics.position} <= 3)::int`,
      top10: sql<number>`count(*) filter (where ${searchMetrics.position} <= 10)::int`,
    }).from(searchMetrics).innerJoin(projects, eq(searchMetrics.projectId, projects.id))
      .where(and(eq(projects.workspaceId, workspaceId), gte(searchMetrics.date, start), lte(searchMetrics.date, end)));
    return {
      clicks: Number(row?.clicks ?? 0),
      impressions: Number(row?.impressions ?? 0),
      top3: Number(row?.top3 ?? 0),
      top10: Number(row?.top10 ?? 0),
    };
  };
  const current = await metricsForWindow(periodStart, periodEnd);
  const previous = await metricsForWindow(previousStart, previousEnd);
  const pct = (a: number, b: number) => b === 0 ? null : Math.round(((a - b) / b) * 100);

  const [conv] = await db.select({
    leads: sql<number>`count(*) filter (where ${conversions.kind} = 'lead')::int`,
    qualified: sql<number>`count(*) filter (where ${conversions.qualified})::int`,
    revenue: sql<number>`coalesce(sum(${conversions.revenue}), 0)::int`,
  }).from(conversions).innerJoin(projects, eq(conversions.projectId, projects.id))
    .where(and(eq(projects.workspaceId, workspaceId), gte(conversions.recordedAt, day(days))));

  const [pending] = await db.select({ value: sql<number>`count(*)::int` })
    .from(approvals).where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending")));
  const [jobsPending] = await db.select({ value: sql<number>`count(*)::int` })
    .from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "pending")));

  const nextActions: string[] = [];
  if (Number(pending?.value ?? 0) > 0) nextActions.push(`Review ${pending.value} pending approval request(s).`);
  if (Number(failed?.value ?? 0) > 0) nextActions.push(`Investigate ${failed.value} failed job(s).`);
  if ((issues.find((i) => i.status !== "ok")?.value ?? 0) > 0) nextActions.push("Resolve monitoring issues discovered this period.");
  if (current.top3 === 0) nextActions.push("Build on real keyword data to create top-3 ranking opportunities.");
  if (!nextActions.length) nextActions.push("Continue scheduled audits and search-performance synchronization.");

  return {
    periodStart,
    periodEnd,
    workCompleted: {
      jobsSucceeded: Number(succeeded?.value ?? 0),
      audits: audits.reduce((sum, a) => sum + Number(a.value), 0),
      contentPublished: Number(published[0]?.value ?? 0),
    },
    issuesDiscovered: {
      jobsFailed: Number(failed?.value ?? 0),
      monitoringIssues: issues.filter((i) => i.status !== "ok").reduce((sum, i) => sum + Number(i.value), 0),
    },
    issuesResolved: {
      jobsSucceeded: Number(succeeded?.value ?? 0),
    },
    movements: {
      clicks: current.clicks,
      previousClicks: previous.clicks,
      clicksChangePct: pct(current.clicks, previous.clicks),
      impressions: current.impressions,
      previousImpressions: previous.impressions,
      top3: current.top3,
      top10: current.top10,
    },
    conversions: {
      leads: Number(conv?.leads ?? 0),
      qualified: Number(conv?.qualified ?? 0),
      revenue: Number(conv?.revenue ?? 0),
    },
    nextActions,
    note: "All figures are aggregates of persisted rows. No rankings, traffic or revenue are fabricated.",
  };
}

/** Persists a report from real data. */
export async function generateAndStoreReport(
  db: Database,
  workspaceId: string,
  options: { days?: number; type?: string } = {},
) {
  const report = await buildExecutiveReport(db, workspaceId, options);
  const created = await db.insert(reports).values({
    workspaceId,
    projectId: null,
    type: options.type ?? "executive",
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    data: report as unknown as Record<string, unknown>,
  }).returning({ id: reports.id });
  return { id: created[0].id, report };
}

