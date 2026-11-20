import { and, eq, inArray, sql } from "drizzle-orm";
import * as cheerio from "cheerio";
import { z } from "zod";
import { generateStructured } from "../ai/provider";
import type { AgentContext, AgentDefinition, AgentKey, AgentResult } from "./framework";
import { getAgent, registerAgent } from "./framework";
import {
  approvals,
  backlinkOpportunities,
  competitors,
  contentItems,
  deployments,
  indexingSubmissions,
  integrations,
  jobs,
  keywords,
  projects,
  searchMetrics,
  seoAudits,
  type Project,
} from "../db/schema";
import { getDecryptedTokens } from "../integrations/credentials";
import { GitHubClient } from "../integrations/github";
import { VercelClient, type VercelDeployment } from "../integrations/vercel";
import { GoogleSearchConsoleClient } from "../integrations/google-search-console";
import { BingWebmasterClient } from "../integrations/bing-webmaster";
import { submitToIndexNow } from "../integrations/indexnow";
import { auditUrl } from "../seo/audit";
import { persistAudit } from "../seo/persist";
import { enqueueJob } from "../jobs/queue";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Infers a plausible business category from observable metadata only.
 *  Never invents specific business facts — just a coarse label. */
function inferBusinessCategory(input: {
  description?: string | null;
  topics?: string[];
  framework?: string | null;
  domain?: string | null;
}): string | null {
  const text = [
    input.description ?? "",
    ...(input.topics ?? []),
    input.framework ?? "",
    input.domain ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const signals: Array<[RegExp, string]> = [
    [/\b(shop|store|sell|buy|cart|checkout|commerce|e[- ]commerce|boutique|marketplace)\b/, "ecommerce"],
    [/\b(saas|software|platform|api|dashboard|app|web app|tool)\b/, "saas"],
    [/\b(blog|article|post|news|publish|writer|media)\b/, "blog"],
    [/\b(portfolio|agency|creative|design|studio|freelance)\b/, "agency"],
    [/\b(plumber|electrician|dentist|clinic|lawyer|restaurant|cafe|hotel|service)\b/, "local-business"],
    [/\b(org|nonprofit|charity|foundation|ngo|mission|cause)\b/, "nonprofit"],
  ];
  for (const [pattern, category] of signals) {
    if (pattern.test(text)) return category;
  }
  return "general";
}

async function loadProjects(ctx: AgentContext): Promise<Project[]> {
  if (ctx.projectId) {
    return ctx.db.select().from(projects).where(eq(projects.id, ctx.projectId));
  }
  if (!ctx.workspaceId) return [];
  return ctx.db.select().from(projects).where(eq(projects.workspaceId, ctx.workspaceId));
}

async function loadProject(ctx: AgentContext): Promise<Project | null> {
  const list = await loadProjects(ctx);
  return list[0] ?? null;
}

function skip(reason: string, summary = "Skipped — no real data source available."): AgentResult {
  return { summary, skippedReason: reason, data: { reason } };
}

const definitions: AgentDefinition[] = [
  {
    key: "CHIEF_SUPERVISOR",
    name: "Chief Supervisor",
    mission: "Coordinate the agent workforce, assign priorities and approve workflows from evidence.",
    responsibilities: ["Prioritize projects", "Enqueue due work", "Evaluate agent outcomes", "Escalate approvals"],
    toolsets: ["jobs", "projects", "reports"],
    canMutateProduction: false,
    async run(ctx) {
      const list = await loadProjects(ctx);
      const queued: string[] = [];
      for (const project of list.filter((p) => p.status === "active")) {
        const existing = await ctx.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.projectId, project.id), eq(jobs.type, "seo.audit"), eq(jobs.status, "pending")))
          .limit(1);
        if (existing.length) continue;
        const job = await enqueueJob(ctx.db, {
          type: "seo.audit",
          payload: { url: project.productionUrl },
          workspaceId: project.workspaceId,
          projectId: project.id,
          createdBy: "CHIEF_SUPERVISOR",
        });
        queued.push(job.id);
      }
      return {
        summary: `Reviewed ${list.length} project(s); queued ${queued.length} audit job(s).`,
        data: { projectsReviewed: list.length, queuedJobs: queued },
      };
    },
  },
  {
    key: "PROJECT_DISCOVERY_AGENT",
    name: "Project Discovery Agent",
    mission: "Discover public repositories and Vercel projects, resolve production domains, detect frameworks, flag duplicates and preview deployments, and maintain the central project registry.",
    responsibilities: [
      "Discover repositories",
      "Discover Vercel projects",
      "Resolve production domains",
      "Detect frameworks",
      "Identify business category",
      "Detect deployment failures",
      "Identify preview deployments",
      "Flag duplicate domains",
      "Maintain project registry",
    ],
    toolsets: ["github", "vercel", "projects"],
    canMutateProduction: false,
    async run(ctx) {
      if (!ctx.workspaceId) return skip("workspaceId is required");
      const gh = await getDecryptedTokens(ctx.db, ctx.workspaceId, "github");
      const vc = await getDecryptedTokens(ctx.db, ctx.workspaceId, "vercel");
      if (!gh && !vc) return skip("No GitHub or Vercel integration connected");

      let discovered = 0;
      let failures = 0;
      let previews = 0;
      const duplicates: string[] = [];
      const seenDomains = new Map<string, { source: string; name: string }>();

      const upsertProject = async (values: {
        name: string;
        domain: string | null;
        productionUrl: string | null;
        repositoryFullName?: string | null;
        repositoryId?: string | null;
        vercelProjectId?: string | null;
        framework?: string | null;
        description?: string | null;
        businessCategory?: string | null;
        topics?: string[];
        status: "discovered" | "active" | "error";
        isDuplicateDomain: boolean;
        isPreview: boolean;
        discoveredBy: string;
        metadata: Record<string, unknown>;
      }): Promise<string> => {
        const slug = slugify(values.name);
        const existing = await ctx.db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.workspaceId, ctx.workspaceId!), eq(projects.slug, slug)))
          .limit(1);
        const category = values.businessCategory ?? inferBusinessCategory({ description: values.description, topics: values.topics, framework: values.framework, domain: values.domain });
        const isDuplicate = Boolean(values.isDuplicateDomain || (values.domain && seenDomains.has(values.domain)));
        if (isDuplicate && values.domain) duplicates.push(values.domain);
        if (values.domain) seenDomains.set(values.domain, { source: values.discoveredBy, name: values.name });

        const row = {
          slug,
          name: values.name,
          domain: values.domain,
          productionUrl: values.productionUrl,
          repositoryFullName: values.repositoryFullName ?? null,
          repositoryId: values.repositoryId ?? null,
          vercelProjectId: values.vercelProjectId ?? null,
          framework: values.framework,
          description: values.description,
          businessCategory: category,
          status: values.status,
          isDuplicateDomain: isDuplicate,
          isPreview: values.isPreview,
          metadata: values.metadata,
          updatedAt: new Date(),
        };
        if (existing.length) {
          await ctx.db.update(projects).set(row).where(eq(projects.id, existing[0].id));
          return existing[0].id;
        }
        const created = await ctx.db.insert(projects).values({ ...row, workspaceId: ctx.workspaceId!, discoveredBy: values.discoveredBy }).returning({ id: projects.id });
        return created[0].id;
      };

      if (gh) {
        const client = new GitHubClient({ accessToken: gh.accessToken });
        const repos = await client.listPublicRepositories();
        for (const repo of repos) {
          const domain = domainOf(repo.homepage);
          const [owner, name] = repo.full_name.split("/");
          const framework = await client.detectFramework(owner, name, repo.default_branch);
          const topics = repo.topics ?? [];
          await upsertProject({
            name: repo.name,
            domain,
            productionUrl: repo.homepage || null,
            repositoryFullName: repo.full_name,
            repositoryId: String(repo.id),
            framework,
            description: repo.description,
            businessCategory: null,
            topics,
            status: "discovered",
            isDuplicateDomain: false,
            isPreview: false,
            discoveredBy: "github",
            metadata: { topics, pushedAt: repo.pushed_at },
          });
          discovered++;
        }
      }

      if (vc) {
        const client = new VercelClient({ accessToken: vc.accessToken });
        const vercelProjects = await client.listProjects();
        for (const vp of vercelProjects) {
          const production = vp.targets?.production;
          const url = production?.url ? `https://${production.url}` : null;
          const domain = domainOf(url);

          // Inspect deployments to detect failures and previews.
          let summary;
          try {
            summary = await client.getDeploymentSummary(vp.id);
          } catch {
            summary = { production: null, previews: [], latestFailed: null };
          }

          const productionFailed = summary.production && summary.production.state !== "READY";
          const hasPreviews = summary.previews.length > 0;
          if (productionFailed) failures++;
          if (hasPreviews) previews++;

          const projectId = await upsertProject({
            name: vp.name,
            domain,
            productionUrl: url,
            vercelProjectId: vp.id,
            framework: vp.framework,
            description: vp.description,
            businessCategory: null,
            topics: [],
            status: productionFailed ? "error" : (url ? "active" : "discovered"),
            isDuplicateDomain: false,
            isPreview: hasPreviews && !url,
            discoveredBy: "vercel",
            metadata: {
              vercelUpdatedAt: vp.updatedAt ?? null,
              deploymentState: summary.production?.state ?? null,
              previewCount: summary.previews.length,
              latestFailed: summary.latestFailed
                ? { id: summary.latestFailed.id, state: summary.latestFailed.state, url: summary.latestFailed.url }
                : null,
            },
          });

          // Record discovered deployments for rollback/audit visibility, keyed to the project.
          const recordDeployment = async (deployment: VercelDeployment, isPreview: boolean) => {
            await ctx.db
              .insert(deployments)
              .values({
                projectId,
                provider: "vercel",
                deploymentId: deployment.id,
                url: `https://${deployment.url}`,
                state: deployment.state,
                isPreview,
                commitSha: deployment.meta?.githubCommitSha ?? null,
                metadata: { discoveredAt: new Date().toISOString() },
              })
              .onConflictDoNothing();
          };
          if (summary.production) await recordDeployment(summary.production, false);
          for (const preview of summary.previews) await recordDeployment(preview, true);

          discovered++;
        }
      }

      return {
        summary: `Discovered or refreshed ${discovered} project(s) (${failures} deployment failure(s), ${previews} with preview deployment(s)).`,
        data: {
          discovered,
          deploymentFailures: failures,
          previewDeployments: previews,
          duplicateDomains: duplicates,
        },
      };
    },
  },
  {
    key: "TECHNICAL_SEO_AGENT",
    name: "Technical SEO Agent",
    mission: "Audit real pages and persist findings for every registered production website.",
    responsibilities: ["Metadata", "Canonicals", "Redirects", "robots.txt", "Sitemaps", "Broken links", "Structured data"],
    toolsets: ["http", "html", "database"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      const url = (ctx.input.url as string | undefined) ?? project?.productionUrl;
      if (!url) return skip("No production URL registered for this project");
      const result = await auditUrl(url);
      let auditId: string | null = null;
      if (project) {
        const persisted = await persistAudit(ctx.db, project.id, result, ctx.jobId);
        auditId = persisted.auditId;
      }
      const failures = result.findings.filter((f) => f.severity !== "pass");
      return {
        summary: `Audited ${result.auditedUrl}: score ${result.score}, ${failures.length} finding(s).`,
        data: {
          auditId,
          score: result.score,
          findingCount: failures.length,
          findings: failures.map(({ id, severity, title }) => ({ id, severity, title })),
          limitations: result.limitations,
        },
      };
    },
  },
  {
    key: "KEYWORD_INTELLIGENCE_AGENT",
    name: "Keyword Intelligence Agent",
    mission: "Store real query data with provenance and prioritize by business relevance.",
    responsibilities: ["Import GSC queries", "Classify intent", "Cluster keywords", "Track history", "Never invent volume"],
    toolsets: ["google_search_console", "database"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project || !ctx.workspaceId) return skip("A registered project and workspace are required");
      const tokens = await getDecryptedTokens(ctx.db, ctx.workspaceId, "google_search_console");
      if (!tokens) return skip("Google Search Console is not connected — no keyword volume will be invented");

      const siteUrl =
        (project.metadata as { gscSiteUrl?: string })?.gscSiteUrl ?? project.productionUrl ?? project.domain;
      if (!siteUrl) return skip("No GSC site URL resolved for this project");
      const client = new GoogleSearchConsoleClient({ accessToken: tokens.accessToken });
      const endDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10);
      const rows = await client.querySearchAnalytics({ siteUrl, startDate, endDate, rowLimit: 1000 });
      const retrievedAt = new Date();

      let stored = 0;
      for (const row of rows) {
        const term = row.keys?.[0];
        if (!term) continue;
        const existing = await ctx.db
          .select({ id: keywords.id })
          .from(keywords)
          .where(and(eq(keywords.projectId, project.id), eq(keywords.keyword, term), eq(keywords.country, row.keys?.[2] ?? project.country)))
          .limit(1);
        const values = {
          currentRank: row.position,
          source: "google_search_console",
          sourceUrl: `https://search.google.com/search-console/performance?site=${encodeURIComponent(siteUrl)}`,
          retrievedAt,
          competitorUrls: [] as string[],
        };
        if (existing.length) {
          await ctx.db.update(keywords).set({ ...values, updatedAt: new Date() }).where(eq(keywords.id, existing[0].id));
        } else {
          await ctx.db.insert(keywords).values({
            projectId: project.id,
            keyword: term,
            country: row.keys?.[2] ?? project.country,
            language: project.language,
            intent: inferIntent(term),
            targetUrl: row.keys?.[1] ?? null,
            priority: Math.round((row.clicks ?? 0) * 2 + (row.impressions ?? 0) / 100),
            ...values,
          });
        }
        stored++;
      }
      return {
        summary: `Stored ${stored} keyword record(s) from Google Search Console.`,
        data: { stored, source: "google_search_console", startDate, endDate },
      };
    },
  },
  {
    key: "COMPETITOR_INTELLIGENCE_AGENT",
    name: "Competitor Intelligence Agent",
    mission: "Study registered competitors using observable public data and identify content gaps.",
    responsibilities: ["Analyze competitor pages", "Find content gaps", "Assess realistic differentiation"],
    toolsets: ["http", "html", "database"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project) return skip("A registered project is required");
      const list = await ctx.db.select().from(competitors).where(eq(competitors.projectId, project.id));
      if (!list.length) return skip("No competitors registered for this project");
      let analyzed = 0;
      for (const competitor of list) {
        const site = competitor.domain.startsWith("http") ? competitor.domain : `https://${competitor.domain}`;
        const response = await fetch(site, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; SearchRankOS/1.0)" },
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null);
        if (!response?.ok) continue;
        const html = await response.text();
        const $ = cheerio.load(html);
        const titles = $("h1, h2, h3").map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 30);
        await ctx.db
          .update(competitors)
          .set({
            strengths: titles,
            lastAnalyzedAt: new Date(),
            notes: `Observed ${titles.length} headings on ${response.url} at ${new Date().toISOString()}.`,
          })
          .where(eq(competitors.id, competitor.id));
        analyzed++;
      }
      return { summary: `Analyzed ${analyzed} competitor site(s) from live HTML.`, data: { analyzed } };
    },
  },
  {
    key: "CONTENT_STRATEGY_AGENT",
    name: "Content Strategy Agent",
    mission: "Build topical authority maps and briefs grounded in stored keywords.",
    responsibilities: ["Content calendars", "Landing page plans", "Missing information", "Internal linking plans"],
    toolsets: ["keywords", "ai", "database"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project) return skip("A registered project is required");
      const existing = await ctx.db.select({ id: keywords.id }).from(keywords).where(eq(keywords.projectId, project.id)).limit(1);
      if (!existing.length) return skip("No keyword records available — run Keyword Intelligence first");
      if (ctx.ai.name === "none") return skip("No AI provider configured — brief generation would fabricate content");

      const top = await ctx.db
        .select()
        .from(keywords)
        .where(eq(keywords.projectId, project.id))
        .orderBy(sql`${keywords.priority} DESC`)
        .limit(10);
      const briefSchema = z.object({
        briefs: z.array(
          z.object({
            keywordId: z.string(),
            title: z.string().min(5),
            proposedUrl: z.string().min(1),
            audience: z.string().min(5),
            uniqueValueProposition: z.string().min(10),
            outline: z.array(z.string()),
            internalLinks: z.array(z.string()),
          }),
        ),
      });
      const { data } = await generateStructured(ctx.ai, briefSchema, {
        messages: [
          {
            role: "system",
            content:
              "You are a SEO content strategist. Produce briefs only for the supplied keywords. " +
              "Do not invent statistics, ratings, testimonials, or business facts. Suggested URLs must be relative paths.",
          },
          {
            role: "user",
            content: JSON.stringify({
              project: { name: project.name, domain: project.domain, description: project.description, category: project.businessCategory },
              keywords: top.map((k) => ({ id: k.id, keyword: k.keyword, intent: k.intent, clicks: 0, position: k.currentRank })),
            }),
          },
        ],
      });

      let created = 0;
      for (const item of data.briefs) {
        if (!top.some((k) => k.id === item.keywordId)) continue;
        await ctx.db.insert(contentItems).values({
          projectId: project.id,
          targetKeywordId: item.keywordId,
          title: item.title,
          proposedUrl: item.proposedUrl,
          intent: inferIntent(item.title),
          audience: item.audience,
          uniqueValueProposition: item.uniqueValueProposition,
          brief: { outline: item.outline } as Record<string, unknown>,
          internalLinkPlan: item.internalLinks,
          status: "brief",
          createdByAgent: "CONTENT_STRATEGY_AGENT",
        });
        created++;
      }
      return { summary: `Created ${created} content brief(s) from ${top.length} stored keywords.`, data: { created } };
    },
  },
  {
    key: "CONTENT_PRODUCTION_AGENT",
    name: "Content Production Agent",
    mission: "Draft original, useful content from approved briefs only.",
    responsibilities: ["Draft articles", "Product descriptions", "FAQs", "On-page optimization", "Duplicate prevention"],
    toolsets: ["ai", "content", "database"],
    canMutateProduction: false,
    async run(ctx) {
      if (ctx.ai.name === "none") return skip("No AI provider configured — content will not be fabricated");
      const project = await loadProject(ctx);
      if (!project) return skip("A registered project is required");
      const candidates = await ctx.db
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.projectId, project.id), eq(contentItems.status, "approved")))
        .limit(5);
      const targets = candidates.filter((c) => !c.body);
      if (!targets.length) return skip("No approved content briefs awaiting production");
      let drafted = 0;
      for (const item of targets) {
        const completion = await ctx.ai.complete({
          messages: [
            {
              role: "system",
              content:
                "Write original, genuinely useful content from the brief. Never invent ratings, testimonials, prices, " +
                "customer counts, or factual claims that are not in the brief. Use clear headings and answer search intent.",
            },
            { role: "user", content: JSON.stringify({ title: item.title, brief: item.brief, audience: item.audience, uvp: item.uniqueValueProposition }) },
          ],
          maxTokens: 3000,
        });
        const similarity = await duplicateRisk(ctx, completion.text, project.id);
        await ctx.db
          .update(contentItems)
          .set({
            body: completion.text,
            originalityScore: similarity,
            status: "draft",
            updatedAt: new Date(),
          })
          .where(eq(contentItems.id, item.id));
        drafted++;
      }
      return { summary: `Drafted ${drafted} content item(s); all require human review.`, data: { drafted } };
    },
  },
  {
    key: "LINK_AUTHORITY_AGENT",
    name: "Link Authority Agent",
    mission: "Identify legitimate, evidence-based referral opportunities and reject spam schemes.",
    responsibilities: ["Find real referral domains", "Track outreach", "Monitor links", "Reject paid schemes"],
    toolsets: ["http", "database"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project) return skip("A registered project is required");
      const list = await ctx.db.select().from(competitors).where(eq(competitors.projectId, project.id));
      if (!list.length) return skip("No competitors registered — no evidence base for opportunities");
      let created = 0;
      for (const competitor of list) {
        const site = competitor.domain.startsWith("http") ? competitor.domain : `https://${competitor.domain}`;
        const response = await fetch(site, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; SearchRankOS/1.0)" },
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null);
        if (!response?.ok) continue;
        const $ = cheerio.load(await response.text());
        const domains = new Set<string>();
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href") ?? "";
          try {
            const url = new URL(href, response.url);
            if (url.protocol === "https:" && url.hostname !== new URL(site).hostname) {
              domains.add(url.hostname.replace(/^www\./, ""));
            }
          } catch {
            /* ignore invalid hrefs */
          }
        });
        for (const domain of [...domains].slice(0, 25)) {
          const existing = await ctx.db
            .select({ id: backlinkOpportunities.id })
            .from(backlinkOpportunities)
            .where(and(eq(backlinkOpportunities.projectId, project.id), eq(backlinkOpportunities.domain, domain)))
            .limit(1);
          if (existing.length) continue;
          await ctx.db.insert(backlinkOpportunities).values({
            projectId: project.id,
            domain,
            opportunityType: "referral",
            rationale: `Observed as an outbound link on competitor ${competitor.domain}; verify relevance before outreach.`,
            status: "identified",
            isPaidScheme: false,
          });
          created++;
        }
      }
      return { summary: `Recorded ${created} evidence-based referral candidate(s).`, data: { created } };
    },
  },
  {
    key: "DEVELOPER_AGENT",
    name: "Developer Agent",
    mission: "Propose isolated code changes, run checks and open PRs only after approval.",
    responsibilities: ["Branches", "Pull requests", "Preview deployments", "Rollback readiness"],
    toolsets: ["github", "vercel", "approvals"],
    canMutateProduction: true,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project?.repositoryFullName) return skip("No GitHub repository linked to this project");
      if (!ctx.workspaceId) return skip("workspaceId is required");
      const approvalId = ctx.input.approvalId as string | undefined;
      const changes = (ctx.input.changes as Array<{ path: string; content: string }> | undefined) ?? [];
      if (!changes.length) return skip("No concrete code changes were supplied");

      if (!approvalId) {
        const requested = await ctx.db
          .insert(approvals)
          .values({
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            requestedByAgent: "DEVELOPER_AGENT",
            actionType: "code_change",
            description: `Create branch and PR with ${changes.length} file change(s) in ${project.repositoryFullName}`,
            payload: { changes, repository: project.repositoryFullName } as Record<string, unknown>,
            risk: "high",
          })
          .returning({ id: approvals.id });
        return {
          summary: "Code changes require administrator approval before any branch or PR is created.",
          requiresApproval: true,
          data: { approvalId: requested[0].id },
        };
      }

      const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
      if (!approval || approval.status !== "approved" || approval.actionType !== "code_change") {
        return skip("Approval was not granted for this exact change set");
      }
      const tokens = await getDecryptedTokens(ctx.db, ctx.workspaceId, "github");
      if (!tokens) return skip("GitHub integration is not connected");
      const [owner, repo] = project.repositoryFullName.split("/");
      const client = new GitHubClient({ accessToken: tokens.accessToken });
      const repository = await client.getRepository(owner, repo);
      const branch = `seo/${Date.now()}-${slugify(project.slug)}`;
      await client.createBranch(owner, repo, branch, repository.default_branch);
      for (const change of changes) {
        const current = await client.readFile(owner, repo, change.path, repository.default_branch);
        await client.upsertFile(owner, repo, change.path, change.content, branch, `SEO: ${slugify(change.path)}`, current?.sha);
      }
      const pr = await client.createPullRequest(owner, repo, {
        title: `SEO improvements for ${project.name}`,
        head: branch,
        base: repository.default_branch,
        body: "Automated SEO proposal. Review checks, preview and metrics before merging. No production code was changed without approval.",
      });
      return { summary: `Opened PR #${pr.number}.`, data: { pullRequest: pr.html_url, branch } };
    },
  },
  {
    key: "INDEXING_AGENT",
    name: "Indexing Agent",
    mission: "Generate sitemaps and submit real URLs only after approval.",
    responsibilities: ["Sitemaps", "robots.txt", "Canonical monitoring", "IndexNow", "GSC/Bing submissions"],
    toolsets: ["indexnow", "gsc", "bing", "approvals"],
    canMutateProduction: true,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project?.productionUrl) return skip("No production URL registered");
      if (!ctx.workspaceId) return skip("workspaceId is required");
      const urls = (ctx.input.urls as string[] | undefined) ?? [];
      if (!urls.length) return skip("No verified URLs supplied for submission");
      const approvalId = ctx.input.approvalId as string | undefined;
      if (!approvalId) {
        const requested = await ctx.db
          .insert(approvals)
          .values({
            workspaceId: ctx.workspaceId,
            projectId: project.id,
            requestedByAgent: "INDEXING_AGENT",
            actionType: "indexing_submission",
            description: `Submit ${urls.length} URL(s) to IndexNow and connected search engines`,
            payload: { urls } as Record<string, unknown>,
            risk: "medium",
          })
          .returning({ id: approvals.id });
        return {
          summary: "Index submissions require approval.",
          requiresApproval: true,
          data: { approvalId: requested[0].id },
        };
      }
      const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
      if (!approval || approval.status !== "approved" || approval.actionType !== "indexing_submission") {
        return skip("Approval was not granted for these URLs");
      }
      const key = process.env.INDEXNOW_KEY;
      const keyLocation = process.env.INDEXNOW_KEY_LOCATION;
      const host = domainOf(project.productionUrl);
      if (!key || !keyLocation || !host) return skip("IndexNow key/keyLocation not configured");

      const results = await submitToIndexNow({ host, key, keyLocation, urlList: urls }, ["bing"]);
      for (const result of results) {
        await ctx.db.insert(indexingSubmissions).values({
          projectId: project.id,
          engine: `indexnow-${result.engine}`,
          url: urls[0],
          status: result.accepted ? "accepted" : "rejected",
          httpStatus: result.httpStatus,
          responseBody: result.body.slice(0, 2000),
          submittedBy: "INDEXING_AGENT",
        });
      }
      return {
        summary: `IndexNow accepted ${results.filter((r) => r.accepted).length}/${results.length} request(s). Acceptance is not an indexing guarantee.`,
        data: { results: results.map(({ engine, httpStatus, accepted }) => ({ engine, httpStatus, accepted })) },
      };
    },
  },
  {
    key: "ANALYTICS_AGENT",
    name: "Analytics Agent",
    mission: "Sync real search performance data and compute portfolio metrics.",
    responsibilities: ["Rankings", "Clicks", "Impressions", "CTR", "Conversions"],
    toolsets: ["gsc", "bing", "database"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      if (!project || !ctx.workspaceId) return skip("A registered project and workspace are required");
      const tokens = await getDecryptedTokens(ctx.db, ctx.workspaceId, "google_search_console");
      let synced = 0;
      if (tokens) {
        const client = new GoogleSearchConsoleClient({ accessToken: tokens.accessToken });
        const siteUrl = (project.metadata as { gscSiteUrl?: string })?.gscSiteUrl ?? project.productionUrl ?? project.domain;
        if (siteUrl) {
          const endDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
          const startDate = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10);
          const rows = await client.querySearchAnalytics({ siteUrl, startDate, endDate, rowLimit: 5000 });
          for (const row of rows) {
            const [query, page, country, device] = row.keys ?? [];
            if (!query || !page) continue;
            await ctx.db
              .insert(searchMetrics)
              .values({
                projectId: project.id,
                source: "google_search_console",
                date: endDate,
                query,
                page,
                country: country ?? null,
                device: device ?? null,
                clicks: row.clicks ?? 0,
                impressions: row.impressions ?? 0,
                ctr: row.ctr,
                position: row.position,
              })
              .onConflictDoNothing();
            synced++;
          }
        }
      }
      const [totals] = await ctx.db
        .select({
          clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
          impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
        })
        .from(searchMetrics)
        .where(eq(searchMetrics.projectId, project.id));
      return {
        summary: tokens
          ? `Synced ${synced} GSC row(s). Portfolio clicks: ${totals?.clicks ?? 0}.`
          : "Google Search Console is not connected; reporting only over already-persisted data.",
        data: { synced, clicks: totals?.clicks ?? 0, impressions: totals?.impressions ?? 0 },
      };
    },
  },
  {
    key: "QUALITY_SECURITY_AGENT",
    name: "Quality & Security Agent",
    mission: "Review AI changes, detect risky modifications and block fabricated claims before publishing.",
    responsibilities: ["Review generated content", "Block fake ratings/testimonials", "Validate SEO compliance", "Audit approvals"],
    toolsets: ["content", "approvals", "audit_logs"],
    canMutateProduction: false,
    async run(ctx) {
      const project = await loadProject(ctx);
      const bannedPatterns = [
        /guaranteed\s+(?:#?1|first|top)\s+(?:rank|position|spot)/i,
        /\b\d[\d,]*\s*[-\s]?star\b/i,
        /(?:fake|fabricated|invented)\s+(?:review|testimonial)/i,
        /\b100%\s+(?:guaranteed|risk[- ]free)\b/i,
        /#1\s+on\s+google/i,
      ];
      const flagged: Array<{ id: string; reason: string }> = [];
      const candidates = project
        ? await ctx.db.select().from(contentItems).where(and(eq(contentItems.projectId, project.id), eq(contentItems.status, "in_review")))
        : await ctx.db.select().from(contentItems).where(eq(contentItems.status, "in_review"));
      for (const item of candidates) {
        const text = `${item.title} ${item.body ?? ""} ${JSON.stringify(item.brief)}`;
        const match = bannedPatterns.find((pattern) => pattern.test(text));
        if (match) flagged.push({ id: item.id, reason: `Prohibited claim pattern: ${match.source}` });
      }
      const pendingApprovals = ctx.workspaceId
        ? await ctx.db.select().from(approvals).where(and(eq(approvals.workspaceId, ctx.workspaceId), eq(approvals.status, "pending")))
        : [];
      return {
        summary: `Reviewed ${candidates.length} content item(s) and ${pendingApprovals.length} pending approval(s); ${flagged.length} flagged.`,
        data: { flagged, pendingApprovals: pendingApprovals.map((a) => ({ id: a.id, actionType: a.actionType, risk: a.risk })) },
      };
    },
  },
];

