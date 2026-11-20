import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvals, auditLogs, codePipelines, deployments, projects, searchMetrics, seoAudits,
  type CodePipeline,
} from "../db/schema";
import { getDecryptedTokens } from "../integrations/credentials";
import { GitHubClient } from "../integrations/github";
import { VercelClient } from "../integrations/vercel";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export type CheckRunner = (input: {
  owner: string;
  repo: string;
  sha: string;
  branch: string;
}) => Promise<CheckResult[]>;

/** Default check runner reads real GitHub check-run conclusions for the head commit. */
export const githubCheckRunner: CheckRunner = async ({ owner, repo, sha }) => {
  const tokens = globalThis.__searchrankAutomationGithub;
  if (!tokens) return [{ name: "github-checks", passed: false, detail: "GitHub is not connected" }];
  const client = new GitHubClient({ accessToken: tokens });
  const runs = await client.listCheckRuns(owner, repo, sha);
  if (!runs.length) return [{ name: "github-checks", passed: false, detail: "No check runs reported for this commit" }];
  return runs.map((run) => ({
    name: run.name,
    passed: run.status === "completed" && run.conclusion === "success",
    detail: `${run.status}/${run.conclusion ?? "pending"}`,
  }));
};

declare global {
  // eslint-disable-next-line no-var
  var __searchrankAutomationGithub: string | undefined;
}

function step(list: CodePipeline["steps"], name: string, status: string, detail: string) {
  return [...list, { name, status, detail, at: new Date().toISOString() }];
}

async function log(db: Database, pipeline: CodePipeline, action: string, detail: Record<string, unknown>) {
  await db.insert(auditLogs).values({
    workspaceId: pipeline.workspaceId,
    actorType: "agent",
    action,
    targetType: "code_pipeline",
    targetId: pipeline.id,
    metadata: detail,
  });
}

async function metricsFor(db: Database, projectId: string) {
  const [audit] = await db.select({ score: seoAudits.score })
    .from(seoAudits).where(eq(seoAudits.projectId, projectId))
    .orderBy(desc(seoAudits.createdAt)).limit(1);
  const [metrics] = await db.select({
    clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
    impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
  }).from(searchMetrics).where(eq(searchMetrics.projectId, projectId));
  return {
    auditScore: audit?.score ?? null,
    clicks: Number(metrics?.clicks ?? 0),
    impressions: Number(metrics?.impressions ?? 0),
  };
}

async function githubFor(db: Database, workspaceId: string) {
  const tokens = await getDecryptedTokens(db, workspaceId, "github");
  if (!tokens) throw new Error("GitHub is not connected");
  return new GitHubClient({ accessToken: tokens.accessToken });
}

/** Creates a proposal and its mandatory change-approval request. */
export async function createPipeline(
  db: Database,
  input: {
    workspaceId: string;
    projectId: string;
    title: string;
    description?: string;
    changes: Array<{ path: string; content: string }>;
    createdBy?: string | null;
  },
): Promise<{ pipeline: CodePipeline; approvalId: string }> {
  if (!input.changes.length) throw new Error("At least one concrete file change is required");
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project || project.workspaceId !== input.workspaceId) throw new Error("Project not found in workspace");
  if (!project.repositoryFullName) throw new Error("No GitHub repository linked to this project");

  const beforeMetrics = await metricsFor(db, project.id);
  const created = await db.insert(codePipelines).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? null,
    changes: input.changes,
    status: "awaiting_approval",
    beforeMetrics,
    steps: step([], "proposal", "completed", `${input.changes.length} file change(s) recorded`),
    createdBy: input.createdBy ?? null,
  }).returning();
  const pipeline = created[0];

  const [approval] = await db.insert(approvals).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    requestedByAgent: "DEVELOPER_AGENT",
    actionType: "code_change",
    description: input.title,
    payload: { changes: input.changes, pipelineId: pipeline.id } as Record<string, unknown>,
    risk: "high",
  }).returning();

  await db.update(codePipelines).set({ changeApprovalId: approval.id }).where(eq(codePipelines.id, pipeline.id));
  await log(db, pipeline, "pipeline.proposed", { changes: input.changes.length });
  return { pipeline: { ...pipeline, changeApprovalId: approval.id }, approvalId: approval.id };
}

