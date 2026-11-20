import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  contentItems, keywordClusters, keywords, projects, competitors, pages, users,
} from "../src/core/db/schema";
import {
  buildBriefFromEvidence, canTransition, checkContentQuality, validateContentItem,
} from "../src/core/content/workflow";
import { registerAllAgents } from "../src/core/agents/definitions";
import { runAgent } from "../src/core/agents/framework";
import { seedIdentity, setupTestDb } from "./helpers";

beforeEach(() => { registerAllAgents(); });

describe("phase 6 — editorial workflow", () => {
  it("enforces the editorial state machine", () => {
    expect(canTransition("idea", "brief")).toBe(true);
    expect(canTransition("brief", "draft")).toBe(true);
    expect(canTransition("draft", "in_review")).toBe(true);
    expect(canTransition("in_review", "approved")).toBe(true);
    expect(canTransition("approved", "published")).toBe(true);
    expect(canTransition("idea", "published")).toBe(false);
    expect(canTransition("published", "draft")).toBe(false);
  });

  it("requires every mandated field before review", () => {
    const missing = validateContentItem({
      status: "in_review",
      title: "Title",
      intent: null,
      clusterId: null,
      audience: null,
      uniqueValueProposition: null,
      supportingResearch: [],
      internalLinkPlan: [],
      proposedUrl: null,
      metaTitle: null,
      metaDescription: null,
      body: null,
    } as never);
    expect(missing).toContain("search intent");
    expect(missing).toContain("target keyword cluster");
    expect(missing).toContain("supporting research");
    expect(missing).toContain("internal linking plan");
    expect(missing).toContain("metadata");
    expect(missing).toContain("body");
  });

  it("rejects fabricated claims, stuffing, thin and duplicate content", () => {
    const good = [
      "A detailed, evidence-led answer about local home maintenance services.",
      "Licensed professionals handle emergencies, routine checks and installations with transparent quotes.",
      "Customers benefit from clear timelines and documented work.",
      "This guide explains what to check before hiring a contractor, how to compare quotes, and what questions to ask.",
      "We cover common faults, preventive measures and seasonal preparation using verifiable information only.",
    ].join(" ").repeat(10);
    const report = checkContentQuality(good, [], null);
    expect(report.passed).toBe(true);
    expect(report.wordCount).toBeGreaterThan(300);

    const fake = checkContentQuality("We are rated 5 star and guaranteed #1 on google. ".repeat(12), [], null);
    expect(fake.fabricatedClaims.length).toBeGreaterThan(0);
    expect(fake.passed).toBe(false);

    const stuffed = checkContentQuality("plumber plumber plumber ".repeat(60), [], "plumber");
    expect(stuffed.keywordDensity).toBeGreaterThan(4);
    expect(stuffed.passed).toBe(false);

    const duplicate = checkContentQuality(good, [good], null);
    expect(duplicate.duplicateRisk).toBeLessThan(0.75);
    expect(duplicate.passed).toBe(false);
  });

  it("builds a brief only from stored evidence, with no invented facts", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Plumbing Co", slug: "plumbing-co", country: "GB",
      description: "Licensed local plumbers in London.", businessCategory: "local-business",
    }).returning())[0];
    const cluster = (await db.insert(keywordClusters).values({
      projectId: project.id, name: "GB-transactional", description: "Observed cluster",
      targetUrl: "https://plumbing.example/emergency",
    }).returning())[0];
    const keyword = (await db.insert(keywords).values({
      projectId: project.id, clusterId: cluster.id, keyword: "emergency plumber london",
      country: "GB", intent: "transactional", source: "google_search_console",
      sourceUrl: "https://search.google.com/gsc", retrievedAt: new Date(),
      targetUrl: "https://plumbing.example/emergency",
    }).returning())[0];
    await db.insert(competitors).values({
      projectId: project.id, domain: "rival.example", contentGaps: ["water heater installation"], strengths: ["Emergency Plumbing Help"],
    });
    await db.insert(pages).values([
      { projectId: project.id, url: "https://plumbing.example/emergency", title: "Emergency", statusCode: 200 },
      { projectId: project.id, url: "https://plumbing.example/about", title: "About", statusCode: 200 },
    ]);

    const brief = buildBriefFromEvidence({
      project,
      keyword,
      cluster,
      competitors: [{ domain: "rival.example", contentGaps: ["water heater installation"], strengths: ["Emergency Plumbing Help"] }],
      pages: [{ url: "https://plumbing.example/emergency", title: "Emergency" }, { url: "https://plumbing.example/about", title: "About" }],
      questionQueries: ["how to choose a plumber"],
    });

    expect(brief.intent).toBe("transactional");
    expect(brief.proposedUrl).toBe("https://plumbing.example/emergency");
    expect(brief.supportingResearch.join(" ")).toMatch(/rival.example|search.google.com/);
    expect(brief.internalLinkPlan).not.toContain("https://plumbing.example/emergency");
    expect((brief.brief as { outline: string[] }).outline).toContain("Answer: how to choose a plumber");
    expect(JSON.stringify(brief)).not.toMatch(/5 star|guaranteed|testimonial/i);
    await close();
  });

  it("content strategy creates evidence-based briefs without an AI provider", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Site", slug: "site", country: "US", description: "A real local service business.",
    }).returning())[0];
    const cluster = (await db.insert(keywordClusters).values({ projectId: project.id, name: "US-informational" }).returning())[0];
    await db.insert(keywords).values({
      projectId: project.id, clusterId: cluster.id, keyword: "how to fix a leak", country: "US",
      intent: "informational", priority: 50, source: "google_search_console", retrievedAt: new Date(),
    });

    const { result } = await runAgent(db, "CONTENT_STRATEGY_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toBeUndefined();
    expect(result.data?.created).toBe(1);

    const items = await db.select().from(contentItems).where(eq(contentItems.projectId, project.id));
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("brief");
    expect(items[0].supportingResearch.length).toBeGreaterThan(0);
    expect(items[0].uniqueValueProposition).toMatch(/registered business description/);
    await close();
  });

  it("content production refuses to fabricate text without AI", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "No AI", slug: "no-ai" }).returning())[0];
    const cluster = (await db.insert(keywordClusters).values({ projectId: project.id, name: "US-informational" }).returning())[0];
    await db.insert(contentItems).values({
      projectId: project.id, clusterId: cluster.id, title: "Approved brief", status: "approved",
      body: null,
    });
    const { result } = await runAgent(db, "CONTENT_PRODUCTION_AGENT", { workspaceId, projectId: project.id, input: {} });
    expect(result.skippedReason).toMatch(/no ai provider/i);
    await close();
  });
});
