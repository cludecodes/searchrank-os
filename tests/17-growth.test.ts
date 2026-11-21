import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  backlinkOpportunities, competitors, conversions, growthOpportunities, keywords, projects, searchMetrics,
} from "../src/core/db/schema";
import { buildGrowthPlan, collectEvidence, getGrowthMetrics, recordConversion } from "../src/core/growth/engine";
import { seedIdentity, setupTestDb } from "./helpers";

describe("phase 10 — business growth engine", () => {
  it("collects evidence only from persisted rows", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Growth", slug: "growth" }).returning())[0];
    await db.insert(keywords).values({
      projectId: project.id, keyword: "best running shoes", country: "US",
      intent: "commercial", priority: 40, commercialRelevance: 0.8, currentRank: 9,
    });
    await db.insert(competitors).values({
      projectId: project.id, domain: "rival.example", contentGaps: ["waterproof options"],
    });
    await db.insert(backlinkOpportunities).values({
      projectId: project.id, domain: "dir.example", opportunityType: "directory",
    });
    await db.insert(searchMetrics).values({
      projectId: project.id, source: "google_search_console", date: "2026-01-01",
      query: "how to choose running shoes", page: "/", clicks: 5, impressions: 100,
    });

    const evidence = await collectEvidence(db, project.id);
    expect(evidence?.keywords[0].keyword).toBe("best running shoes");
    expect(evidence?.gaps).toContain("waterproof options");
    expect(evidence?.referrals[0].domain).toBe("dir.example");
    expect(evidence?.questions).toContain("how to choose running shoes");
    await close();
  });

  it("builds a deterministic plan with buyer intent and revenue-oriented opportunities", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Growth", slug: "growth" }).returning())[0];
    await db.insert(keywords).values({
      projectId: project.id, keyword: "buy waterproof running shoes", country: "US",
      intent: "transactional", priority: 60, commercialRelevance: 0.9, currentRank: 7,
    });
    await db.insert(competitors).values({ projectId: project.id, domain: "rival.example", contentGaps: ["durability guide"] });

    const first = await buildGrowthPlan(db, project.id);
    expect(first.created).toBeGreaterThan(0);
    const rows = await db.select().from(growthOpportunities).where(eq(growthOpportunities.projectId, project.id));
    expect(rows.length).toBe(first.created);
    const conversion = rows.find((r) => r.conversionOpportunity) ?? rows[0];
    expect(conversion.buyerIntent).toBe("transactional");
    expect(conversion.evidence).toHaveProperty("source");
    expect(conversion.score).toBeGreaterThan(0);

    const second = await buildGrowthPlan(db, project.id);
    expect(second.created).toBe(0);
    await close();
  });

  it("measures leads and revenue from recorded conversions only", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Sales", slug: "sales" }).returning())[0];

    const before = await getGrowthMetrics(db, project.id);
    expect(before).toMatchObject({ leads: 0, qualified: 0, sales: 0, revenue: 0 });

    await recordConversion(db, {
      projectId: project.id, kind: "lead", qualified: true, landingPage: "/pricing", keyword: "buy shoes",
    });
    await recordConversion(db, {
      projectId: project.id, kind: "sale", revenue: 250, landingPage: "/pricing", keyword: "buy shoes",
    });

    const after = await getGrowthMetrics(db, project.id);
    expect(after).toMatchObject({ leads: 1, qualified: 1, sales: 1, revenue: 250 });
    expect(after.byLanding[0]).toMatchObject({ landingPage: "/pricing", leads: 2, revenue: 250 });
    expect(after.note).toMatch(/Nothing is estimated/);
    await close();
  });

  it("returns no plan for a missing project", async () => {
    const { db, close } = await setupTestDb();
    const result = await buildGrowthPlan(db, "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ created: 0, evidence: null });
    await close();
  });
});