/** Advances the pipeline one stage. Each write action re-checks approval. */
export async function advancePipeline(
  db: Database,
  pipelineId: string,
  options: { checkRunner?: CheckRunner } = {},
): Promise<CodePipeline> {
  const current = (await db.select().from(codePipelines).where(eq(codePipelines.id, pipelineId)).limit(1))[0];
  if (!current) throw new Error("Pipeline not found");
  const [project] = await db.select().from(projects).where(eq(projects.id, current.projectId)).limit(1);
  if (!project) throw new Error("Project not found");
  const [owner, repo] = project.repositoryFullName!.split("/");
  const client = await githubFor(db, current.workspaceId);
  globalThis.__searchrankAutomationGithub = (await getDecryptedTokens(db, current.workspaceId, "github"))?.accessToken;

  const save = async (patch: Partial<CodePipeline>) => {
    const updated = await db.update(codePipelines)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(codePipelines.id, current.id))
      .returning();
    return updated[0];
  };

  switch (current.status) {
    case "awaiting_approval": {
      const [approval] = current.changeApprovalId
        ? await db.select().from(approvals).where(eq(approvals.id, current.changeApprovalId)).limit(1)
        : [];
      if (!approval || approval.status !== "approved") throw new Error("Change approval is required before touching a repository");
      const branch = `seo/${Date.now()}-${current.id.slice(0, 8)}`;
      const repository = await client.getRepository(owner, repo);
      await client.createBranch(owner, repo, branch, repository.default_branch);
      for (const change of current.changes) {
        const existing = await client.readFile(owner, repo, change.path, repository.default_branch);
        await client.upsertFile(owner, repo, change.path, change.content, branch, `SEO: ${current.title}`, existing?.sha);
      }
      const headSha = await client.getBranchHead(owner, repo, branch);
      const result = await save({
        status: "checks_running",
        branch,
        headSha,
        baseBranch: repository.default_branch,
        steps: step(current.steps, "branch", "completed", `Branch ${branch} created with ${current.changes.length} change(s)`),
      });
      await log(db, current, "pipeline.branch_created", { branch });
      return result;
    }

    case "checks_running": {
      const runner = options.checkRunner ?? githubCheckRunner;
      const checks = await runner({ owner, repo, sha: current.headSha ?? "", branch: current.branch ?? "" });
      const passed = checks.length > 0 && checks.every((c) => c.passed);
      const result = await save({
        status: passed ? "checks_passed" : "checks_failed",
        checks: { results: checks, passed } as Record<string, unknown>,
        steps: step(current.steps, "checks", passed ? "completed" : "failed", checks.map((c) => `${c.name}: ${c.detail}`).join("; ")),
      });
      await log(db, current, "pipeline.checks_completed", { passed, count: checks.length });
      return result;
    }

    case "checks_failed": {
      throw new Error("Checks failed; fix the proposed changes and create a new pipeline. No PR was opened.");
    }

    case "checks_passed": {
      const pr = await client.createPullRequest(owner, repo, {
        title: current.title,
        head: current.branch!,
        base: current.baseBranch ?? "main",
        body: [
          current.description ?? "Automated SEO proposal.",
          "",
          "Checks passed before this PR was opened. Merge requires explicit administrator approval.",
          `Pipeline: ${current.id}`,
        ].join("\n"),
      });
      const result = await save({
        status: "pr_open",
        prNumber: pr.number,
        prUrl: pr.html_url,
        steps: step(current.steps, "pull_request", "completed", `PR #${pr.number} opened`),
      });
      await log(db, current, "pipeline.pr_opened", { number: pr.number, url: pr.html_url });
      return result;
    }

    case "pr_open": {
      // Find a real Vercel preview deployment for this project/branch.
      let previewUrl: string | null = null;
      const vcTokens = await getDecryptedTokens(db, current.workspaceId, "vercel");
      if (vcTokens && project.vercelProjectId) {
        try {
          const summary = await new VercelClient({ accessToken: vcTokens.accessToken }).getDeploymentSummary(project.vercelProjectId);
          previewUrl = summary.previews.find((p) => p.state === "READY")?.url
            ? `https://${summary.previews.find((p) => p.state === "READY")!.url}`
            : null;
          for (const d of summary.previews) {
            await db.insert(deployments).values({
              projectId: project.id, provider: "vercel", deploymentId: d.id,
              url: `https://${d.url}`, state: d.state, isPreview: true,
              commitSha: d.meta?.githubCommitSha ?? null,
            }).onConflictDoNothing();
          }
        } catch {
          previewUrl = null;
        }
      }
      const afterMetrics = await metricsFor(db, project.id);
      const [mergeApproval] = await db.insert(approvals).values({
        workspaceId: current.workspaceId,
        projectId: current.projectId,
        requestedByAgent: "DEVELOPER_AGENT",
        actionType: "merge_deployment",
        description: `Merge PR #${current.prNumber} and deploy ${project.name}`,
        payload: { pipelineId: current.id, prNumber: current.prNumber, previewUrl } as Record<string, unknown>,
        risk: "critical",
      }).returning();
      const result = await save({
        status: "awaiting_merge",
        previewUrl,
        afterMetrics,
        mergeApprovalId: mergeApproval.id,
        steps: step(current.steps, "preview", "completed", previewUrl ? `Preview ${previewUrl}` : "No preview deployment found"),
      });
      await log(db, current, "pipeline.preview_checked", { previewUrl });
      return result;
    }

    case "awaiting_merge": {
      const [approval] = current.mergeApprovalId
        ? await db.select().from(approvals).where(eq(approvals.id, current.mergeApprovalId)).limit(1)
        : [];
      if (!approval || approval.status !== "approved") throw new Error("Merge approval is required before merging");
      if (!current.prNumber) throw new Error("Pull request number is missing");
      const merged = await client.mergePullRequest(owner, repo, current.prNumber, "squash");
      if (!merged.merged) throw new Error(`GitHub refused the merge: ${merged.message}`);
      const result = await save({
        status: "merged",
        mergedAt: new Date(),
        steps: step(current.steps, "merge", "completed", `PR #${current.prNumber} merged as ${merged.sha.slice(0, 12)}`),
      });
      await log(db, current, "pipeline.merged", { prNumber: current.prNumber, sha: merged.sha });
      return result;
    }

    case "merged": {
      const [rollbackApproval] = await db.insert(approvals).values({
        workspaceId: current.workspaceId,
        projectId: current.projectId,
        requestedByAgent: "DEVELOPER_AGENT",
        actionType: "rollback",
        description: `Open a rollback PR for ${current.title}`,
        payload: { pipelineId: current.id, headSha: current.headSha } as Record<string, unknown>,
        risk: "critical",
      }).returning();
      const result = await save({
        status: "awaiting_approval",
        changeApprovalId: rollbackApproval.id,
        steps: step(current.steps, "rollback_requested", "pending", `Rollback approval ${rollbackApproval.id}`),
      });
      await log(db, current, "pipeline.rollback_requested", { approvalId: rollbackApproval.id });
      return result;
    }

    default:
      throw new Error(`No automation step available for status ${current.status}`);
  }
}

