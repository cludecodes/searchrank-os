import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentRuns, approvals, auditLogs, competitors, contentItems, indexingSubmissions,
  jobs, keywordClusters, keywordHistory, keywords, pages, projects, searchMetrics,
} from "../src/core/db/schema";
import { registerAllAgents } from "../src/core/agents/definitions";
import { runAgent } from "../src/core/agents/framework";
import { buildWorkflowPlan, evaluateRecentRuns, executeWorkflowPlan } from "../src/core/agents/supervisor";
import { saveIntegration } from "../src/core/integrations/credentials";
import { encryptSecret } from "../src/core/security/crypto";
import { enqueueJob } from "../src/core/jobs/queue";
import { seedIdentity, setupTestDb } from "./helpers";

let originalFetch: typeof globalThis.fetch;

function jsonFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return (async (url: string, init: RequestInit) => {
    const out = handler(url, init);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: () => null },
      text: async () => JSON.stringify(out.body),
      json: async () => out.body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  registerAllAgents();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.INDEXNOW_KEY;
  delete process.env.INDEXNOW_KEY_LOCATION;
});

describe("phase 3 — supervisor orchestration", () => {
  it("builds an evidence-driven plan and skips already queued work", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(projects).values({
      workspaceId, name: "Site", slug: "site", status: "active", productionUrl: "https://site.example",
    });

    const plan = await buildWorkflowPlan(db, workspaceId);
    const types = plan.plans[0]?.jobs.map((j) => j.type) ?? [];
    expect(types).toContain("seo.audit");
    expect(types).toContain("keywords.sync");
    expect(types).toContain("analytics.sync");

    await enqueueJob(db, { workspaceId, projectId: plan.plans[0].projectId, type: "seo.audit", payload: {} });
    const replan = await buildWorkflowPlan(db, workspaceId);
    expect(replan.plans[0]?.jobs.map((j) => j.type)).not.toContain("seo.audit");
    await close();
  });

  it("executes a plan by persisting jobs and an audit event", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId, userId } = await seedIdentity(db);
    await db.insert(projects).values({
      workspaceId, name: "Site", slug: "site", status: "active", productionUrl: "https://site.example",
    });
    const { plan, enqueued } = await executeWorkflowPlan(db, workspaceId, userId);
    expect(enqueued.length).toBeGreaterThan(0);
    expect(enqueued.length).toBe(plan.totalPlanned);
    const stored = await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
    expect(stored.length).toBe(enqueued.length);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
    expect(logs.some((l) => l.action === "supervisor.plan_executed")).toBe(true);
    await close();
  });

  it("evaluates persisted agent runs with honest success rates", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(agentRuns).values([
      { workspaceId, agentKey: "TECHNICAL_SEO_AGENT", status: "succeeded", startedAt: new Date() },
      { workspaceId, agentKey: "TECHNICAL_SEO_AGENT", status: "failed", startedAt: new Date() },
      { workspaceId, agentKey: "KEYWORD_INTELLIGENCE_AGENT", status: "skipped", startedAt: new Date() },
    ]);
    const evaluations = await evaluateRecentRuns(db, workspaceId, new Date(Date.now() - 7 * 86_400_000));
    const seo = evaluations.find((e) => e.agentKey === "TECHNICAL_SEO_AGENT");
    expect(seo?.runs).toBe(2);
    expect(seo?.successRate).toBe(50);
    const kw = evaluations.find((e) => e.agentKey === "KEYWORD_INTELLIGENCE_AGENT");
    expect(kw?.skipped).toBe(1);
    expect(kw?.successRate).toBe(0);
    await close();
  });

  it("supervisor agent reports its evaluation and queue decisions", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(projects).values({ workspaceId, name: "Site", slug: "site", status: "active", productionUrl: "https://site.example" });
    const { result } = await runAgent(db, "CHIEF_SUPERVISOR", { workspaceId, input: {} });
    expect(result.summary).toMatch(/planned \d+ job/);
    expect(result.data?.evaluations).toBeDefined();
    await close();
  });
});