function inferIntent(term: string): "informational" | "navigational" | "transactional" | "commercial" {
  const value = term.toLowerCase();
  if (/\b(buy|price|order|discount|deal|checkout|hire)\b/.test(value)) return "transactional";
  if (/\b(best|review|vs|compare|alternative|top)\b/.test(value)) return "commercial";
  if (/\b(login|sign in|dashboard|download|website|official)\b/.test(value)) return "navigational";
  return "informational";
}

async function domainExists(ctx: AgentContext, workspaceId: string, domain: string | null): Promise<boolean> {
  if (!domain) return false;
  const rows = await ctx.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.domain, domain)))
    .limit(1);
  return rows.length > 0;
}

async function duplicateRisk(ctx: AgentContext, text: string, projectId: string): Promise<number> {
  const existing = await ctx.db
    .select({ body: contentItems.body })
    .from(contentItems)
    .where(eq(contentItems.projectId, projectId))
    .limit(50);
  const shingles = (value: string) => new Set(value.toLowerCase().split(/\W+/).filter((w) => w.length > 5));
  const candidate = shingles(text);
  if (!candidate.size) return 1;
  let maxOverlap = 0;
  for (const row of existing) {
    if (!row.body) continue;
    const other = shingles(row.body);
    const overlap = [...candidate].filter((word) => other.has(word)).length / candidate.size;
    maxOverlap = Math.max(maxOverlap, overlap);
  }
  return Number((1 - maxOverlap).toFixed(3));
}

/** Registers all twelve agents with the framework. Safe to call repeatedly. */
export function registerAllAgents(): void {
  if (getAgent("CHIEF_SUPERVISOR")) return;
  for (const definition of definitions) registerAgent(definition);
}

export const AGENT_DEFINITIONS = definitions.map((d) => d.key) as AgentKey[];
