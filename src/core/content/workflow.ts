import type { ContentItem, ContentStatus, Keyword, Project } from "../db/schema";

export const ALLOWED_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  idea: ["brief", "rejected"],
  brief: ["draft", "rejected"],
  draft: ["in_review", "rejected"],
  in_review: ["approved", "rejected", "draft"],
  approved: ["published", "draft"],
  published: [],
  rejected: ["idea"],
};

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Required fields for each editorial stage. Everything must come from real data. */
export function validateContentItem(
  item: Pick<
    ContentItem,
    | "status"
    | "title"
    | "intent"
    | "clusterId"
    | "audience"
    | "uniqueValueProposition"
    | "supportingResearch"
    | "internalLinkPlan"
    | "proposedUrl"
    | "metaTitle"
    | "metaDescription"
    | "body"
  >,
): string[] {
  const missing: string[] = [];
  if (!item.title?.trim()) missing.push("title");
  if (!item.intent) missing.push("search intent");
  if (!item.clusterId) missing.push("target keyword cluster");
  if (!item.audience?.trim()) missing.push("audience");
  if (!item.uniqueValueProposition?.trim()) missing.push("unique value proposition");
  if (!item.supportingResearch?.length) missing.push("supporting research");
  if (!item.internalLinkPlan?.length) missing.push("internal linking plan");
  if (!item.proposedUrl?.trim()) missing.push("proposed URL");
  if (!item.metaTitle?.trim() || !item.metaDescription?.trim()) missing.push("metadata");
  if ((item.status === "draft" || item.status === "in_review" || item.status === "approved" || item.status === "published") && !item.body?.trim()) {
    missing.push("body");
  }
  return missing;
}

const FABRICATED_CLAIMS = [
  /guaranteed\s+(?:#?1|first|top)\s+(?:rank|position|spot)/i,
  /\b\d[\d,]*\s*[-\s]?star\b/i,
  /\b100%\s+(?:guaranteed|risk[- ]free)\b/i,
  /#1\s+on\s+google/i,
  /(?:fake|fabricated|invented)\s+(?:review|testimonial)/i,
  /\bwe\s+have\s+(?:helped|served)\s+\d/i,
];

export interface QualityReport {
  wordCount: number;
  keywordDensity: number | null;
  fabricatedClaims: string[];
  duplicateRisk: number;
  passed: boolean;
  notes: string[];
}

/** Checks only observable text properties; field data is never invented. */
export function checkContentQuality(
  body: string,
  existingBodies: string[],
  targetKeyword?: string | null,
): QualityReport {
  const words = body.toLowerCase().split(/\W+/).filter(Boolean);
  const wordCount = words.length;
  const notes: string[] = [];
  const fabricatedClaims = FABRICATED_CLAIMS.filter((pattern) => pattern.test(body)).map((p) => p.source);

  let keywordDensity: number | null = null;
  if (targetKeyword && wordCount) {
    const terms = targetKeyword.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = terms.length
      ? words.reduce((count, word, index) =>
          terms.every((term, offset) => words[index + offset] === term) ? count + 1 : count, 0)
      : 0;
    keywordDensity = Number(((matches / wordCount) * 100).toFixed(2));
    if (keywordDensity > 4) notes.push("Keyword density above 4% — likely keyword stuffing.");
  }
  if (wordCount < 300) notes.push("Thin content: fewer than 300 words.");

  const shingles = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 5));
  const candidate = shingles(body);
  let maxOverlap = 0;
  for (const other of existingBodies) {
    const set = shingles(other);
    if (!candidate.size) break;
    maxOverlap = Math.max(maxOverlap, [...candidate].filter((w) => set.has(w)).length / candidate.size);
  }
  const duplicateRisk = Number((1 - maxOverlap).toFixed(3));
  if (duplicateRisk < 0.75) notes.push("High overlap with existing content — possible duplicate.");

  return {
    wordCount,
    keywordDensity,
    fabricatedClaims,
    duplicateRisk,
    passed: fabricatedClaims.length === 0 && wordCount >= 300 && (keywordDensity === null || keywordDensity <= 4) && duplicateRisk >= 0.75,
    notes,
  };
}

export interface BriefEvidence {
  project: Project;
  keyword: Keyword;
  cluster: { name: string; description: string | null; targetUrl: string | null } | null;
  competitors: Array<{ domain: string; contentGaps: string[]; strengths: string[] }>;
  pages: Array<{ url: string; title: string | null }>;
  questionQueries: string[];
}

/**
 * Builds an editorial brief strictly from persisted evidence. A brief is a
 * plan, not fabricated article text — so it does not require an AI provider.
 */
export function buildBriefFromEvidence(input: BriefEvidence) {
  const { project, keyword, cluster, competitors, pages, questionQueries } = input;
  const audience = project.businessCategory
    ? `Buyers and researchers seeking ${project.businessCategory.replace(/-/g, " ")} information in ${project.country}.`
    : `Audience searching “${keyword.keyword}” in ${project.country}.`;
  const uvp = project.description?.trim()
    ? `Grounded in the registered business description: ${project.description.slice(0, 240)}`
    : `Evidence-led answer to “${keyword.keyword}” using the project's verified pages and observed search data. No unverified claims.`;

  const supportingResearch: string[] = [];
  if (keyword.sourceUrl) supportingResearch.push(`${keyword.source ?? "source"}: ${keyword.sourceUrl} (retrieved ${keyword.retrievedAt?.toISOString().slice(0, 10) ?? "unknown"})`);
  for (const competitor of competitors.slice(0, 5)) {
    const gap = competitor.contentGaps[0];
    supportingResearch.push(`${competitor.domain}: observed ${gap ? `gap “${gap}”` : "registered competitor"}`);
  }
  supportingResearch.push(`Target keyword “${keyword.keyword}” (${keyword.country}, ${keyword.intent ?? "unclassified"} intent).`);

  const internalLinkPlan = pages
    .filter((page) => page.url !== keyword.targetUrl)
    .slice(0, 8)
    .map((page) => page.url);

  const outline = [
    `Direct answer to “${keyword.keyword}”`,
    ...questionQueries.slice(0, 4).map((q) => `Answer: ${q}`),
    ...competitors.slice(0, 3).map((c) => `Differentiation versus ${c.domain} using verifiable facts only`),
    "Frequently asked questions",
  ];

  const slug = keyword.keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
  const proposedUrl = keyword.targetUrl ?? `/guides/${slug}`;

  return {
    title: keyword.keyword.charAt(0).toUpperCase() + keyword.keyword.slice(1),
    proposedUrl,
    intent: keyword.intent,
    audience,
    uniqueValueProposition: uvp,
    brief: {
      outline,
      cluster: cluster?.name ?? null,
      clusterDescription: cluster?.description ?? null,
      targetKeyword: keyword.keyword,
      country: keyword.country,
      intent: keyword.intent,
      source: keyword.source,
      retrievedAt: keyword.retrievedAt?.toISOString() ?? null,
    } as Record<string, unknown>,
    supportingResearch,
    internalLinkPlan,
    metaTitle: keyword.keyword.slice(0, 60),
    metaDescription: uvp.slice(0, 160),
  };
}
