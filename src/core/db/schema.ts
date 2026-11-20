/**
 * SEARCHRANK OS — canonical Postgres schema.
 *
 * This file is the single source of truth for both local PGlite and remote
 * Neon databases. All timestamps are timestamptz; all identifiers are UUIDs.
 * Status/limit fields are text with typed unions rather than PG enums so that
 * adding a state never requires a destructive migration.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

// ─── Shared unions ────────────────────────────────────────────────────────
export type GlobalRole = "SUPERADMIN" | "USER";
export type WorkspaceRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
export type IntegrationProvider =
  | "github"
  | "vercel"
  | "google_search_console"
  | "bing_webmaster";
export type IntegrationStatus = "connected" | "expired" | "revoked" | "error";
export type ProjectStatus = "discovered" | "active" | "archived" | "error";
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type JobPriority = "low" | "normal" | "high" | "critical";
export type AuditStatus = "pending" | "running" | "completed" | "failed";
export type SearchIntent = "informational" | "navigational" | "transactional" | "commercial";
export type ContentStatus =
  | "idea"
  | "brief"
  | "draft"
  | "in_review"
  | "approved"
  | "published"
  | "rejected";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalRisk = "low" | "medium" | "high" | "critical";

type Json = Record<string, unknown>;

// ─── Identity ─────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    globalRole: text("global_role").$type<GlobalRole>().notNull().default("USER"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    settings: jsonb("settings").$type<Json>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspaces_slug_unique").on(t.slug)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull().default("VIEWER"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_unique").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bucket: text("bucket").notNull(),
    subject: text("subject").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(1),
  },
  (t) => [uniqueIndex("rate_limits_unique").on(t.bucket, t.subject, t.windowStart)],
);

// ─── Integrations & projects ──────────────────────────────────────────────
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IntegrationProvider>().notNull(),
    accountIdentifier: text("account_identifier"),
    displayName: text("display_name"),
    encryptedAccessToken: text("encrypted_access_token"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").$type<IntegrationStatus>().notNull().default("connected"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("integrations_provider_account_unique").on(t.workspaceId, t.provider, t.accountIdentifier),
    index("integrations_workspace_idx").on(t.workspaceId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    domain: text("domain"),
    productionUrl: text("production_url"),
    repositoryFullName: text("repository_full_name"),
    repositoryId: text("repository_id"),
    vercelProjectId: text("vercel_project_id"),
    framework: text("framework"),
    description: text("description"),
    businessCategory: text("business_category"),
    country: text("country").notNull().default("US"),
    language: text("language").notNull().default("en"),
    currency: text("currency").notNull().default("USD"),
    status: text("status").$type<ProjectStatus>().notNull().default("discovered"),
    isPreview: boolean("is_preview").notNull().default(false),
    isDuplicateDomain: boolean("is_duplicate_domain").notNull().default(false),
    seoConfig: jsonb("seo_config").$type<Json>().notNull().default({}),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    discoveredBy: text("discovered_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("projects_workspace_slug_unique").on(t.workspaceId, t.slug),
    index("projects_domain_idx").on(t.domain),
    index("projects_workspace_idx").on(t.workspaceId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_workspace_idx").on(t.workspaceId), index("audit_logs_created_idx").on(t.createdAt)],
);

// ─── Jobs ─────────────────────────────────────────────────────────────────
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Json>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    priority: text("priority").$type<JobPriority>().notNull().default("normal"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    result: jsonb("result").$type<Json>(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_status_run_idx").on(t.status, t.runAt),
    index("jobs_workspace_idx").on(t.workspaceId),
    index("jobs_project_idx").on(t.projectId),
  ],
);

export const jobLogs = pgTable(
  "job_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_logs_job_idx").on(t.jobId)],
);

export const jobSchedules = pgTable(
  "job_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").$type<Json>().notNull().default({}),
    frequency: text("frequency").notNull(), // hourly | daily | weekly | monthly
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("job_schedules_name_unique").on(t.workspaceId, t.name)],
);

// ─── SEO domain ───────────────────────────────────────────────────────────
export const seoAudits = pgTable(
  "seo_audits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status").$type<AuditStatus>().notNull().default("pending"),
    score: integer("score"),
    findings: jsonb("findings").$type<Json>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seo_audits_project_idx").on(t.projectId, t.createdAt)],
);

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    statusCode: integer("status_code"),
    title: text("title"),
    metaDescription: text("meta_description"),
    canonicalUrl: text("canonical_url"),
    h1: text("h1"),
    wordCount: integer("word_count"),
    hasStructuredData: boolean("has_structured_data").notNull().default(false),
    contentHash: text("content_hash"),
    isOrphan: boolean("is_orphan").notNull().default(false),
    lastAuditedAt: timestamp("last_audited_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pages_project_url_unique").on(t.projectId, t.url)],
);

export const linkChecks = pgTable(
  "link_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => seoAudits.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    targetUrl: text("target_url").notNull(),
    kind: text("kind").notNull(), // internal | external
    statusCode: integer("status_code"),
    isBroken: boolean("is_broken").notNull().default(false),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("link_checks_audit_idx").on(t.auditId)],
);

export const indexingSubmissions = pgTable(
  "indexing_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    engine: text("engine").notNull(), // indexnow-bing | indexnow-yandex | google | bing
    url: text("url").notNull(),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    responseBody: text("response_body"),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("indexing_submissions_project_idx").on(t.projectId, t.submittedAt)],
);

export const monitoringChecks = pgTable(
  "monitoring_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // uptime | deployment | sitemap | robots
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    detail: jsonb("detail").$type<Json>().notNull().default({}),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("monitoring_checks_project_idx").on(t.projectId, t.checkedAt)],
);

// ─── Keyword & competitor intelligence ───────────────────────────────────
export const keywordClusters = pgTable(
  "keyword_clusters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    targetUrl: text("target_url"),
    createdByAgent: text("created_by_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("keyword_clusters_project_name_unique").on(t.projectId, t.name)],
);

export const keywords = pgTable(
  "keywords",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").references(() => keywordClusters.id, { onDelete: "set null" }),
    keyword: text("keyword").notNull(),
    country: text("country").notNull().default("US"),
    language: text("language").notNull().default("en"),
    intent: text("intent").$type<SearchIntent>(),
    searchVolume: integer("search_volume"),
    keywordDifficulty: real("keyword_difficulty"),
    commercialRelevance: real("commercial_relevance"),
    competitorUrls: jsonb("competitor_urls").$type<string[]>().notNull().default([]),
    targetUrl: text("target_url"),
    priority: integer("priority").notNull().default(0),
    currentRank: real("current_rank"),
    source: text("source"),
    sourceUrl: text("source_url"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("keywords_project_keyword_country_unique").on(t.projectId, t.keyword, t.country),
    index("keywords_project_idx").on(t.projectId),
  ],
);

export const keywordHistory = pgTable(
  "keyword_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    keywordId: uuid("keyword_id")
      .notNull()
      .references(() => keywords.id, { onDelete: "cascade" }),
    rank: real("rank"),
    clicks: integer("clicks"),
    impressions: integer("impressions"),
    ctr: real("ctr"),
    source: text("source").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("keyword_history_keyword_idx").on(t.keywordId, t.recordedAt)],
);

export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name"),
    notes: text("notes"),
    strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
    weaknesses: jsonb("weaknesses").$type<string[]>().notNull().default([]),
    contentGaps: jsonb("content_gaps").$type<string[]>().notNull().default([]),
    lastAnalyzedAt: timestamp("last_analyzed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("competitors_project_domain_unique").on(t.projectId, t.domain)],
);

// ─── Content & authority ──────────────────────────────────────────────────
export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").references(() => keywordClusters.id, { onDelete: "set null" }),
    targetKeywordId: uuid("target_keyword_id").references(() => keywords.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    proposedUrl: text("proposed_url"),
    intent: text("intent").$type<SearchIntent>(),
    audience: text("audience"),
    uniqueValueProposition: text("unique_value_proposition"),
    brief: jsonb("brief").$type<Json>().notNull().default({}),
    supportingResearch: jsonb("supporting_research").$type<string[]>().notNull().default([]),
    internalLinkPlan: jsonb("internal_link_plan").$type<string[]>().notNull().default([]),
    body: text("body"),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    status: text("status").$type<ContentStatus>().notNull().default("idea"),
    originalityScore: real("originality_score"),
    createdByAgent: text("created_by_agent"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("content_items_project_idx").on(t.projectId, t.status)],
);

export const backlinkOpportunities = pgTable(
  "backlink_opportunities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    url: text("url"),
    opportunityType: text("opportunity_type"), // directory | publication | partnership | referral
    rationale: text("rationale"),
    status: text("status").notNull().default("identified"),
    outreachNote: text("outreach_note"),
    isPaidScheme: boolean("is_paid_scheme").notNull().default(false),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("backlink_opportunities_project_idx").on(t.projectId)],
);

// ─── Analytics ────────────────────────────────────────────────────────────
export const searchMetrics = pgTable(
  "search_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // google_search_console | bing_webmaster
    date: date("date").notNull(),
    query: text("query"),
    page: text("page"),
    country: text("country"),
    device: text("device"),
    clicks: integer("clicks").notNull().default(0),
    impressions: integer("impressions").notNull().default(0),
    ctr: real("ctr"),
    position: real("position"),
    conversions: integer("conversions").notNull().default(0),
    revenue: real("revenue"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("search_metrics_unique").on(t.projectId, t.source, t.date, t.query, t.page, t.country, t.device),
    index("search_metrics_project_date_idx").on(t.projectId, t.date),
  ],
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("vercel"),
    deploymentId: text("deployment_id").notNull(),
    url: text("url"),
    state: text("state"),
    isPreview: boolean("is_preview").notNull().default(false),
    commitSha: text("commit_sha"),
    metadata: jsonb("metadata").$type<Json>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("deployments_provider_id_unique").on(t.provider, t.deploymentId)],
);

// ─── Agents, approvals, reports ───────────────────────────────────────────
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    agentKey: text("agent_key").notNull(),
    status: text("status").notNull().default("running"),
    input: jsonb("input").$type<Json>().notNull().default({}),
    output: jsonb("output").$type<Json>().notNull().default({}),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_agent_idx").on(t.agentKey, t.startedAt)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    requestedByAgent: text("requested_by_agent"),
    actionType: text("action_type").notNull(),
    description: text("description").notNull(),
    payload: jsonb("payload").$type<Json>().notNull().default({}),
    risk: text("risk").$type<ApprovalRisk>().notNull().default("medium"),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("approvals_workspace_status_idx").on(t.workspaceId, t.status)],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // executive | weekly | monthly | project
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    data: jsonb("data").$type<Json>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reports_workspace_idx").on(t.workspaceId, t.periodEnd)],
);

// ─── Inferred types ───────────────────────────────────────────────────────
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type Workspace = InferSelectModel<typeof workspaces>;
export type NewWorkspace = InferInsertModel<typeof workspaces>;
export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;
export type Integration = InferSelectModel<typeof integrations>;
export type NewIntegration = InferInsertModel<typeof integrations>;
export type Job = InferSelectModel<typeof jobs>;
export type NewJob = InferInsertModel<typeof jobs>;
export type AgentRun = InferSelectModel<typeof agentRuns>;
export type Keyword = InferSelectModel<typeof keywords>;
export type ContentItem = InferSelectModel<typeof contentItems>;
export type SeoAudit = InferSelectModel<typeof seoAudits>;
