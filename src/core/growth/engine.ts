import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  backlinkOpportunities, competitors, conversions, contentItems, growthOpportunities,
  keywords, pages, projects, searchMetrics, type Project,
} from "../db/schema";
import { classifyIntent } from "../keywords/intelligence";

export interface GrowthEvidence {
  project: Project;
  keywords: Array<{ keyword: string; intent: string | null; clicks: number; impressions: number; position: number | null; commercialRelevance: number | null }>;
  gaps: string[];
  referrals: Array<{ domain: string; type: string | null }>;
  questions: string[];
  thinPages: Array<{ url: string; wordCount: number | null }>;
}

/** Collects only persisted evidence — nothing is generated from imagination. */
export async function collectEvidence(db: Database, projectId: string): Promise<GrowthEvidence | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;

  const keywordRows = await db
    .select({
      keyword: keywords.keyword,
      intent: keywords.intent,
      clicks: sql<number>`coalesce(${keywords.priority}, 0)::int`,
      impressions: sql<number>`0::int`,
      position: keywords.currentRank,
      commercialRelevance: keywords.commercialRelevance,
    })
    .from(keywords)
    .where(eq(keywords.projectId, projectId))
    .orderBy(desc(keywords.priority))
    .limit(30);

  const competitorRows = await db
    .select({ contentGaps: competitors.contentGaps, weaknesses: competitors.weaknesses })
    .from(competitors)
    .where(eq(competitors.projectId, projectId));

  const referralRows = await db
    .select({ domain: backlinkOpportunities.domain, type: backlinkOpportunities.opportunityType })
    .from(backlinkOpportunities)
    .where(eq(backlinkOpportunities.projectId, projectId))
    .limit(30);

  const pageRows = await db
    .select({ url: pages.url, wordCount: pages.wordCount })
    .from(pages)
    .where(eq(pages.projectId, projectId));

  // Observed customer questions: real stored queries phrased as questions.
  const metricRows = await db
    .select({ query: searchMetrics.query })
    .from(searchMetrics)
    .where(eq(searchMetrics.projectId, projectId))
    .limit(200);
  const questions = metricRows
    .map((r) => r.query ?? "")
    .filter((q) => /^(how|what|why|when|where|which|can|does|is|are)\b/i.test(q));

  return {
    project,
    keywords: keywordRows.map((row) => ({
      keyword: row.keyword,
      intent: row.intent,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
      commercialRelevance: row.commercialRelevance,
    })),
    gaps: [...new Set(competitorRows.flatMap((c) => [...c.contentGaps, ...c.weaknesses]))],
    referrals: referralRows.map((r) => ({ domain: r.domain, type: r.type })),
    questions,
    thinPages: pageRows.filter((p) => (p.wordCount ?? 0) > 0 && (p.wordCount ?? 0) < 300),
  };
}

