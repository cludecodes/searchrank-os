import { eq } from "drizzle-orm";
import { ensureDatabase, getDb } from "../src/core/db/client";
import { jobSchedules, users, workspaceMembers, workspaces } from "../src/core/db/schema";
import { hashPassword } from "../src/core/security/password";
import { registerBuiltinHandlers } from "../src/core/jobs/handlers";

async function main() {
  registerBuiltinHandlers();
  await ensureDatabase();
  const db = getDb();

  const email = process.env.SEED_ADMIN_EMAIL || "admin@searchrank.local";
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.warn("[seed] SEED_ADMIN_PASSWORD is not set — skipping administrator creation.");
  } else {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    let adminId = existing[0]?.id;
    if (!adminId) {
      const created = await db
        .insert(users)
        .values({
          email,
          name: process.env.SEED_ADMIN_NAME || "Platform Administrator",
          passwordHash: await hashPassword(password),
          globalRole: "SUPERADMIN",
        })
        .returning({ id: users.id });
      adminId = created[0].id;
      console.log(`[seed] created administrator ${email}`);
    } else {
      console.log(`[seed] administrator ${email} already exists`);
    }

    const slug = "searchrank-workspace";
    const ws = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    let workspaceId = ws[0]?.id;
    if (!workspaceId) {
      const created = await db
        .insert(workspaces)
        .values({ name: "SEARCHRANK Workspace", slug, ownerId: adminId, settings: {} })
        .returning({ id: workspaces.id });
      workspaceId = created[0].id;
      await db.insert(workspaceMembers).values({ workspaceId, userId: adminId, role: "OWNER" });
      console.log("[seed] created default workspace");
    }

    const defaultSchedules = [
      { name: "uptime-hourly", jobType: "monitoring.uptime", frequency: "hourly", payload: {} },
      { name: "supervisor-daily", jobType: "supervisor.daily", frequency: "daily", payload: {} },
      { name: "audit-daily", jobType: "seo.audit", frequency: "daily", payload: {} },
      { name: "keywords-daily", jobType: "keywords.sync", frequency: "daily", payload: {} },
      { name: "analytics-daily", jobType: "analytics.sync", frequency: "daily", payload: {} },
      { name: "indexing-daily", jobType: "indexing.submit", frequency: "daily", payload: {} },
      { name: "competitors-weekly", jobType: "competitor.monitor", frequency: "weekly", payload: {} },
      { name: "content-weekly", jobType: "content.strategy", frequency: "weekly", payload: {} },
      { name: "report-weekly", jobType: "report.generate", frequency: "weekly", payload: {} },
      { name: "report-monthly", jobType: "report.generate", frequency: "monthly", payload: {} },
    ];
    for (const schedule of defaultSchedules) {
      await db
        .insert(jobSchedules)
        .values({
          workspaceId,
          name: schedule.name,
          jobType: schedule.jobType,
          frequency: schedule.frequency,
          payload: schedule.payload,
          nextRunAt: new Date(Date.now() + 60_000),
        })
        .onConflictDoNothing();
    }
    console.log(`[seed] ensured ${defaultSchedules.length} schedules`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("[seed] failed:", error);
  process.exitCode = 1;
});
