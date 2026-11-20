import type { Database } from "../db/client";
import { eq } from "drizzle-orm";
import { pages, type Page } from "../db/schema";
import type { Finding } from "./audit";

export interface SiteIssue extends Finding {
  affectedUrls: string[];
}

export interface SiteAnalysis {
  projectId: string;
  analyzedAt: string;
  pageCount: number;
  issues: SiteIssue[];
  orphanUrls: string[];
  duplicateGroups: string[][];
}

function issue(
  id: string,
  title: string,
  detail: string,
  severity: Finding["severity"],
  affectedUrls: string[],
): SiteIssue {
  return {
    id,
    category: "content",
    severity,
    title,
    detail,
    recommendation: "Review these URLs and consolidate or differentiate genuinely distinct content.",
    weight: severity === "critical" ? 8 : 4,
    affectedUrls,
  };
}

/**
 * Detects duplicate content, duplicate metadata and orphan pages strictly from
 * rows produced by real audits. No URL or content is invented.
 */
export async function analyzeSite(db: Database, projectId: string): Promise<SiteAnalysis> {
  const rows = await db.select().from(pages).where(eq(pages.projectId, projectId));
  const issues: SiteIssue[] = [];

  const groupBy = (value: (row: Page) => string | null, id: string, title: string) => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key = value(row);
      if (!key) continue;
      const urls = groups.get(key) ?? [];
      urls.push(row.url);
      groups.set(key, urls);
    }
    const duplicates = [...groups.values()].filter((urls) => urls.length > 1);
    for (const urls of duplicates) {
      issues.push(issue(id, title, `${urls.length} pages share the same value: ${urls.join(", ")}`, "warning", urls));
    }
    return duplicates;
  };

  const duplicateGroups = groupBy((row) => row.contentHash, "duplicate.content", "Duplicate content detected");
  groupBy((row) => row.title, "duplicate.title", "Duplicate title tags detected");
  groupBy((row) => row.metaDescription, "duplicate.description", "Duplicate meta descriptions detected");

  // Orphans: pages never referenced by an internal link from another audited page.
  const linkedTargets = new Set<string>();
  for (const row of rows) {
    const metadata = row.metadata as { internalLinks?: string[] };
    for (const link of metadata.internalLinks ?? []) linkedTargets.add(link);
  }
  const orphanUrls = rows
    .filter((row) => !linkedTargets.has(row.url))
    .map((row) => row.url);
  if (orphanUrls.length > 1) {
    issues.push(
      issue(
        "orphan.pages",
        "Potentially orphan pages detected",
        `${orphanUrls.length} audited page(s) were not referenced by an internal link from another audited page. This is a bounded sample, not a full crawl.`,
        "info",
        orphanUrls,
      ),
    );
  }

  for (const url of orphanUrls) {
    await db.update(pages).set({ isOrphan: true, updatedAt: new Date() }).where(eq(pages.id, rows.find((r) => r.url === url)!.id));
  }
  for (const row of rows) {
    if (!orphanUrls.includes(row.url) && row.isOrphan) {
      await db.update(pages).set({ isOrphan: false, updatedAt: new Date() }).where(eq(pages.id, row.id));
    }
  }

  return {
    projectId,
    analyzedAt: new Date().toISOString(),
    pageCount: rows.length,
    issues,
    orphanUrls,
    duplicateGroups,
  };
}