/** Builds growth opportunities from evidence and upserts them deterministically. */
export async function buildGrowthPlan(db: Database, projectId: string): Promise<{ created: number; evidence: GrowthEvidence | null }> {
  const evidence = await collectEvidence(db, projectId);
  if (!evidence) return { created: 0, evidence: null };
  const { project } = evidence;

  const opportunities: Array<{
    problem: string;
    searchDemand: string | null;
    buyerIntent: ReturnType<typeof classifyIntent> | null;
    competitorWeakness: string | null;
    contentOpportunity: string | null;
    conversionOpportunity: string | null;
    partnership: string | null;
    referral: string | null;
    score: number;
    evidence: Record<string, unknown>;
  }> = [];

  for (const keyword of evidence.keywords.slice(0, 12)) {
    const intent = (keyword.intent as ReturnType<typeof classifyIntent> | null) ?? classifyIntent(keyword.keyword);
    const relevance = Number(keyword.commercialRelevance ?? 0);
    const position = Number(keyword.position ?? 0);
    const opportunityScore =
      Math.round(relevance * 50 +
        (position >= 4 && position <= 20 ? 25 : position > 20 ? 10 : 5) +
        (intent === "transactional" || intent === "commercial" ? 20 : 5));

    opportunities.push({
      problem: `Searchers ask “${keyword.keyword}” — a real observed query for this project.`,
      searchDemand: `Observed in persisted keyword records with priority ${keyword.clicks}; current position ${position || "unknown"}.`,
      buyerIntent: intent,
      competitorWeakness: evidence.gaps[0] ? `Observed competitor gap: ${evidence.gaps[0]}` : null,
      contentOpportunity: `Create or improve a page that answers “${keyword.keyword}” with verifiable, useful information.`,
      conversionOpportunity: intent === "transactional" || intent === "commercial"
        ? `Add a clear, honest next step (quote, enquiry or product page) for “${keyword.keyword}”.`
        : null,
      partnership: null,
      referral: evidence.referrals[0] ? `Observed referral candidate: ${evidence.referrals[0].domain}` : null,
      score: opportunityScore,
      evidence: {
        keyword: keyword.keyword,
        source: "persisted_keyword",
        priority: keyword.clicks,
        currentPosition: keyword.position,
        commercialRelevance: keyword.commercialRelevance,
      },
    });
  }

  for (const question of evidence.questions.slice(0, 6)) {
    opportunities.push({
      problem: `Unanswered customer question: “${question}”`,
      searchDemand: "Observed as a real Search Console query.",
      buyerIntent: classifyIntent(question),
      competitorWeakness: null,
      contentOpportunity: `Add a direct answer to “${question}” on a relevant existing page.`,
      conversionOpportunity: "Answer the question, then offer a relevant, honest next step.",
      partnership: null,
      referral: null,
      score: 45,
      evidence: { query: question, source: "search_metrics" },
    });
  }

  for (const page of evidence.thinPages.slice(0, 6)) {
    opportunities.push({
      problem: `Thin page detected: ${page.url} (${page.wordCount} visible words in the last audit)`,
      searchDemand: null,
      buyerIntent: null,
      competitorWeakness: evidence.gaps[0] ?? null,
      contentOpportunity: `Expand ${page.url} with genuinely useful, verifiable information.`,
      conversionOpportunity: "Improve the page's conversion path only after the content is substantively improved.",
      partnership: null,
      referral: null,
      score: 35,
      evidence: { url: page.url, wordCount: page.wordCount, source: "audit" },
    });
  }

  const existing = await db
    .select({ problem: growthOpportunities.problem })
    .from(growthOpportunities)
    .where(eq(growthOpportunities.projectId, projectId));
  const knownProblems = new Set(existing.map((row) => row.problem));

  let created = 0;
  for (const opportunity of opportunities) {
    if (knownProblems.has(opportunity.problem)) continue;
    await db.insert(growthOpportunities).values({
      projectId,
      ...opportunity,
      status: "identified",
      createdByAgent: "GROWTH_AGENT",
    });
    created++;
  }

  void project;
  return { created, evidence };
}

/** Revenue/lead aggregates from real conversion records. */
export async function getGrowthMetrics(db: Database, projectId: string) {
  const [row] = await db
    .select({
      leads: sql<number>`count(*) filter (where ${conversions.kind} = 'lead')::int`,
      qualified: sql<number>`count(*) filter (where ${conversions.qualified})::int`,
      sales: sql<number>`count(*) filter (where ${conversions.kind} = 'sale')::int`,
      revenue: sql<number>`coalesce(sum(${conversions.revenue}), 0)::int`,
    })
    .from(conversions)
    .where(eq(conversions.projectId, projectId));

  const byLanding = await db
    .select({
      landingPage: conversions.landingPage,
      leads: sql<number>`count(*)::int`,
      revenue: sql<number>`coalesce(sum(${conversions.revenue}), 0)::int`,
    })
    .from(conversions)
    .where(eq(conversions.projectId, projectId))
    .groupBy(conversions.landingPage)
    .orderBy(desc(sql`sum(${conversions.revenue})`))
    .limit(10);

  return {
    leads: Number(row?.leads ?? 0),
    qualified: Number(row?.qualified ?? 0),
    sales: Number(row?.sales ?? 0),
    revenue: Number(row?.revenue ?? 0),
    byLanding: byLanding.map((r) => ({ landingPage: r.landingPage ?? "unknown", leads: Number(r.leads), revenue: Number(r.revenue) })),
    note: "All figures come from recorded conversions. Nothing is estimated.",
  };
}

export async function listOpportunities(db: Database, projectId: string) {
  return db.select().from(growthOpportunities)
    .where(eq(growthOpportunities.projectId, projectId))
    .orderBy(desc(growthOpportunities.score))
    .limit(100);
}

export async function recordConversion(
  db: Database,
  input: {
    projectId: string;
    kind: "lead" | "sale" | "signup" | "call" | "quote";
    count?: number;
    revenue?: number;
    currency?: string;
    qualified?: boolean;
    sourceUrl?: string;
    landingPage?: string;
    keyword?: string;
    submittedBy?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const created = await db.insert(conversions).values({
    projectId: input.projectId,
    kind: input.kind,
    count: input.count ?? 1,
    revenue: input.revenue ?? 0,
    currency: input.currency ?? "USD",
    qualified: input.qualified ?? false,
    sourceUrl: input.sourceUrl ?? null,
    landingPage: input.landingPage ?? null,
    keyword: input.keyword ?? null,
    submittedBy: input.submittedBy ?? null,
    metadata: input.metadata ?? {},
  }).returning();
  return created[0];
}