export async function rollbackPipeline(
  db: Database,
  pipelineId: string,
  approvalId: string,
): Promise<CodePipeline> {
  const pipeline = (await db.select().from(codePipelines).where(eq(codePipelines.id, pipelineId)).limit(1))[0];
  if (!pipeline) throw new Error("Pipeline not found");
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval || approval.status !== "approved" || approval.actionType !== "rollback") {
    throw new Error("An approved rollback request is required");
  }
  const [project] = await db.select().from(projects).where(eq(projects.id, pipeline.projectId)).limit(1);
  const [owner, repo] = project!.repositoryFullName!.split("/");
  const client = await githubFor(db, pipeline.workspaceId);
  const reverted = await client.createRevertPullRequest(owner, repo, pipeline.headSha ?? "", pipeline.baseBranch ?? "main");
  const updated = await db.update(codePipelines).set({
    status: "reverted",
    revertedAt: new Date(),
    steps: step(pipeline.steps, "rollback", "completed", `Revert PR #${reverted.number} opened`),
  }).where(eq(codePipelines.id, pipelineId)).returning();
  await log(db, pipeline, "pipeline.reverted", { prNumber: reverted.number });
  return updated[0];
}

export async function listPipelines(db: Database, workspaceId: string) {
  return db.select().from(codePipelines)
    .where(eq(codePipelines.workspaceId, workspaceId))
    .orderBy(desc(codePipelines.createdAt))
    .limit(100);
}

export async function readPipeline(db: Database, workspaceId: string, id: string) {
  const [row] = await db.select().from(codePipelines)
    .where(and(eq(codePipelines.id, id), eq(codePipelines.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export function metricsDelta(before: Record<string, unknown>, after: Record<string, unknown>) {
  const value = (obj: Record<string, unknown>, key: string) => Number(obj[key] ?? 0);
  return {
    auditScore: value(after, "auditScore") - value(before, "auditScore"),
    clicks: value(after, "clicks") - value(before, "clicks"),
    impressions: value(after, "impressions") - value(before, "impressions"),
    note: "Comparison uses persisted audit and search-metric rows; no metrics are fabricated.",
  };
}

