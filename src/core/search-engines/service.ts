import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvals, indexingSubmissions, monitoringChecks, projects, searchMetrics,
} from "../db/schema";
import { getDecryptedTokens } from "../integrations/credentials";
import { GoogleSearchConsoleClient, type GscSite } from "../integrations/google-search-console";
import { BingWebmasterClient } from "../integrations/bing-webmaster";

export interface EngineSiteStatus {
  provider: "google_search_console" | "bing_webmaster";
  connected: boolean;
  sites: string[];
  error?: string;
}

function siteUrlFor(
  project: { productionUrl: string | null; domain: string | null; metadata?: unknown },
  override?: string,
): string | null {
  return override ?? (project.metadata as { gscSiteUrl?: string } | null)?.gscSiteUrl ?? project.productionUrl ?? project.domain;
}

/** Lists verified sites from both connected engines. Never invents sites. */
export async function getEngineSites(
  db: Database,
  workspaceId: string,
): Promise<EngineSiteStatus[]> {
  const result: EngineSiteStatus[] = [];

  const gsc = await getDecryptedTokens(db, workspaceId, "google_search_console");
  if (gsc) {
    try {
      const sites = await new GoogleSearchConsoleClient({ accessToken: gsc.accessToken }).listSites();
      result.push({ provider: "google_search_console", connected: true, sites: sites.map((s) => s.siteUrl) });
    } catch (error) {
      result.push({ provider: "google_search_console", connected: true, sites: [], error: error instanceof Error ? error.message : String(error) });
    }
  } else {
    result.push({ provider: "google_search_console", connected: false, sites: [] });
  }

  const bing = await getDecryptedTokens(db, workspaceId, "bing_webmaster");
  if (bing) {
    try {
      const sites = await new BingWebmasterClient({ accessToken: bing.accessToken }).listSites();
      result.push({
        provider: "bing_webmaster",
        connected: true,
        sites: sites.map((s) => String(s.Url ?? s.SiteUrl ?? "")).filter(Boolean),
      });
    } catch (error) {
      result.push({ provider: "bing_webmaster", connected: true, sites: [], error: error instanceof Error ? error.message : String(error) });
    }
  } else {
    result.push({ provider: "bing_webmaster", connected: false, sites: [] });
  }
  return result;
}

async function requireApproval(db: Database, approvalId: string, actionType: string) {
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval || approval.status !== "approved" || approval.actionType !== actionType) {
    throw new Error(`Approved ${actionType} request is required before submitting to a search engine.`);
  }
  return approval;
}

/** Submits an XML sitemap to both connected engines, respecting approval. */
export async function submitSitemaps(
  db: Database,
  workspaceId: string,
  projectId: string,
  sitemapUrl: string,
  approvalId: string,
): Promise<{ engine: string; status: string; detail: string }[]> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.workspaceId !== workspaceId) throw new Error("Project not found in workspace");
  await requireApproval(db, approvalId, "sitemap_submission");

  const results: { engine: string; status: string; detail: string }[] = [];
  const gsc = await getDecryptedTokens(db, workspaceId, "google_search_console");
  const siteUrl = siteUrlFor(project);

  if (gsc && siteUrl) {
    try {
      await new GoogleSearchConsoleClient({ accessToken: gsc.accessToken }).submitSitemap(siteUrl, sitemapUrl);
      results.push({ engine: "google", status: "accepted", detail: "GSC accepted the sitemap submission" });
      await db.insert(indexingSubmissions).values({
        projectId, engine: "google-sitemap", url: sitemapUrl, status: "accepted",
        responseBody: "Search Console accepted the request; indexing is not guaranteed.",
        submittedBy: "SEARCH_ENGINE_SERVICE",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ engine: "google", status: "error", detail });
      await db.insert(indexingSubmissions).values({
        projectId, engine: "google-sitemap", url: sitemapUrl, status: "error",
        responseBody: detail.slice(0, 2000), submittedBy: "SEARCH_ENGINE_SERVICE",
      });
    }
  }

  const bing = await getDecryptedTokens(db, workspaceId, "bing_webmaster");
  if (bing && siteUrl) {
    try {
      await new BingWebmasterClient({ accessToken: bing.accessToken }).submitSitemap(siteUrl, sitemapUrl);
      results.push({ engine: "bing", status: "accepted", detail: "Bing accepted the sitemap submission" });
      await db.insert(indexingSubmissions).values({
        projectId, engine: "bing-sitemap", url: sitemapUrl, status: "accepted",
        responseBody: "Bing accepted the request; indexing is not guaranteed.",
        submittedBy: "SEARCH_ENGINE_SERVICE",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ engine: "bing", status: "error", detail });
      await db.insert(indexingSubmissions).values({
        projectId, engine: "bing-sitemap", url: sitemapUrl, status: "error",
        responseBody: detail.slice(0, 2000), submittedBy: "SEARCH_ENGINE_SERVICE",
      });
    }
  }

  if (!results.length) throw new Error("No connected search engine available for sitemap submission");
  return results;
}

