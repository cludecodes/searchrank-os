import type { Database } from "../db/client";
import { linkChecks, pages, seoAudits } from "../db/schema";
import type { AuditResult } from "./audit";

/** Persists an audit and everything it observed. No values are synthesized. */
export async function persistAudit(
  db: Database,
  projectId: string,
  audit: AuditResult,
  jobId?: string | null,
): Promise<{ auditId: string }> {
  const created = await db
    .insert(seoAudits)
    .values({
      projectId,
      jobId: jobId ?? null,
      status: "completed",
      score: audit.score,
      findings: audit as unknown as Record<string, unknown>,
      startedAt: new Date(audit.auditedAt),
      finishedAt: new Date(),
    })
    .returning({ id: seoAudits.id });
  const auditId = created[0].id;

  if (audit.page) {
    const p = audit.page;
    await db
      .insert(pages)
      .values({
        projectId,
        url: p.finalUrl,
        statusCode: p.statusCode,
        title: p.title,
        metaDescription: p.metaDescription,
        canonicalUrl: p.canonical,
        h1: p.headingOutline.find((h) => h.level === 1)?.text ?? null,
        wordCount: p.wordCount,
        hasStructuredData: p.structuredDataTypes.length > 0,
        contentHash: p.contentHash,
        lastAuditedAt: new Date(),
        metadata: {
          internalLinks: p.internalLinks,
          externalLinks: p.externalLinks,
          imagesMissingAlt: p.imagesMissingAlt,
          imagesMissingDimensions: p.imagesMissingDimensions,
          viewport: p.viewport,
          openGraph: p.openGraph,
          structuredDataTypes: p.structuredDataTypes,
        } as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [pages.projectId, pages.url],
        set: {
          statusCode: p.statusCode,
          title: p.title,
          metaDescription: p.metaDescription,
          canonicalUrl: p.canonical,
          h1: p.headingOutline.find((h) => h.level === 1)?.text ?? null,
          wordCount: p.wordCount,
          hasStructuredData: p.structuredDataTypes.length > 0,
          contentHash: p.contentHash,
          lastAuditedAt: new Date(),
          updatedAt: new Date(),
          metadata: {
            internalLinks: p.internalLinks,
            externalLinks: p.externalLinks,
            imagesMissingAlt: p.imagesMissingAlt,
            imagesMissingDimensions: p.imagesMissingDimensions,
            viewport: p.viewport,
            openGraph: p.openGraph,
            structuredDataTypes: p.structuredDataTypes,
          } as Record<string, unknown>,
        },
      });
  }

  if (audit.linkChecks.length) {
    await db.insert(linkChecks).values(
      audit.linkChecks.map((link) => ({
        auditId,
        sourceUrl: link.sourceUrl,
        targetUrl: link.targetUrl,
        kind: link.kind,
        statusCode: link.statusCode,
        isBroken: link.isBroken,
      })),
    );
  }

  return { auditId };
}
