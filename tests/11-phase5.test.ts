import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { keywordClusters, keywordHistory, keywords, projects } from "../src/core/db/schema";
import { registerAllAgents } from "../src/core/agents/definitions";
import { runAgent } from "../src/core/agents/framework";
import { saveIntegration } from "../src/core/integrations/credentials";
import { encryptSecret } from "../src/core/security/crypto";
import { BingWebmasterClient } from "../src/core/integrations/bing-webmaster";
import {
  associateCompetitorUrls,
  businessValueScore,
  classifyIntent,
  commercialRelevance,
  detectOpportunities,
  rankTrend,
} from "../src/core/keywords/intelligence";
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
  process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  registerAllAgents();
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe("phase 5 — keyword intelligence engine", () => {
  it("classifies intent from observable keyword text", () => {
    expect(classifyIntent("buy running shoes online")).toBe("transactional");
    expect(classifyIntent("best running shoes review")).toBe("commercial");
    expect(classifyIntent("github login")).toBe("navigational");
    expect(classifyIntent("how to train for a marathon")).toBe("informational");
  });

  it("scores commercial relevance and business value from real signals", () => {
    const txIntent = classifyIntent("emergency plumber london price");
    const infoIntent = classifyIntent("what is seo");
    const relevance = commercialRelevance({
      term: "emergency plumber london price",
      intent: txIntent,
      clicks: 40,
      impressions: 900,
      businessCategory: "local-business",
    });
    const lowRelevance = commercialRelevance({
      term: "what is seo", intent: infoIntent, clicks: 1, impressions: 20, businessCategory: "local-business",
    });
    expect(relevance).toBeGreaterThan(lowRelevance);
    expect(relevance).toBeLessThanOrEqual(1);

    const high = businessValueScore({ clicks: 40, impressions: 900, ctr: 0.04, position: 8, intent: txIntent, commercialRelevance: relevance });
    const low = businessValueScore({ clicks: 1, impressions: 20, ctr: 0.05, position: 60, intent: infoIntent, commercialRelevance: lowRelevance });
    expect(high).toBeGreaterThan(low);
    // Volume is not part of the input at all — value is never volume-only.
    expect(high).toBeLessThanOrEqual(100);
  });

  it("detects underserved opportunities from impressions, CTR and position", () => {
    const result = detectOpportunities([
      { keyword: "plumber london", impressions: 800, clicks: 8, ctr: 0.01, position: 9 },
      { keyword: "brand term", impressions: 2000, clicks: 400, ctr: 0.2, position: 1 },
      { keyword: "deep term", impressions: 300, clicks: 0, ctr: 0, position: 80 },
    ]);
    expect(result.map((r) => r.keyword)).toEqual(["plumber london"]);
  });

  it("computes rank trend and associates competitor URLs only from observed data", () => {
    const trend = rankTrend([
      { rank: 12, recordedAt: "2026-01-01" },
      { rank: 7, recordedAt: "2026-01-08" },
    ]);
    expect(trend).toBe(-5);
    expect(rankTrend([{ rank: 3, recordedAt: "2026-01-01" }])).toBeNull();

    const urls = associateCompetitorUrls("emergency plumbing london", [
      { domain: "rival.example", strengths: ["Emergency Plumbing Help"], contentGaps: [] },
      { domain: "unrelated.example", strengths: ["Gardening tips"], contentGaps: [] },
    ]);
    expect(urls).toEqual(["https://rival.example"]);
  });

  it("Bing client reads real query statistics from the documented endpoint", async () => {
    globalThis.fetch = jsonFetch(() => ({
      status: 200,
      body: { d: [{ Query: "plumber london", Clicks: 5, Impressions: 100, AvgClickPosition: 11 }] },
    }));
    const rows = await new BingWebmasterClient({ accessToken: "t" }).getQueryStats("https://plumbing.example");
    expect(rows[0]).toMatchObject({ Query: "plumber london", Clicks: 5, Impressions: 100, AvgClickPosition: 11 });
  });
});

describe("phase 5 — research agent", () => {
  it("skips honestly without connected search engines", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "No GSC", slug: "no-gsc" }).returning())[0];
    const { result } = await runAgent(db, "KEYWORD_INTELLIGENCE_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toMatch(/integration connected/i);
    await close();
  });

  it("stores sourced keywords, value priority, clusters, history and opportunities", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Plumbing", slug: "plumbing", productionUrl: "https://plumbing.example",
      country: "GB", businessCategory: "local-business",
    }).returning())[0];
    await saveIntegration(db, {
      workspaceId, provider: "google_search_console", accessToken: encryptSecret("gsc-token"),
      accountIdentifier: "default", scopes: [],
    });

    globalThis.fetch = jsonFetch((url) => {
      if (url.includes("searchAnalytics")) {
        return {
          status: 200,
          body: {
            rows: [
              { keys: ["emergency plumber london", "https://plumbing.example/emergency", "GB", "MOBILE"], clicks: 30, impressions: 900, ctr: 0.033, position: 8 },
              { keys: ["how to fix a leak", "https://plumbing.example/blog/leaks", "GB", "DESKTOP"], clicks: 2, impressions: 120, ctr: 0.016, position: 22 },
            ],
          },
        };
      }
      return { status: 200, body: {} };
    });

    const { result } = await runAgent(db, "KEYWORD_INTELLIGENCE_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toBeUndefined();
    expect(result.data?.stored).toBe(2);
    expect(result.data?.sources).toContain("google_search_console");
    expect(Number(result.data?.opportunities)).toBeGreaterThan(0);

    const rows = await db.select().from(keywords).where(eq(keywords.projectId, project.id));
    expect(rows).toHaveLength(2);
    const transactional = rows.find((r) => r.keyword === "emergency plumber london")!;
    expect(transactional.intent).toBe("transactional");
    expect(transactional.source).toBe("google_search_console");
    expect(transactional.retrievedAt).not.toBeNull();
    expect(transactional.searchVolume).toBeNull();
    expect(transactional.keywordDifficulty).toBeNull();
    expect(transactional.commercialRelevance).toBeGreaterThan(0);
    expect(transactional.priority).toBeGreaterThan(0);
    expect(transactional.targetUrl).toBe("https://plumbing.example/emergency");

    const info = rows.find((r) => r.keyword === "how to fix a leak")!;
    expect(transactional.priority).toBeGreaterThan(info.priority);

    const clusters = await db.select().from(keywordClusters).where(eq(keywordClusters.projectId, project.id));
    expect(clusters.map((c) => c.name)).toContain("GB-transactional");
    expect(clusters.find((c) => c.name === "GB-transactional")?.targetUrl).toBe("https://plumbing.example/emergency");

    const history = await db.select().from(keywordHistory);
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.source === "keyword_research")).toBe(true);
    await close();
  });
});