/** Submits URLs to Bing within its real daily quota, with approval. */
export async function submitBingUrls(
  db: Database,
  workspaceId: string,
  projectId: string,
  urls: string[],
  approvalId: string,
): Promise<{ submitted: number; quota: number | null; note: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.workspaceId !== workspaceId) throw new Error("Project not found in workspace");
  await requireApproval(db, approvalId, "url_submission");
  const bing = await getDecryptedTokens(db, workspaceId, "bing_webmaster");
  if (!bing) throw new Error("Bing Webmaster is not connected");
  const siteUrl = siteUrlFor(project);
  if (!siteUrl) throw new Error("No site URL resolved for this project");

  const client = new BingWebmasterClient({ accessToken: bing.accessToken });
  const quota = await client.getUrlSubmissionQuota(siteUrl).catch(() => ({ DailyQuota: undefined }));
  const allowed = Math.min(urls.length, quota.DailyQuota ?? urls.length, 500);
  const selected = urls.slice(0, allowed);
  if (!selected.length) throw new Error("No URLs left in the daily submission quota");

  await client.submitUrls(siteUrl, selected);
  for (const url of selected) {
    await db.insert(indexingSubmissions).values({
      projectId, engine: "bing-url", url, status: "accepted",
      responseBody: "Bing accepted the URL submission; indexing is not guaranteed.",
      submittedBy: "SEARCH_ENGINE_SERVICE",
    });
  }
  return {
    submitted: selected.length,
    quota: quota.DailyQuota ?? null,
    note: "Acceptance of a submission does not guarantee crawling or indexing.",
  };
}

/** Read-only URL inspection via Google Search Console. */
export async function inspectUrl(
  db: Database,
  workspaceId: string,
  projectId: string,
  url: string,
): Promise<{ verdict: string | null; raw: Record<string, unknown> }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.workspaceId !== workspaceId) throw new Error("Project not found in workspace");
  const gsc = await getDecryptedTokens(db, workspaceId, "google_search_console");
  if (!gsc) throw new Error("Google Search Console is not connected");
  const siteUrl = siteUrlFor(project);
  if (!siteUrl) throw new Error("No site URL resolved for this project");

  const raw = await new GoogleSearchConsoleClient({ accessToken: gsc.accessToken }).inspectUrl(siteUrl, url);
  const verdict = (raw as { inspectionResult?: { indexStatusResult?: { verdict?: string } } })
    .inspectionResult?.indexStatusResult?.verdict ?? null;
  await db.insert(indexingSubmissions).values({
    projectId,
    engine: "google-inspection",
    url,
    status: verdict ?? "unknown",
    responseBody: JSON.stringify(raw).slice(0, 10_000),
    submittedBy: "SEARCH_ENGINE_SERVICE",
  });
  return { verdict, raw };
}

