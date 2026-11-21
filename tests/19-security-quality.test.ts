import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, auditLogs, projects, users } from "../src/core/db/schema";
import { getBackupManifest, runSecurityAudit } from "../src/core/security/backup";
import { seedIdentity, setupTestDb } from "./helpers";

describe("phase 12 — security and quality", () => {
  const originalKey = process.env.MASTER_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = "a-base64-encoded-32-byte-master-key-value-123456";
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = originalKey;
  });

  it("produces a backup manifest with row counts for every domain", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(projects).values({ workspaceId, name: "Backup", slug: "backup" });
    const manifest = await getBackupManifest(db);
    expect(manifest.tables.length).toBeGreaterThan(25);
    expect(manifest.tables.find((t) => t.name === "users")?.rows).toBeGreaterThanOrEqual(1);
    expect(manifest.tables.find((t) => t.name === "projects")?.rows).toBe(1);
    expect(manifest.note).toMatch(/pg_dump/);
    await close();
  });

  it("audits encryption, admin accounts, approvals and audit trail", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId, userId } = await seedIdentity(db);
    await db.update(users).set({ globalRole: "SUPERADMIN" }).where(eq(users.id, userId));
    await db.insert(auditLogs).values({ workspaceId, actorId: userId, action: "auth.login" });

    const audit = await runSecurityAudit(db);
    expect(audit.checks.find((c) => c.name === "Master encryption key configured")?.passed).toBe(true);
    expect(audit.checks.find((c) => c.name === "Superadmin exists")?.passed).toBe(true);
    expect(audit.checks.find((c) => c.name === "Audit trail active")?.passed).toBe(true);
    expect(audit.checks.find((c) => c.name === "Projects scoped to workspaces")?.passed).toBe(true);
    await close();
  });

  it("flags pending critical approvals and missing encryption key", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    await db.insert(approvals).values({
      workspaceId,
      actionType: "merge_deployment",
      description: "merge",
      risk: "critical",
      status: "pending",
    });
    delete process.env.MASTER_ENCRYPTION_KEY;

    const audit = await runSecurityAudit(db);
    expect(audit.checks.find((c) => c.name === "Critical approvals reviewed")?.passed).toBe(false);
    expect(audit.checks.find((c) => c.name === "Master encryption key configured")?.passed).toBe(false);
    expect(audit.overall).toBe(false);
    await close();
  });
});
