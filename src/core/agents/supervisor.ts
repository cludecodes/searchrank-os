import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentRuns, approvals, auditLogs, contentItems, jobs, keywords, projects, seoAudits,
} from "../db/schema";
import { enqueueJob } from "../jobs/queue";
import type { JobPriority } from "../db/schema";

export interface PlannedJob {
  type: string;
  payload: Record<string, unknown>;
  priority: JobPriority;
  reason: string;
}

export interface ProjectPlan {
  projectId: string;
  projectName: string;
  jobs: PlannedJob[];
}

export interface AgentEvaluation {
  agentKey: string;
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  successRate: number;
  lastStatus: string;
}

export interface WorkflowPlan {
  generatedAt: string;
  lookbackDays: number;
  plans: ProjectPlan[];
  evaluations: AgentEvaluation[];
  totalPlanned: number;
}

/** Evaluates recent agent runs strictly from persisted rows. */
export async function evaluateRecentRuns(
  db: Database,
  workspaceId: string,
  cutoff: Date,
): Promise<AgentEvaluation[]> {
  const runs = await db
    .select({ agentKey: agentRuns.agentKey, status: agentRuns.status })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), gte(agentRuns.startedAt, cutoff)))
    .orderBy(desc(agentRuns.startedAt));

  const byAgent = new Map<string, AgentEvaluation>();
  for (const run of runs) {
    let entry = byAgent.get(run.agentKey);
    if (!entry) {
      entry = {
        agentKey: run.agentKey,
        runs: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        successRate: 0,
        lastStatus: run.status,
      };
      byAgent.set(run.agentKey, entry);
    }
    entry.runs++;
    if (run.status === "succeeded") entry.succeeded++;
    else if (run.status === "failed") entry.failed++;
    else if (run.status === "skipped") entry.skipped++;
  }
  for (const entry of byAgent.values()) {
    const meaningful = entry.succeeded + entry.failed;
    entry.successRate = meaningful ? Math.round((entry.succeeded / meaningful) * 100) : 0;
  }
  return [...byAgent.values()];
}

/** Builds a deterministic, evidence-driven workflow plan. No jobs are enqueued here. */
export async function buildWorkflowPlan(
  db: Database,
  workspaceId: string,
  options: { lookbackDays?: number } = {},
): Promise<WorkflowPlan> {
  const lookbackDays = options.lookbackDays ?? 7;
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000);
  const projectList = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .orderBy(desc(projects.updatedAt));

  const evaluations = await evaluateRecentRuns(db, workspaceId, cutoff);
  const plans: ProjectPlan[] = [];
  const maxPerProject = 6;

  for (const project of projectList) {
    const [lastAudit] = await db
      .select({ score: seoAudits.score, createdAt: seoAudits.createdAt })
      .from(seoAudits)
      .where(eq(seoAudits.projectId, project.id))
      .orderBy(desc(seoAudits.createdAt))
      .limit(1);

    const [keywordCount] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(keywords)
      .where(eq(keywords.projectId, project.id));

    const [contentCount] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(contentItems)
      .where(eq(contentItems.projectId, project.id));

    const [approvalCount] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending")));

    const pendingJobs = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(and(eq(jobs.projectId, project.id), eq(jobs.status, "pending")));
    const pendingTypes = new Set(pendingJobs.map((j) => j.type));

    const recentRuns = await db
      .select({ agentKey: agentRuns.agentKey })
      .from(agentRuns)
      .where(and(eq(agentRuns.projectId, project.id), gte(agentRuns.startedAt, cutoff)));
    const recentAgents = new Set(recentRuns.map((r) => r.agentKey));

    const planned: PlannedJob[] = [];
    const add = (job: PlannedJob) => {
      if (planned.length < maxPerProject && !pendingTypes.has(job.type)) planned.push(job);
    };

    const auditStale = !lastAudit || lastAudit.createdAt < cutoff;
    if (auditStale && project.productionUrl) {
      add({
        type: "seo.audit",
        payload: { url: project.productionUrl },
        priority: project.status === "active" ? "high" : "normal",
        reason: lastAudit ? "Latest audit is older than the lookback window" : "No audit has ever been executed",
      });
    }

    if ((keywordCount?.total ?? 0) === 0) {
      add({
        type: "keywords.sync",
        payload: {},
        priority: "normal",
        reason: "No keyword records stored for this project",
      });
    } else if (!recentAgents.has("CONTENT_STRATEGY_AGENT") && (contentCount?.total ?? 0) === 0) {
      add({
        type: "content.strategy",
        payload: {},
        priority: "normal",
        reason: "Keywords exist but no content briefs have been produced",
      });
    }

    if (!recentAgents.has("ANALYTICS_AGENT")) {
      add({
        type: "analytics.sync",
        payload: {},
        priority: "low",
        reason: "No analytics sync in the lookback window",
      });
    }

    if ((approvalCount?.total ?? 0) > 0) {
      add({
        type: "quality.review",
        payload: {},
        priority: "high",
        reason: `${approvalCount?.total} approval request(s) await review`,
      });
    }

    const failedRecent = recentRuns.filter((r) => r.agentKey === "TECHNICAL_SEO_AGENT");
    if (failedRecent.length === 0 && lastAudit && lastAudit.score !== null && lastAudit.score < 60) {
      add({
        type: "content.strategy",
        payload: {},
        priority: "low",
        reason: "Low technical score suggests content and structure improvements",
      });
    }

    if (planned.length) {
      plans.push({ projectId: project.id, projectName: project.name, jobs: planned });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    plans,
    evaluations,
    totalPlanned: plans.reduce((sum, p) => sum + p.jobs.length, 0),
  };
}

/** Executes a plan by persisting real jobs and an audit event. */
export async function executeWorkflowPlan(
  db: Database,
  workspaceId: string,
  actorId?: string,
  options: { lookbackDays?: number } = {},
): Promise<{ plan: WorkflowPlan; enqueued: string[] }> {
  const plan = await buildWorkflowPlan(db, workspaceId, options);
  const enqueued: string[] = [];
  for (const projectPlan of plan.plans) {
    for (const job of projectPlan.jobs) {
      const created = await enqueueJob(db, {
        type: job.type,
        payload: job.payload,
        workspaceId,
        projectId: projectPlan.projectId,
        priority: job.priority,
        createdBy: actorId ? `supervisor:${actorId}` : "supervisor",
      });
      enqueued.push(created.id);
    }
  }
  await db.insert(auditLogs).values({
    workspaceId,
    actorId: actorId ?? null,
    actorType: actorId ? "user" : "agent",
    action: "supervisor.plan_executed",
    metadata: { planned: plan.totalPlanned, enqueued: enqueued.length, lookbackDays: plan.lookbackDays },
  });
  return { plan, enqueued };
}