/** Syncs real performance rows from both engines into searchMetrics. */
export async function syncPerformance(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<{ source: string; rows: number }[]> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.workspaceId !== workspaceId) throw new Error("Project not found in workspace");
  const siteUrl = siteUrlFor(project);
  if (!siteUrl) throw new Error("No site URL resolved for this project");
  const results: { source: string; rows: number }[] = [];
  const endDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10);

  const gsc = await getDecryptedTokens(db, workspaceId, "google_search_console");
  if (gsc) {
    const rows = await new GoogleSearchConsoleClient({ accessToken: gsc.accessToken }).querySearchAnalytics({
      siteUrl, startDate, endDate, rowLimit: 5000,
    });
    let count = 0;
    for (const row of rows) {
      const [query, page, country, device] = row.keys ?? [];
      if (!query || !page) continue;
      await db.insert(searchMetrics).values({
        projectId, source: "google_search_console", date: endDate, query, page,
        country: country ?? null, device: device ?? null,
        clicks: row.clicks ?? 0, impressions: row.impressions ?? 0, ctr: row.ctr, position: row.position,
      }).onConflictDoNothing();
      count++;
    }
    results.push({ source: "google_search_console", rows: count });
  }

  const bing = await getDecryptedTokens(db, workspaceId, "bing_webmaster");
  if (bing) {
    const rows = await new BingWebmasterClient({ accessToken: bing.accessToken }).getQueryStats(siteUrl);
    let count = 0;
    for (const row of rows) {
      if (!row.Query) continue;
      const clicks = row.Clicks ?? 0;
      const impressions = row.Impressions ?? 0;
      await db.insert(searchMetrics).values({
        projectId, source: "bing_webmaster", date: endDate, query: row.Query, page: siteUrl,
        clicks, impressions, ctr: impressions ? clicks / impressions : null,
        position: row.AvgClickPosition ?? row.AvgImpressionPosition ?? null,
      }).onConflictDoNothing();
      count++;
    }
    results.push({ source: "bing_webmaster", rows: count });
  }
  return results;
}

/** Monitor sitemap/crawl issues from real provider responses. */
export async function monitorIssues(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<Array<{ source: string; status: string; detail: string }>> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || project.workspaceId !== workspaceId) throw new Error("Project not found in workspace");
  const siteUrl = siteUrlFor(project);
  if (!siteUrl) throw new Error("No site URL resolved for this project");
  const findings: Array<{ source: string; status: string; detail: string }> = [];

  const gsc = await getDecryptedTokens(db, workspaceId, "google_search_console");
  if (gsc) {
    const sitemaps = await new GoogleSearchConsoleClient({ accessToken: gsc.accessToken }).listSitemaps(siteUrl).catch(() => []);
    const problematic = sitemaps.filter((s) => s.isPending || s.isThrottled || (s.contents ?? []).some((c) => c.type && /error/i.test(c.type)));
    const status = problematic.length ? "issues" : "ok";
    findings.push({ source: "google", status, detail: `${sitemaps.length} sitemap(s), ${problematic.length} with issues` });
    await db.insert(monitoringChecks).values({
      projectId, kind: "sitemap", status, detail: { source: "google", count: sitemaps.length, problematic: problematic.length },
    });
  }

  const bing = await getDecryptedTokens(db, workspaceId, "bing_webmaster");
  if (bing) {
    const issues = await new BingWebmasterClient({ accessToken: bing.accessToken }).getCrawlIssues(siteUrl).catch(() => []);
    const status = issues.length ? "issues" : "ok";
    findings.push({ source: "bing", status, detail: `${issues.length} crawl issue(s)` });
    await db.insert(monitoringChecks).values({
      projectId, kind: "crawl", status, detail: { source: "bing", count: issues.length },
    });
  }
  return findings;
}

/** Edge discovery visibility is derived from Bing data — never a separate claim. */
export async function edgeVisibility(db: Database, projectId: string) {
  const [row] = await db
    .select({
      clicks: sql<number>`coalesce(sum(${searchMetrics.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchMetrics.impressions}), 0)::int`,
    })
    .from(searchMetrics)
    .where(and(eq(searchMetrics.projectId, projectId), eq(searchMetrics.source, "bing_webmaster")));
  return {
    clicks: Number(row?.clicks ?? 0),
    impressions: Number(row?.impressions ?? 0),
    note: "Microsoft Edge discovery uses the Bing index. These figures are Bing Webmaster data, not a separate Edge API.",
  };
}

export async function recentSubmissions(db: Database, projectId: string) {
  return db.select().from(indexingSubmissions)
    .where(eq(indexingSubmissions.projectId, projectId))
    .orderBy(desc(indexingSubmissions.submittedAt))
    .limit(100);
}
