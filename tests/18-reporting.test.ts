import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  conversions, jobs, monitoringChecks, projects, reports, searchMetrics, seoAudits,
} from "../src/core/db/schema";
import { buildExecutiveReport, generateAndStoreReport } from "../src/core/reporting/executive-reports";
import { seedIdentity, setupTestDb } from "./helpers";

describe("phase 11 — executive reporting", () => {
  it("reports honest zeros when no activity exists", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const report = await buildExecutiveReport(db, workspaceId);
    expect(report.workCompleted).toMatchObject({ jobsSucceeded: 0, audits: 0, contentPublished: 0 });
    expect(report.movements.clicks).toBe(0);
    expect(report.conversions).toMatchObject({ leads: 0, qualified: 0, revenue: 0 });
    expect(report.nextActions.length).toBeGreaterThan(0);
    expect(report.note).toMatch(/No rankings, traffic or revenue are fabricated/);
    await close();
  });

  it("aggregates work, issues, movements and conversions from real rows", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Report Site", slug: "report" }).returning())[0];
    const today = new Date().toISOString().slice(0, 10);

    await db.insert(jobs).values([
      { workspaceId, projectId: project.id, type: "seo.audit", status: "succeeded" },
      { workspaceId, projectId: project.id, type: "seo.audit", status: "failed" },
    ]);
    await db.insert(seoAudits).values({ projectId: project.id, score: 80, status: "completed", findings: {} });
    await db.insert(monitoringChecks).values({ projectId: project.id, kind: "uptime", status: "down" });
    await db.insert(searchMetrics).values([
      { projectId: project.id, source: "google_search_console", date: today, query: "a", page: "/", clicks: 10, impressions: 200, position: 2 },
      { projectId: project.id, source: "google_search_console", date: today, query: "b", page: "/", clicks: 5, impressions: 100, position: 8 },
    ]);
    await db.insert(conversions).values({
      projectId: project.id, kind: "lead", qualified: true, revenue: 120,
    });

    const report = await buildExecutiveReport(db, workspaceId);
    expect(report.workCompleted.jobsSucceeded).toBe(1);
    expect(report.issuesDiscovered.jobsFailed).toBe(1);
    expect(report.issuesDiscovered.monitoringIssues).toBe(1);
    expect(report.movements).toMatchObject({ clicks: 15, impressions: 300, top3: 1, top10: 2 });
    expect(report.conversions).toMatchObject({ leads: 1, qualified: 1, revenue: 120 });
    expect(report.nextActions.join(" ")).toMatch(/Investigate|Resolve/);
    await close();
  });

  it("stores reports with the full persisted payload", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const result = await generateAndStoreReport(db, workspaceId, { days: 14 });
    const rows = await db.select().from(reports).where(eq(reports.id, result.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("executive");
    expect(rows[0].data).toHaveProperty("movements");
    expect(rows[0].data).toHaveProperty("nextActions");
    expect(rows[0].periodStart).toBe(result.report.periodStart);
    await close();
  });
});
