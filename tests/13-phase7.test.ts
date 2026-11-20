import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals, indexingSubmissions, monitoringChecks, projects, searchMetrics,
} from "../src/core/db/schema";
import { registerAllAgents } from "../src/core/agents/definitions";
import { runAgent } from "../src/core/agents/framework";
import { saveIntegration } from "../src/core/integrations/credentials";
import { encryptSecret } from "../src/core/security/crypto";
import {
  edgeVisibility, getEngineSites, inspectUrl, monitorIssues,
  submitBingUrls, submitSitemaps, syncPerformance,
} from "../src/core/search-engines/service";
import { seedIdentity, setupTestDb } from "./helpers";

let originalFetch: typeof globalThis.fetch;

function jsonFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> }) {
  return (async (url: string, init: RequestInit) => {
    const out = handler(url, init);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: (key: string) => out.headers?.[key.toLowerCase()] ?? null },
      text: async () => JSON.stringify(out.body),
      json: async () => out.body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

async function seedProject(db: Awaited<ReturnType<typeof setupTestDb>>["db"], workspaceId: string) {
  return (await db.insert(projects).values({
    workspaceId, name: "Engine Site", slug: "engine-site", productionUrl: "https://engine.example",
  }).returning())[0];
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  registerAllAgents();
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe("phase 7 — search engine service", () => {
  it("lists real verified sites from both engines", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await saveIntegration(db, { workspaceId, provider: "google_search_console", accessToken: encryptSecret("g"), accountIdentifier: "default" });
    await saveIntegration(db, { workspaceId, provider: "bing_webmaster", accessToken: encryptSecret("b"), accountIdentifier: "default" });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("/webmasters/v3/sites")) return { status: 200, body: { siteEntry: [{ siteUrl: "https://engine.example/" }] } };
      if (url.includes("GetUserSites")) return { status: 200, body: { d: [{ Url: "https://engine.example/" }] } };
      return { status: 200, body: {} };
    });
    const engines = await getEngineSites(db, workspaceId);
    expect(engines.find((e) => e.provider === "google_search_console")?.sites).toContain("https://engine.example/");
    expect(engines.find((e) => e.provider === "bing_webmaster")?.sites).toContain("https://engine.example/");
    await close();
  });

  it("requires approval before sitemap submission and records each engine response", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = await seedProject(db, workspaceId);
    await saveIntegration(db, { workspaceId, provider: "google_search_console", accessToken: encryptSecret("g"), accountIdentifier: "default" });
    await saveIntegration(db, { workspaceId, provider: "bing_webmaster", accessToken: encryptSecret("b"), accountIdentifier: "default" });
    const [approval] = await db.insert(approvals).values({
      workspaceId, projectId: project.id, actionType: "sitemap_submission", description: "submit", status: "approved",
      payload: {} as Record<string, unknown>,
    }).returning();

    globalThis.fetch = jsonFetch(() => ({ status: 200, body: {} }));
    const results = await submitSitemaps(db, workspaceId, project.id, "https://engine.example/sitemap.xml", approval.id);
    expect(results.map((r) => r.engine)).toEqual(["google", "bing"]);
    expect(results.every((r) => r.status === "accepted")).toBe(true);
    const rows = await db.select().from(indexingSubmissions).where(eq(indexingSubmissions.projectId, project.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.engine)).toContain("google-sitemap");

    await expect(submitSitemaps(db, workspaceId, project.id, "https://engine.example/sitemap.xml", "00000000-0000-0000-0000-000000000000"))
      .rejects.toThrow(/approv/i);
    await close();
  });

  it("submits Bing URLs within the real daily quota", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = await seedProject(db, workspaceId);
    await saveIntegration(db, { workspaceId, provider: "bing_webmaster", accessToken: encryptSecret("b"), accountIdentifier: "default" });
    const [approval] = await db.insert(approvals).values({
      workspaceId, projectId: project.id, actionType: "url_submission", description: "submit urls", status: "approved",
      payload: {} as Record<string, unknown>,
    }).returning();

    const submitted: string[] = [];
    globalThis.fetch = jsonFetch((url, init) => {
      if (url.includes("GetUrlSubmissionQuota")) return { status: 200, body: { d: { DailyQuota: 2 } } };
      if (url.includes("SubmitUrlBatch")) {
        submitted.push(((init.body as string) ?? ""));
        return { status: 200, body: { d: null } };
      }
      return { status: 200, body: {} };
    });
    const result = await submitBingUrls(db, workspaceId, project.id, [
      "https://engine.example/a", "https://engine.example/b", "https://engine.example/c",
    ], approval.id);
    expect(result.submitted).toBe(2);
    expect(result.quota).toBe(2);
    expect(submitted).toHaveLength(1);
    const rows = await db.select().from(indexingSubmissions).where(eq(indexingSubmissions.engine, "bing-url"));
    expect(rows).toHaveLength(2);
    await close();
  });

  it("records URL inspection verdicts from real GSC responses", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = await seedProject(db, workspaceId);
    await saveIntegration(db, { workspaceId, provider: "google_search_console", accessToken: encryptSecret("g"), accountIdentifier: "default" });

    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("urlInspection")) {
        return new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const result = await inspectUrl(db, workspaceId, project.id, "https://engine.example/a");
    expect(result.verdict).toBe("PASS");
    const rows = await db.select().from(indexingSubmissions).where(eq(indexingSubmissions.engine, "google-inspection"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PASS");
    await close();
  });

  it("syncs performance from both engines with distinct sources and computes Edge view honestly", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = await seedProject(db, workspaceId);
    await saveIntegration(db, { workspaceId, provider: "google_search_console", accessToken: encryptSecret("g"), accountIdentifier: "default" });
    await saveIntegration(db, { workspaceId, provider: "bing_webmaster", accessToken: encryptSecret("b"), accountIdentifier: "default" });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("searchAnalytics")) {
        return { status: 200, body: { rows: [{ keys: ["plumber", "https://engine.example/", "GB", "MOBILE"], clicks: 5, impressions: 100, ctr: 0.05, position: 9 }] } };
      }
      if (url.includes("GetQueryStats")) {
        return { status: 200, body: { d: [{ Query: "plumber", Clicks: 3, Impressions: 60, AvgClickPosition: 12 }] } };
      }
      return { status: 200, body: {} };
    });

    const results = await syncPerformance(db, workspaceId, project.id);
    expect(results.map((r) => r.source)).toEqual(["google_search_console", "bing_webmaster"]);
    const rows = await db.select().from(searchMetrics).where(eq(searchMetrics.projectId, project.id));
    expect(rows).toHaveLength(2);

    const edge = await edgeVisibility(db, project.id);
    expect(edge.clicks).toBe(3);
    expect(edge.note).toMatch(/Bing index/);
    await close();
  });

  it("monitors sitemap and crawl issues from real provider responses", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = await seedProject(db, workspaceId);
    await saveIntegration(db, { workspaceId, provider: "google_search_console", accessToken: encryptSecret("g"), accountIdentifier: "default" });
    await saveIntegration(db, { workspaceId, provider: "bing_webmaster", accessToken: encryptSecret("b"), accountIdentifier: "default" });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("/sitemaps")) return { status: 200, body: { sitemap: [{ path: "https://engine.example/sitemap.xml", isThrottled: true }] } };
      if (url.includes("GetCrawlIssues")) return { status: 200, body: { d: [{ Issue: "404" }] } };
      return { status: 200, body: {} };
    });

    const findings = await monitorIssues(db, workspaceId, project.id);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.status === "issues")).toBe(true);
    const checks = await db.select().from(monitoringChecks).where(and(eq(monitoringChecks.projectId, project.id)));
    expect(checks.map((c) => c.kind).sort()).toEqual(["crawl", "sitemap"]);
    await close();
  });

  it("agents skip honestly without connected engines", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = await seedProject(db, workspaceId);
    const analytics = await runAgent(db, "ANALYTICS_AGENT", {
      workspaceId, projectId: project.id, input: { mode: "sync-both" },
    });
    expect(analytics.result.data?.total).toBe(0);
    const indexing = await runAgent(db, "INDEXING_AGENT", {
      workspaceId, projectId: project.id, input: { mode: "inspect-url", url: "https://engine.example/" },
    });
    expect(indexing.result.skippedReason).toMatch(/not connected/i);
    await close();
  });
});