describe("phase 3 — deeper agent logic", () => {
  it("keyword agent creates country/intent clusters and immutable history", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "GSC Site", slug: "gsc-site", productionUrl: "https://gsc.example", country: "GB",
    }).returning())[0];
    await saveIntegration(db, {
      workspaceId, provider: "google_search_console", accessToken: encryptSecret("gsc-token"),
      accountIdentifier: "default", scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("searchAnalytics")) {
        return {
          status: 200,
          body: {
            rows: [
              { keys: ["buy running shoes", "https://gsc.example/shoes", "GB", "MOBILE"], clicks: 12, impressions: 300, ctr: 0.04, position: 7 },
              { keys: ["running shoe guide", "https://gsc.example/guide", "GB", "DESKTOP"], clicks: 3, impressions: 90, ctr: 0.03, position: 14 },
            ],
          },
        };
      }
      return { status: 200, body: {} };
    });

    const { result } = await runAgent(db, "KEYWORD_INTELLIGENCE_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toBeUndefined();
    expect(result.data?.stored).toBe(2);
    expect(Number(result.data?.clustersCreated)).toBeGreaterThan(0);

    const clusters = await db.select().from(keywordClusters).where(eq(keywordClusters.projectId, project.id));
    expect(clusters.map((c) => c.name)).toContain("GB-transactional");
    const history = await db.select().from(keywordHistory);
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.source === "google_search_console")).toBe(true);
    await close();
  });

  it("competitor agent derives content gaps from live headings versus our keywords", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Mine", slug: "mine" }).returning())[0];
    await db.insert(keywords).values({ projectId: project.id, keyword: "emergency plumbing", country: "US" });
    const competitor = (await db.insert(competitors).values({
      projectId: project.id, domain: "rival.example",
    }).returning())[0];

    globalThis.fetch = jsonFetch(() => ({
      status: 200,
      body: "<html><h1>Emergency Plumbing Help</h1><h2>Drain cleaning expertise</h2><h3>Water heater installation</h3></html>",
    }));
    // Competitor agent uses fetch().text(), not JSON.
    globalThis.fetch = (async () => new Response(
      "<html><h1>Emergency Plumbing Help</h1><h2>Drain cleaning expertise</h2><h3>Water heater installation</h3></html>",
      { status: 200 },
    )) as typeof globalThis.fetch;

    const { result } = await runAgent(db, "COMPETITOR_INTELLIGENCE_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toBeUndefined();
    const updated = (await db.select().from(competitors).where(eq(competitors.id, competitor.id)))[0];
    expect(updated.contentGaps.length).toBeGreaterThan(0);
    expect(updated.contentGaps.join(" ")).toMatch(/drain|water heater/i);
    await close();
  });

  it("indexing agent derives verified URLs, generates a sitemap and gates submission on approval", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Indexed", slug: "indexed", productionUrl: "https://indexed.example", status: "active",
    }).returning())[0];
    await db.insert(pages).values([
      { projectId: project.id, url: "https://indexed.example/", statusCode: 200, title: "Home" },
      { projectId: project.id, url: "https://indexed.example/about", statusCode: 200, title: "About" },
      { projectId: project.id, url: "https://indexed.example/broken", statusCode: 404 },
    ]);

    globalThis.fetch = jsonFetch(() => ({ status: 200, body: {} }));

    const first = await runAgent(db, "INDEXING_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(first.result.requiresApproval).toBe(true);
    const approval = (await db.select().from(approvals).where(eq(approvals.workspaceId, workspaceId)))[0];
    expect(approval.actionType).toBe("indexing_submission");
    expect((approval.payload as { sitemapGenerated?: boolean }).sitemapGenerated).toBe(true);

    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval.id));
    process.env.INDEXNOW_KEY = "test-key";
    process.env.INDEXNOW_KEY_LOCATION = "https://indexed.example/test-key.txt";
    globalThis.fetch = jsonFetch(() => ({ status: 202, body: {} }));

    const second = await runAgent(db, "INDEXING_AGENT", {
      workspaceId, projectId: project.id, input: { approvalId: approval.id },
    });
    expect(second.result.skippedReason).toBeUndefined();
    const submissions = await db.select().from(indexingSubmissions).where(eq(indexingSubmissions.projectId, project.id));
    expect(submissions).toHaveLength(2);
    expect(submissions.every((s) => s.status === "accepted")).toBe(true);
    await close();
  });

  it("quality agent flags dangerous code changes in approval payloads", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(approvals).values({
      workspaceId,
      actionType: "code_change",
      description: "Change env",
      risk: "high",
      payload: { changes: [{ path: ".env.production", content: "SECRET=1" }] } as Record<string, unknown>,
    });
    const { result } = await runAgent(db, "QUALITY_SECURITY_AGENT", { workspaceId, input: {} });
    const dangerous = result.data?.dangerousChanges as Array<{ path: string; reason: string }>;
    expect(dangerous.length).toBeGreaterThan(0);
    expect(dangerous[0].path).toBe(".env.production");
    await close();
  });

  it("analytics agent compares weekly and monthly metrics from persisted rows", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Metrics", slug: "metrics" }).returning())[0];
    const d = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    await db.insert(searchMetrics).values([
      { projectId: project.id, source: "google_search_console", date: d(1), clicks: 20, impressions: 400 },
      { projectId: project.id, source: "google_search_console", date: d(10), clicks: 10, impressions: 200 },
      { projectId: project.id, source: "google_search_console", date: d(40), clicks: 5, impressions: 100 },
    ]);
    const { result } = await runAgent(db, "ANALYTICS_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.data?.weekly).toMatchObject({ clicks: 20, previousClicks: 10 });
    expect((result.data?.weekly as { clicksChangePct: number }).clicksChangePct).toBe(100);
    expect(result.data?.monthly).toMatchObject({ clicks: 30, previousClicks: 5 });
    await close();
  });

  it("content production skips without AI instead of fabricating text", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "No AI", slug: "no-ai" }).returning())[0];
    await db.insert(contentItems).values({ projectId: project.id, title: "Approved brief", status: "approved" });
    const { result } = await runAgent(db, "CONTENT_PRODUCTION_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toMatch(/no ai provider/i);
    await close();
  });
});
