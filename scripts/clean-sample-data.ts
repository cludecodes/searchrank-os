import { getDb } from "../src/core/db/client";

/** Removes every sample/demo row produced during development smoke tests.
 *  Keeps identity, workspaces, memberships and schedules so the platform is
 *  immediately usable with real data. */
const SAMPLE_TABLES = [
  "code_pipelines",
  "seo_artifacts",
  "link_checks",
  "seo_audits",
  "pages",
  "indexing_submissions",
  "monitoring_checks",
  "keyword_history",
  "keywords",
  "keyword_clusters",
  "competitors",
  "content_items",
  "backlink_opportunities",
  "search_metrics",
  "deployments",
  "reports",
  "agent_runs",
  "approvals",
  "job_logs",
  "jobs",
  "audit_logs",
  "rate_limits",
];

async function main() {
  const db = getDb();
  const statement = `TRUNCATE TABLE ${SAMPLE_TABLES.join(", ")} RESTART IDENTITY CASCADE`;
  await db.execute(statement);
  console.log(`[clean] removed sample data from ${SAMPLE_TABLES.length} tables`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[clean] failed:", error);
  process.exitCode = 1;
});
