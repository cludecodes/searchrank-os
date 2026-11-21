import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLogs, approvals, projects, users } from "../db/schema";

export interface BackupManifest {
  generatedAt: string;
  database: string;
  tables: Array<{ name: string; rows: number }>;
  note: string;
}

const TABLES = [
  "users", "workspaces", "workspace_members", "sessions", "integrations", "projects",
  "seo_audits", "pages", "link_checks", "seo_artifacts", "code_pipelines", "keywords",
  "keyword_clusters", "keyword_history", "competitors", "content_items", "backlink_opportunities",
  "indexing_submissions", "monitoring_checks", "search_metrics", "deployments", "agent_runs",
  "approvals", "reports", "jobs", "job_logs", "job_schedules", "growth_opportunities",
  "conversions", "rate_limits", "audit_logs",
];

/** Counts rows per table for a backup manifest. No data leaves the database. */
export async function getBackupManifest(db: Database): Promise<BackupManifest> {
  const tables: Array<{ name: string; rows: number }> = [];
  for (const name of TABLES) {
    try {
      const result = await db.execute<{ count: string }>(
        sql.raw(`SELECT count(*)::text AS count FROM "${name}"`),
      );
      const rows = Array.isArray(result) ? result : (result as { rows: Array<{ count: string }> }).rows;
      tables.push({ name, rows: Number(rows[0]?.count ?? 0) });
    } catch {
      tables.push({ name, rows: 0 });
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    database: process.env.DATABASE_URL ? "neon" : "pglite",
    tables,
    note: "Counts only. Full dumps must be produced by pg_dump against the live database.",
  };
}

export interface SecurityAudit {
  generatedAt: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  overall: boolean;
}

/** Checks observable security posture from persisted state and env. */
export async function runSecurityAudit(db: Database): Promise<SecurityAudit> {
  const checks: SecurityAudit["checks"] = [];
  const masterKey = process.env.MASTER_ENCRYPTION_KEY?.trim();
  checks.push({
    name: "Master encryption key configured",
    passed: Boolean(masterKey) && masterKey!.length >= 40,
    detail: masterKey ? "Configured (value hidden)" : "Missing — running with development fallback",
  });

  const [adminCount] = await db.select({ value: sql<number>`count(*)::int` })
    .from(users).where(eq(users.globalRole, "SUPERADMIN"));
  checks.push({
    name: "Superadmin exists",
    passed: Number(adminCount?.value ?? 0) > 0,
    detail: `${adminCount?.value ?? 0} superadmin account(s)`,
  });

  const [pendingCritical] = await db.select({ value: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.status, "pending"), eq(approvals.risk, "critical")));
  checks.push({
    name: "Critical approvals reviewed",
    passed: Number(pendingCritical?.value ?? 0) === 0,
    detail: `${pendingCritical?.value ?? 0} pending critical approval(s)`,
  });

  const recentAuth = await db.select({ action: auditLogs.action, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, new Date(Date.now() - 30 * 86_400_000)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(100);
  checks.push({
    name: "Audit trail active",
    passed: recentAuth.length > 0,
    detail: `${recentAuth.length} audit event(s) in the last 30 days`,
  });

  const [projectsWithoutOwner] = await db.select({ value: sql<number>`count(*)::int` })
    .from(projects)
    .where(sql`${projects.workspaceId} IS NULL`);
  checks.push({
    name: "Projects scoped to workspaces",
    passed: Number(projectsWithoutOwner?.value ?? 0) === 0,
    detail: `${projectsWithoutOwner?.value ?? 0} unscoped project(s)`,
  });

  return {
    generatedAt: new Date().toISOString(),
    checks,
    overall: checks.every((check) => check.passed),
  };
}

