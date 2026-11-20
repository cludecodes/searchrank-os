import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvals, contentItems, jobs, keywords, pages, projects, searchMetrics, seoAudits,
} from "../src/core/db/schema";
import { getExecutiveData } from "../src/core/reporting/executive";
import { getAIProvider, resetAIProviderCache } from "../src/core/ai/provider";
import { seedIdentity, setupTestDb } from "./helpers";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.AI_PROVIDER = "pollinations";
  process.env.AI_MODEL = "openai-fast";
  delete process.env.AI_API_KEY;
  resetAIProviderCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAIProviderCache();
});

describe("phase 9 — executive dashboard", () => {
  it("reports honest zeros when no data exists", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const data = await getExecutiveData(db, workspaceId);
    expect(data.sites.total).toBe(0);
    expect(data.audits.averageScore).toBeNull();
    expect(data.search.clicks).toBe(0);
    expect(data.search.top3).toBe(0);
    expect(data.ai.configured).toBe(true);
    expect(data.ai.name).toBe("pollinations-gpt-oss-20b");
    await close();
  });

  it("aggregates real persisted rows across portfolio", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Portfolio Site", slug: "portfolio", domain: "portfolio.example", status: "active",
    }).returning())[0];
    await db.insert(pages).values([
      { projectId: project.id, url: "https://portfolio.example/", statusCode: 200 },
      { projectId: project.id, url: "https://portfolio.example/broken", statusCode: 404 },
    ]);
    await db.insert(seoAudits).values({ projectId: project.id, score: 82, status: "completed", findings: {} });
    await db.insert(keywords).values({ projectId: project.id, keyword: "plumber", country: "US" });
    await db.insert(contentItems).values({ projectId: project.id, title: "Guide", status: "published", intent: "informational" });
    await db.insert(jobs).values({ workspaceId, projectId: project.id, type: "seo.audit", status: "succeeded" });
    await db.insert(approvals).values({ workspaceId, actionType: "code_change", description: "x", status: "pending" });
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(searchMetrics).values([
      { projectId: project.id, source: "google_search_console", date: today, query: "a", page: "/", clicks: 20, impressions: 400, position: 2 },
      { projectId: project.id, source: "google_search_console", date: today, query: "b", page: "/", clicks: 5, impressions: 100, position: 8 },
    ]);

    const data = await getExecutiveData(db, workspaceId);
    expect(data.sites).toMatchObject({ total: 1, active: 1 });
    expect(data.pages).toMatchObject({ indexed: 1, total: 2 });
    expect(data.audits).toMatchObject({ count: 1, averageScore: 82 });
    expect(data.search).toMatchObject({ clicks: 25, impressions: 500, top3: 1, top10: 2, ctr: 5 });
    expect(data.keywords.total).toBe(1);
    expect(data.content.find((c) => c.status === "published")?.total).toBe(1);
    expect(data.jobs.find((j) => j.status === "succeeded")?.total).toBe(1);
    expect(data.approvals.pending).toBe(1);
    expect(data.perProject[0]).toMatchObject({ auditScore: 82, keywords: 1, clicks: 25, content: 1 });
    await close();
  });

  it("free open-weight provider needs no API key and sends no Authorization header", async () => {
    let authHeader: string | null = "unset";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      authHeader = headers.Authorization ?? null;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "OPEN_MODEL_OK" } }],
        model: "gpt-oss-20b",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const provider = getAIProvider();
    const result = await provider.complete({ messages: [{ role: "user", content: "hello" }] });
    expect(result.text).toBe("OPEN_MODEL_OK");
    expect(result.model).toBe("gpt-oss-20b");
    expect(authHeader).toBeNull();
  });
});
