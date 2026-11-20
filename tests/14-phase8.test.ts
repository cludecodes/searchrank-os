import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, codePipelines, projects, searchMetrics, seoAudits } from "../src/core/db/schema";
import { saveIntegration } from "../src/core/integrations/credentials";
import { encryptSecret } from "../src/core/security/crypto";
import { GitHubClient } from "../src/core/integrations/github";
import {
  advancePipeline, createPipeline, metricsDelta, rollbackPipeline,
  type CheckRunner,
} from "../src/core/automation/pipeline";
import { seedIdentity, setupTestDb } from "./helpers";

let originalFetch: typeof globalThis.fetch;

function githubFetch() {
  const calls: string[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const u = new URL(url);
    let status = 200;
    let body: unknown = {};
    if (u.pathname.includes("/git/ref/heads/main")) body = { object: { sha: "base-sha" } };
    else if (u.pathname.endsWith("/repos/o/r")) body = { default_branch: "main" };
    else if (u.pathname.includes("/contents/")) {
      if (init.method === "PUT") body = { content: { sha: "file-sha" } };
      else { status = 404; body = { message: "Not Found" }; }
    } else if (u.pathname.includes("/commits/") && u.pathname.endsWith("/check-runs")) {
      body = { check_runs: [{ name: "typecheck", status: "completed", conclusion: "success" }] };
    } else if (u.pathname.includes("/commits/")) body = [{ sha: "head-sha" }];
    else if (u.pathname.endsWith("/pulls")) body = { html_url: "https://github.com/o/r/pull/7", number: 7 };
    else if (u.pathname.endsWith("/merge")) body = { merged: true, sha: "merge-sha", message: "ok" };
    else if (u.pathname.includes("/git/reverts")) body = { commit: { sha: "revert-sha" } };
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
});

afterEach(() => { globalThis.fetch = originalFetch; });

async function projectWithGithub() {
  const { db, close } = await setupTestDb();
  const { workspaceId } = await seedIdentity(db);
  await saveIntegration(db, {
    workspaceId, provider: "github", accessToken: encryptSecret("gh-token"),
    accountIdentifier: "default", scopes: ["public_repo"],
  });
  const project = (await db.insert(projects).values({
    workspaceId, name: "Repo Site", slug: "repo-site", repositoryFullName: "o/r",
    productionUrl: "https://repo.example",
  }).returning())[0];
  return { db, close, workspaceId, project };
}

const passingRunner: CheckRunner = async () => [
  { name: "typecheck", passed: true, detail: "ok" },
  { name: "tests", passed: true, detail: "11 passed" },
];

describe("phase 8 — automation pipeline", () => {
  it("creates a proposal and approval without touching a repository", async () => {
    const { db, close, workspaceId, project } = await projectWithGithub();
    const { fn, calls } = githubFetch();
    globalThis.fetch = fn;
    const { pipeline, approvalId } = await createPipeline(db, {
      workspaceId, projectId: project.id, title: "Improve metadata",
      changes: [{ path: "src/app/page.tsx", content: "// new" }],
    });
    expect(pipeline.status).toBe("awaiting_approval");
    expect(calls).toHaveLength(0);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval.status).toBe("pending");
    expect(approval.actionType).toBe("code_change");
    await close();
  });

  it("refuses to create a branch before approval", async () => {
    const { db, close, workspaceId, project } = await projectWithGithub();
    const { fn, calls } = githubFetch();
    globalThis.fetch = fn;
    const { pipeline } = await createPipeline(db, {
      workspaceId, projectId: project.id, title: "Change", changes: [{ path: "a.ts", content: "x" }],
    });
    await expect(advancePipeline(db, pipeline.id, { checkRunner: passingRunner })).rejects.toThrow(/approval/i);
    expect(calls).toHaveLength(0);
    await close();
  });

  it("runs branch → checks → PR → preview → merge → rollback with approvals", async () => {
    const { db, close, workspaceId, project } = await projectWithGithub();
    const { fn } = githubFetch();
    globalThis.fetch = fn;

    const { pipeline, approvalId } = await createPipeline(db, {
      workspaceId, projectId: project.id, title: "SEO change",
      changes: [{ path: "a.ts", content: "export const a = 1;" }],
    });
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approvalId));

    let p = await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    expect(p.status).toBe("checks_running");
    expect(p.branch).toMatch(/^seo\//);
    expect(p.headSha).toBe("head-sha");

    p = await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    expect(p.status).toBe("checks_passed");

    p = await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    expect(p.status).toBe("pr_open");
    expect(p.prNumber).toBe(7);

    p = await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    expect(p.status).toBe("awaiting_merge");
    expect(p.mergeApprovalId).toBeTruthy();
    const [mergeApproval] = await db.select().from(approvals).where(eq(approvals.id, p.mergeApprovalId!));
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, mergeApproval.id));

    p = await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    expect(p.status).toBe("merged");
    expect(p.mergedAt).not.toBeNull();

    p = await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    expect(p.status).toBe("awaiting_approval");
    const [rollbackApproval] = await db.select().from(approvals)
      .where(eq(approvals.id, p.changeApprovalId!));
    expect(rollbackApproval.actionType).toBe("rollback");
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, rollbackApproval.id));

    p = await rollbackPipeline(db, pipeline.id, rollbackApproval.id);
    expect(p.status).toBe("reverted");
    await close();
  });

  it("stops before PR when checks fail", async () => {
    const { db, close, workspaceId, project } = await projectWithGithub();
    const { fn } = githubFetch();
    globalThis.fetch = fn;
    const { pipeline, approvalId } = await createPipeline(db, {
      workspaceId, projectId: project.id, title: "Bad change", changes: [{ path: "a.ts", content: "x" }],
    });
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approvalId));
    await advancePipeline(db, pipeline.id, { checkRunner: passingRunner });
    const failing: CheckRunner = async () => [{ name: "lint", passed: false, detail: "errors" }];
    const p = await advancePipeline(db, pipeline.id, { checkRunner: failing });
    expect(p.status).toBe("checks_failed");
    await expect(advancePipeline(db, pipeline.id, { checkRunner: passingRunner })).rejects.toThrow(/checks failed/i);
    await close();
  });

  it("computes before/after deltas from persisted metrics only", async () => {
    const { db, close, workspaceId, project } = await projectWithGithub();
    await db.insert(seoAudits).values({ projectId: project.id, score: 60, status: "completed", findings: {} });
    await db.insert(searchMetrics).values({
      projectId: project.id, source: "google_search_console", date: "2026-01-01", clicks: 10, impressions: 100,
    });
    const before = metricsDelta(
      { auditScore: 60, clicks: 10, impressions: 100 },
      { auditScore: 75, clicks: 25, impressions: 300 },
    );
    expect(before).toMatchObject({ auditScore: 15, clicks: 15, impressions: 200 });
    expect(before.note).toMatch(/no metrics are fabricated/i);
    await close();
  });

  it("GitHub client exposes merge and revert operations with real endpoints", async () => {
    const { fn, calls } = githubFetch();
    globalThis.fetch = fn;
    const client = new GitHubClient({ accessToken: "t" });
    const merged = await client.mergePullRequest("o", "r", 7);
    expect(merged.merged).toBe(true);
    const reverted = await client.createRevertPullRequest("o", "r", "head-sha", "main");
    expect(reverted.number).toBe(7);
    expect(calls.some((c) => c.includes("/merge"))).toBe(true);
    expect(calls.some((c) => c.includes("/git/reverts"))).toBe(true);
  });
});
