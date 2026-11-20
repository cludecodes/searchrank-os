import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { seoArtifacts, type ArtifactKind, type Page, type Project } from "../db/schema";
import { generateRobotsTxt, generateSitemap } from "./audit";

export interface GeneratedArtifact {
  kind: ArtifactKind;
  path: string;
  content: string;
  rationale: string;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}

function jsonLd(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Produces proposed SEO artifacts from verified project + page rows only.
 * Never emits ratings, reviews, testimonials, prices or invented business facts.
 */
export function generateArtifacts(
  project: Project,
  pageRows: Page[],
  framework?: string | null,
): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  const verified = pageRows.filter((p) => p.statusCode === 200 || p.lastAuditedAt);
  const urls = [...new Set(verified.map((p) => p.url))];
  const origin = project.productionUrl
    ? new URL(project.productionUrl).origin
    : project.domain
      ? `https://${project.domain}`
      : null;
  const isNext = /next/i.test(framework ?? project.framework ?? "");

  if (urls.length) {
    if (isNext) {
      const entries = urls
        .map((u) => `    { url: ${JSON.stringify(u)}, lastModified: new Date(${JSON.stringify(new Date().toISOString().slice(0, 10))}) },`)
        .join("\n");
      artifacts.push({
        kind: "sitemap-route",
        path: "src/app/sitemap.ts",
        content:
          `import type { MetadataRoute } from "next";\n\n` +
          `// Generated from URLs confirmed by a technical audit. No invented URLs.\n` +
          `export default function sitemap(): MetadataRoute.Sitemap {\n` +
          `  return [\n${entries}\n  ];\n}\n`,
        rationale: `Next.js sitemap route built from ${urls.length} verified page URL(s).`,
      });
    } else {
      artifacts.push({
        kind: "sitemap",
        path: "sitemap.xml",
        content: generateSitemap(urls),
        rationale: `Sitemap built from ${urls.length} verified page URL(s).`,
      });
    }
  }

  if (origin) {
    artifacts.push({
      kind: "robots",
      path: "public/robots.txt",
      content: generateRobotsTxt(`${origin.replace(/\/$/, "")}/sitemap.xml`),
      rationale: "robots.txt allows crawling and declares the XML sitemap location.",
    });
  }

  // Structured data limited to verifiable fields from the project record.
  const organization: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: project.name,
    url: origin ?? project.productionUrl ?? "",
  };
  if (project.description) organization.description = project.description;
  artifacts.push({
    kind: "structured-data",
    path: isNext ? "src/app/layout.tsx" : "structured-data.json",
    content: isNext
      ? `// Insert the following JSON-LD into <head> only if these fields describe your real organization.\n` +
        `<script type="application/ld+json">\n${jsonLd(organization)}\n</script>\n`
      : `${jsonLd(organization)}\n`,
    rationale:
      "Organization markup contains only the registered project name, URL and description. No ratings, reviews, testimonials, addresses or phone numbers were added.",
  });

  // Per-page metadata suggestions from observed H1 and registered description.
  const suggestions = verified
    .map((page) => {
      const result: Record<string, string | null> = {
        url: page.url,
        title: page.title || (page.h1 ? page.h1.slice(0, 60) : null),
        description: page.metaDescription || (project.description ? project.description.slice(0, 160) : null),
        canonical: page.canonicalUrl ?? page.url,
      };
      return result;
    })
    .filter((s) => s.title || s.description);
  if (suggestions.length) {
    artifacts.push({
      kind: "metadata",
      path: "seo/metadata-suggestions.json",
      content: `${jsonLd(suggestions)}\n`,
      rationale:
        "Title suggestions use only observed page titles/H1 text; descriptions use only registered or observed text. Nothing is invented.",
    });
  }

  return artifacts;
}

/** Persists proposed artifacts; existing proposals are refreshed, not duplicated. */
export async function saveArtifacts(
  db: Database,
  projectId: string,
  artifacts: GeneratedArtifact[],
  options: { auditId?: string | null; createdByAgent?: string } = {},
): Promise<number> {
  for (const artifact of artifacts) {
    await db
      .insert(seoArtifacts)
      .values({
        projectId,
        kind: artifact.kind,
        path: artifact.path,
        content: artifact.content,
        framework: null,
        rationale: artifact.rationale,
        auditId: options.auditId ?? null,
        createdByAgent: options.createdByAgent ?? "TECHNICAL_SEO_AGENT",
        status: "proposed",
      })
      .onConflictDoUpdate({
        target: [seoArtifacts.projectId, seoArtifacts.kind, seoArtifacts.path],
        set: {
          content: artifact.content,
          rationale: artifact.rationale,
          auditId: options.auditId ?? null,
          updatedAt: new Date(),
        },
      });
  }
  return artifacts.length;
}

export async function listArtifacts(db: Database, projectId: string) {
  return db.select().from(seoArtifacts).where(eq(seoArtifacts.projectId, projectId));
}
