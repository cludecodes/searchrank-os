import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { getAIProvider } from "../ai/provider";
import { OAUTH_PROVIDERS } from "../integrations/oauth";
import { listAgents } from "../agents/framework";
import { registerBuiltinHandlers } from "../jobs/handlers";
import {
  agentRuns, approvals, auditLogs, backlinkOpportunities, competitors, contentItems,
  indexingSubmissions, integrations, jobSchedules, keywords, projects,
  reports, searchMetrics, seoAudits,
} from "../db/schema";

export interface SectionData {
  title: string;
  subtitle: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  notes: string[];
}

const fmt = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 16).replace("T", " ");
  if (typeof value === "object") return JSON.stringify(value).slice(0, 180);
  return String(value);
};

function empty(title: string, subtitle: string, columns: string[], note: string): SectionData {
  return { title, subtitle, columns, rows: [], notes: [note] };
}

export async function getSectionData(db: Database, workspaceId: string, section: string): Promise<SectionData> {
  const projectFilter = eq(projects.workspaceId, workspaceId);

  switch (section) {
    case "projects": {
      const list = await db.select().from(projects).where(projectFilter).orderBy(desc(projects.updatedAt));
      return {
        title: "Projects Portfolio",
        subtitle: `${list.length} registered project(s) from discovery or manual registration.`,
        columns: ["Name", "Domain", "Production URL", "Repository", "Framework", "Status", "Source", "Updated"],
        rows: list.map((p) => ({ Name: p.name, Domain: fmt(p.domain), "Production URL": fmt(p.productionUrl), Repository: fmt(p.repositoryFullName), Framework: fmt(p.framework), Status: p.status, Source: fmt(p.discoveredBy), Updated: fmt(p.updatedAt) })),
        notes: ["Private repositories are never imported. Preview deployments are flagged separately."],
      };
    }
    case "github":
    case "vercel": {
      const provider = section === "github" ? "github" : "vercel";
      const connected = await db.select().from(integrations).where(eq(integrations.workspaceId, workspaceId));
      const list = await db.select().from(projects).where(projectFilter);
      const relevant = provider === "github"
        ? list.filter((p) => p.repositoryFullName)
        : list.filter((p) => p.vercelProjectId);
      return {
        title: provider === "github" ? "GitHub Connections" : "Vercel Connections",
        subtitle: "OAuth credentials are encrypted at rest with AES-256-GCM.",
        columns: ["Name", "Repository / Project", "Linked domain", "Connection"],
        rows: relevant.map((p) => ({
          Name: p.name,
          "Repository / Project": provider === "github" ? fmt(p.repositoryFullName) : fmt(p.vercelProjectId),
          "Linked domain": fmt(p.domain),
          Connection: connected.find((i) => i.provider === provider)?.status ?? "Not connected",
        })),
        notes: [OAUTH_PROVIDERS[provider].isConfigured() ? "OAuth app credentials detected in the environment." : "OAuth app credentials are not configured in the environment."],
      };
    }
    case "audits": {
      const list = await db.select({ audit: seoAudits, projectName: projects.name })
        .from(seoAudits).innerJoin(projects, eq(seoAudits.projectId, projects.id))
        .where(projectFilter).orderBy(desc(seoAudits.createdAt)).limit(100);
      return {
        title: "SEO Audits",
        subtitle: "Scores are deductions from observed HTML/HTTP checks, not invented ratings.",
        columns: ["Project", "Score", "Status", "Findings", "Executed"],
        rows: list.map((r) => ({
          Project: r.projectName,
          Score: r.audit.score === null ? "—" : `${r.audit.score}/100`,
          Status: r.audit.status,
          Findings: fmt(Object.keys(r.audit.findings).length),
          Executed: fmt(r.audit.finishedAt),
        })),
        notes: ["Core Web Vitals require field data from an authorized provider and are never inferred from HTML."],
      };
    }
    case "keywords": {
      const list = await db.select({ keyword: keywords, projectName: projects.name })
        .from(keywords).innerJoin(projects, eq(keywords.projectId, projects.id))
        .where(projectFilter).orderBy(desc(keywords.priority)).limit(200);
      return {
        title: "Keyword Intelligence",
        subtitle: `${list.length} keyword record(s), each with a source and retrieval date.`,
        columns: ["Keyword", "Project", "Country", "Intent", "Volume", "Rank", "Priority", "Source", "Retrieved"],
        rows: list.map((r) => ({
          Keyword: r.keyword.keyword, Project: r.projectName, Country: r.keyword.country,
          Intent: fmt(r.keyword.intent), Volume: fmt(r.keyword.searchVolume),
          Rank: fmt(r.keyword.currentRank), Priority: fmt(r.keyword.priority),
          Source: fmt(r.keyword.source), Retrieved: fmt(r.keyword.retrievedAt),
        })),
        notes: ["Missing volume/difficulty means the connected provider did not supply it. No statistics are fabricated."],
      };
    }
    case "competitors": {
      const list = await db.select({ competitor: competitors, projectName: projects.name })
        .from(competitors).innerJoin(projects, eq(competitors.projectId, projects.id))
        .where(projectFilter).orderBy(desc(competitors.createdAt));
      return {
        title: "Competitor Research",
        subtitle: `${list.length} registered competitor(s).`,
        columns: ["Domain", "Project", "Name", "Analyzed", "Notes"],
        rows: list.map((r) => ({ Domain: r.competitor.domain, Project: r.projectName, Name: fmt(r.competitor.name), Analyzed: fmt(r.competitor.lastAnalyzedAt), Notes: fmt(r.competitor.notes) })),
        notes: [],
      };
    }
    case "content": {
      const list = await db.select({ item: contentItems, projectName: projects.name })
        .from(contentItems).innerJoin(projects, eq(contentItems.projectId, projects.id))
        .where(projectFilter).orderBy(desc(contentItems.updatedAt)).limit(200);
      return {
        title: "Content Studio",
        subtitle: `${list.length} content item(s) in the editorial pipeline.`,
        columns: ["Title", "Project", "Intent", "Status", "Proposed URL", "Originality", "Updated"],
        rows: list.map((r) => ({
          Title: r.item.title, Project: r.projectName, Intent: fmt(r.item.intent), Status: r.item.status,
          "Proposed URL": fmt(r.item.proposedUrl), Originality: fmt(r.item.originalityScore), Updated: fmt(r.item.updatedAt),
        })),
        notes: ["Drafts require human review before publishing. Prohibited claims are flagged by the Quality & Security Agent."],
      };
    }
    case "backlinks": {
      const list = await db.select({ opportunity: backlinkOpportunities, projectName: projects.name })
        .from(backlinkOpportunities).innerJoin(projects, eq(backlinkOpportunities.projectId, projects.id))
        .where(projectFilter).orderBy(desc(backlinkOpportunities.createdAt)).limit(200);
      return {
        title: "Backlink Opportunities",
        subtitle: `${list.length} evidence-based referral candidate(s).`,
        columns: ["Domain", "Project", "Type", "Status", "Rationale", "Paid scheme"],
        rows: list.map((r) => ({
          Domain: r.opportunity.domain, Project: r.projectName, Type: fmt(r.opportunity.opportunityType),
          Status: r.opportunity.status, Rationale: fmt(r.opportunity.rationale),
          "Paid scheme": r.opportunity.isPaidScheme ? "YES — rejected" : "No",
        })),
        notes: ["Paid link schemes and spam tactics are rejected by design."],
      };
    }
    case "indexing": {
      const list = await db.select({ submission: indexingSubmissions, projectName: projects.name })
        .from(indexingSubmissions).innerJoin(projects, eq(indexingSubmissions.projectId, projects.id))
        .where(projectFilter).orderBy(desc(indexingSubmissions.submittedAt)).limit(200);
      return {
        title: "Indexing Monitor",
        subtitle: `${list.length} submission(s) recorded with the provider's response.`,
        columns: ["URL", "Project", "Engine", "Status", "HTTP", "Submitted"],
        rows: list.map((r) => ({
          URL: r.submission.url, Project: r.projectName, Engine: r.submission.engine,
          Status: r.submission.status, HTTP: fmt(r.submission.httpStatus), Submitted: fmt(r.submission.submittedAt),
        })),
        notes: ["A 200/202 response means the request was accepted — it never guarantees crawling or indexing."],
      };
    }
    case "google":
    case "bing": {
      const source = section === "google" ? "google_search_console" : "bing_webmaster";
      const list = await db.select({ metric: searchMetrics, projectName: projects.name })
        .from(searchMetrics).innerJoin(projects, eq(searchMetrics.projectId, projects.id))
        .where(sql`${projects.workspaceId} = ${workspaceId} and ${searchMetrics.source} = ${source}`)
        .orderBy(desc(searchMetrics.date)).limit(200);
      const config = section === "google" ? OAUTH_PROVIDERS.google_search_console : OAUTH_PROVIDERS.bing_webmaster;
      return {
        title: section === "google" ? "Google Search Console" : "Bing Webmaster",
        subtitle: `${list.length} persisted row(s) from ${config.label}.`,
        columns: ["Date", "Project", "Query", "Page", "Clicks", "Impressions", "Position"],
        rows: list.map((r) => ({
          Date: fmt(r.metric.date), Project: r.projectName, Query: fmt(r.metric.query), Page: fmt(r.metric.page),
          Clicks: fmt(r.metric.clicks), Impressions: fmt(r.metric.impressions), Position: fmt(r.metric.position),
        })),
        notes: [config.isConfigured() ? "OAuth credentials detected; connect the account to sync." : "OAuth credentials are not configured in this environment."],
      };
    }
    case "agents": {
      registerBuiltinHandlers();
      const agents = listAgents();
      const runs = await db.select().from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId)).orderBy(desc(agentRuns.startedAt)).limit(50);
      return {
        title: "AI Agents Control",
        subtitle: `${agents.length} registered agents · ${runs.length} recent run(s).`,
        columns: ["Agent", "Mission", "Toolsets", "Runs", "Last status"],
        rows: agents.map((agent) => {
          const agentRunsForAgent = runs.filter((r) => r.agentKey === agent.key);
          return {
            Agent: agent.name, Mission: agent.mission, Toolsets: agent.toolsets.join(", "),
            Runs: fmt(agentRunsForAgent.length), "Last status": fmt(agentRunsForAgent[0]?.status ?? "never run"),
          };
        }),
        notes: ["High-risk agents create approval requests instead of mutating production directly."],
      };
    }
    case "scheduler": {
      const list = await db.select().from(jobSchedules).where(eq(jobSchedules.workspaceId, workspaceId)).orderBy(jobSchedules.name);
      return {
        title: "Automation Scheduler",
        subtitle: `${list.length} schedule(s). The scheduler.tick job enqueues due work.`,
        columns: ["Name", "Job type", "Frequency", "Enabled", "Last run", "Next run"],
        rows: list.map((s) => ({ Name: s.name, "Job type": s.jobType, Frequency: s.frequency, Enabled: s.enabled ? "yes" : "no", "Last run": fmt(s.lastRunAt), "Next run": fmt(s.nextRunAt) })),
        notes: [],
      };
    }
    case "analytics": {
      const list = await db.select({
        date: searchMetrics.date, source: searchMetrics.source,
        clicks: sql<number>`sum(${searchMetrics.clicks})::int`,
        impressions: sql<number>`sum(${searchMetrics.impressions})::int`,
      }).from(searchMetrics).innerJoin(projects, eq(searchMetrics.projectId, projects.id))
        .where(projectFilter).groupBy(searchMetrics.date, searchMetrics.source)
        .orderBy(desc(searchMetrics.date)).limit(120);
      return {
        title: "Analytics",
        subtitle: `${list.length} daily metric group(s).`,
        columns: ["Date", "Source", "Clicks", "Impressions"],
        rows: list.map((r) => ({ Date: fmt(r.date), Source: r.source, Clicks: fmt(r.clicks), Impressions: fmt(r.impressions) })),
        notes: ["Conversions and revenue require analytics integration data; they are not inferred from clicks."],
      };
    }
    case "reports": {
      const list = await db.select().from(reports).where(eq(reports.workspaceId, workspaceId)).orderBy(desc(reports.periodEnd)).limit(50);
      return {
        title: "Reports",
        subtitle: `${list.length} generated report(s).`,
        columns: ["Type", "Period start", "Period end", "Data", "Created"],
        rows: list.map((r) => ({ Type: r.type, "Period start": fmt(r.periodStart), "Period end": fmt(r.periodEnd), Data: fmt(r.data), Created: fmt(r.createdAt) })),
        notes: ["Reports are generated from persisted rows only."],
      };
    }
    case "security": {
      const list = await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId)).orderBy(desc(auditLogs.createdAt)).limit(100);
      const pending = await db.select().from(approvals).where(eq(approvals.workspaceId, workspaceId)).orderBy(desc(approvals.createdAt)).limit(50);
      return {
        title: "Security & Permissions",
        subtitle: `${list.length} audit event(s) · ${pending.length} approval request(s).`,
        columns: ["Action", "Actor", "Target", "Decision", "Time"],
        rows: [
          ...pending.map((a) => ({ Action: `approval:${a.actionType}`, Actor: fmt(a.requestedByAgent), Target: a.id.slice(0, 8), Decision: a.status, Time: fmt(a.createdAt) })),
          ...list.map((l) => ({ Action: l.action, Actor: fmt(l.actorId?.slice(0, 8)), Target: fmt(l.targetId?.slice(0, 8) ?? l.targetType), Decision: "—", Time: fmt(l.createdAt) })),
        ],
        notes: ["Production changes, publishing and URL submissions require explicit human approval."],
      };
    }
    case "settings": {
      const ai = getAIProvider();
      return {
        title: "Settings",
        subtitle: "Environment capabilities. Secrets are never displayed.",
        columns: ["Capability", "Status", "Detail"],
        rows: [
          { Capability: "Database", Status: "Active", Detail: process.env.DATABASE_URL ? "Neon serverless Postgres" : "Embedded PGlite Postgres" },
          { Capability: "AI provider", Status: ai.name === "none" ? "Not configured" : "Configured", Detail: ai.name },
          ...Object.values(OAUTH_PROVIDERS).map((p) => ({ Capability: p.label, Status: p.isConfigured() ? "Configured" : "Not configured", Detail: `${p.scopes.length} scope(s)` })),
          { Capability: "IndexNow", Status: process.env.INDEXNOW_KEY ? "Configured" : "Not configured", Detail: "Key value hidden" },
          { Capability: "Master encryption key", Status: process.env.MASTER_ENCRYPTION_KEY ? "Configured" : "Development fallback", Detail: "Value hidden" },
        ],
        notes: ["Configure variables in .env.local (local) or your hosting provider (production). See .env.example."],
      };
    }
    default:
      return empty("Not found", "Unknown dashboard section.", [], "Return to the executive overview.");
  }
}
