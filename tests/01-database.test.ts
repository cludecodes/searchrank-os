import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects, auditLogs, jobs } from "../src/core/db/schema";
import { seedIdentity, setupTestDb } from "./helpers";

describe("database foundation", () => {
  it("applies every migration to an in-memory Postgres", async () => {
    const { db, close } = await setupTestDb();
    const result = await db.execute<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('users','projects','jobs','keywords','content_items','agent_runs')
      ORDER BY table_name
    `);
    const rows = Array.isArray(result) ? result : (result as { rows: { table_name: string }[] }).rows;
    expect(rows.map((r) => r.table_name)).toEqual([
      "agent_runs", "content_items", "jobs", "keywords", "projects", "users",
    ]);
    await close();
  });

  it("persists a workspace, project and audit log with real relations", async () => {
    const { db, close } = await setupTestDb();
    const { userId, workspaceId } = await seedIdentity(db);
    const created = await db
      .insert(projects)
      .values({ workspaceId, name: "Example", slug: "example", domain: "example.com", productionUrl: "https://example.com" })
      .returning();
    expect(created[0].status).toBe("discovered");
    await db.insert(auditLogs).values({
      workspaceId,
      actorId: userId,
      action: "project.created",
      targetType: "project",
      targetId: created[0].id,
    });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.targetId, created[0].id));
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("project.created");
    await close();
  });

  it("enforces project slug uniqueness per workspace", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const values = { workspaceId, name: "Same", slug: "same" };
    await db.insert(projects).values(values);
    await expect(db.insert(projects).values(values)).rejects.toThrow();
    await close();
  });

  it("stores job payloads as queryable JSONB", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const inserted = await db
      .insert(jobs)
      .values({ workspaceId, type: "seo.audit", payload: { url: "https://example.com", deep: true } })
      .returning();
    expect(inserted[0].payload).toEqual({ url: "https://example.com", deep: true });
    await close();
  });
});
