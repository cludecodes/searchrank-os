import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, approvals, contentItems, keywords, projects, type Project } from "../src/core/db/schema";
import { registerAllAgents } from "../src/core/agents/definitions";
import { getAgent, listAgents, runAgent } from "../src/core/agents/framework";
import { enqueueJob } from "../src/core/jobs/queue";
import type { AIProvider, AICompletionRequest } from "../src/core/ai/provider";
import { seedIdentity, setupTestDb } from "./helpers";

const mockAI: AIProvider = {
  name: "test-mock",
  async complete(request: AICompletionRequest) {
    let parsed: { keywords?: Array<{ id: string }> } = {};
    for (const message of request.messages) {
      try {
        const candidate = JSON.parse(message.content) as { keywords?: Array<{ id: string }> };
        if (candidate.keywords) { parsed = candidate; break; }
      } catch { /* ignore non-JSON messages */ }
    }
    const keywordId = parsed.keywords?.[0]?.id ?? "none";
    return {
      text: JSON.stringify({
        briefs: [{
          keywordId,
          title: "How to choose a reliable local plumber",
          proposedUrl: "/guides/choose-plumber",
          audience: "Homeowners needing urgent repairs",
          uniqueValueProposition: "A transparent, experience-led checklist grounded in real trade criteria.",
          outline: ["Assess the problem", "Check credentials", "Compare quotes"],
          internalLinks: ["/services", "/contact"],
        }],
      }),
      model: "mock-1",
      provider: this.name,
    };
  },
};

beforeAll(() => {
  registerAllAgents();
});

describe("AI agent workforce", () => {
  it("registers all twelve agents with distinct missions", () => {
    expect(listAgents()).toHaveLength(12);
    expect(getAgent("TECHNICAL_SEO_AGENT")?.mission).toMatch(/audit/i);
    expect(getAgent("QUALITY_SECURITY_AGENT")?.canMutateProduction).toBe(false);
    expect(getAgent("DEVELOPER_AGENT")?.canMutateProduction).toBe(true);
  });

  it("supervisor queues real audit jobs per active project", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(projects).values([
      { workspaceId, name: "Active", slug: "active", productionUrl: "https://active.example", status: "active" },
      { workspaceId, name: "Idle", slug: "idle", productionUrl: "https://idle.example", status: "discovered" },
    ]);
    const { result, runId } = await runAgent(db, "CHIEF_SUPERVISOR", { workspaceId, input: {} });
    expect(result.summary).toMatch(/queued 1 audit job/);
    const run = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run[0].status).toBe("succeeded");
    const queued = await enqueueJob(db, { workspaceId, type: "noop" });
    expect(queued.type).toBe("noop");
    await close();
  });

  it("creates evidence-based briefs only from stored keywords", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Plumbing", slug: "plumbing", domain: "plumbing.example" }).returning())[0];
    const keyword = (await db.insert(keywords).values({ projectId: project.id, keyword: "emergency plumber london", country: "GB", priority: 10, source: "google_search_console" }).returning())[0];
    const { result } = await runAgent(db, "CONTENT_STRATEGY_AGENT", {
      workspaceId,
      projectId: project.id,
      ai: mockAI,
      input: {},
    });
    expect(result.summary).toMatch(/Created 1 content brief/);
    const items = await db.select().from(contentItems).where(eq(contentItems.projectId, project.id));
    expect(items[0].targetKeywordId).toBe(keyword.id);
    expect(items[0].status).toBe("brief");
    await close();
  });

  it("skips gracefully when no data source exists instead of inventing data", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Empty", slug: "empty" }).returning())[0] as Project;
    const { result } = await runAgent(db, "KEYWORD_INTELLIGENCE_AGENT", {
      workspaceId,
      projectId: project.id,
      ai: mockAI,
      input: {},
    });
    expect(result.skippedReason).toMatch(/not connected/i);
    await close();
  });

  it("developer agent requests approval before touching a repository", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Repo", slug: "repo", repositoryFullName: "org/repo", status: "active",
    }).returning())[0];
    const { result } = await runAgent(db, "DEVELOPER_AGENT", {
      workspaceId,
      projectId: project.id,
      ai: mockAI,
      input: { changes: [{ path: "src/app/page.tsx", content: "// change" }] },
    });
    expect(result.requiresApproval).toBe(true);
    const pending = await db.select().from(approvals).where(eq(approvals.workspaceId, workspaceId));
    expect(pending[0].actionType).toBe("code_change");
    expect(pending[0].status).toBe("pending");
    await close();
  });

  it("quality agent flags fabricated claims in review content", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Claims", slug: "claims" }).returning())[0];
    await db.insert(contentItems).values({
      projectId: project.id,
      title: "#1 on Google guaranteed",
      body: "We are rated 5-star by thousands of delighted customers.",
      status: "in_review",
    });
    const { result } = await runAgent(db, "QUALITY_SECURITY_AGENT", { workspaceId, projectId: project.id, ai: mockAI, input: {} });
    expect(result.data?.flagged).toHaveLength(1);
    expect(JSON.stringify(result.data?.flagged)).toMatch(/Prohibited claim/);
    await close();
  });
});
