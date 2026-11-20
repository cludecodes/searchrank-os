import type { SearchIntent } from "../db/schema";

/** Intent inferred from observable keyword text only. */
export function classifyIntent(term: string): SearchIntent {
  const value = term.toLowerCase();
  if (/\b(buy|price|prices|cost|order|discount|deal|checkout|hire|quote|booking|book|emergency)\b/.test(value)) return "transactional";
  if (/\b(best|review|reviews|vs|versus|compare|comparison|alternative|alternatives|top)\b/.test(value)) return "commercial";
  if (/\b(login|sign in|dashboard|download|website|official|support|contact)\b/.test(value)) return "navigational";
  return "informational";
}

export interface ValueInput {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  intent: SearchIntent;
  commercialRelevance: number;
}

const INTENT_WEIGHT: Record<SearchIntent, number> = {
  transactional: 1,
  commercial: 0.8,
  navigational: 0.3,
  informational: 0.45,
};

/**
 * Commercial relevance derived from intent and observed demand signals.
 * Never uses invented search volume or difficulty.
 */
export function commercialRelevance(input: {
  term: string;
  intent: SearchIntent;
  clicks: number;
  impressions: number;
  businessCategory?: string | null;
}): number {
  const intentScore = INTENT_WEIGHT[input.intent];
  const demandSignal = Math.min(1, Math.log10(1 + input.clicks) / 2);
  const visibilitySignal = Math.min(1, Math.log10(1 + input.impressions) / 4);
  const categoryLift =
    input.businessCategory && input.businessCategory !== "general"
      ? new RegExp(input.businessCategory.replace(/-/g, "|"), "i").test(input.term)
        ? 0.1
        : 0
      : 0;
  return Number(Math.min(1, intentScore * 0.6 + demandSignal * 0.25 + visibilitySignal * 0.15 + categoryLift).toFixed(3));
}

/**
 * Prioritizes by realistic business value: observed clicks, commercial intent,
 * and achievable ranking positions — not search volume alone.
 */
export function businessValueScore(input: ValueInput): number {
  const clicks = Math.min(1, Math.log10(1 + input.clicks) / 2);
  const visibility = Math.min(1, Math.log10(1 + input.impressions) / 4);
  // Positions 4–20 are realistic first-page opportunities; deep positions get a smaller boost.
  const opportunity = input.position >= 4 && input.position <= 20 ? 1 : input.position > 20 ? 0.45 : 0.3;
  const ctrGap = input.ctr < 0.05 && input.impressions >= 50 ? 0.5 : 0;
  const score =
    clicks * 35 +
    visibility * 15 +
    INTENT_WEIGHT[input.intent] * 20 +
    input.commercialRelevance * 20 +
    opportunity * 10 +
    ctrGap * 5;
  return Math.round(Math.max(0, Math.min(100, score)));
}

export interface OpportunityInput {
  keyword: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

/** Underserved = real impressions, weak CTR, position within striking distance. */
export function detectOpportunities(rows: OpportunityInput[]): OpportunityInput[] {
  return rows.filter(
    (row) =>
      row.impressions >= 50 &&
      row.position >= 4 &&
      row.position <= 20 &&
      row.ctr < 0.08,
  );
}

export interface TrendPoint {
  rank: number | null;
  recordedAt: Date | string;
}

/** Rank change from the two most recent snapshots. Negative means improvement. */
export function rankTrend(history: TrendPoint[]): number | null {
  if (history.length < 2) return null;
  const ordered = [...history].sort(
    (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
  );
  const previous = ordered[ordered.length - 2].rank;
  const current = ordered[ordered.length - 1].rank;
  if (previous === null || current === null) return null;
  return Number((current - previous).toFixed(2));
}

/** Competitor URLs only from registered competitors whose observed headings
 *  or content gaps mention the keyword topic. No guessed competitor URLs. */
export function associateCompetitorUrls(
  term: string,
  competitors: Array<{ domain: string; strengths: string[]; contentGaps: string[] }>,
): string[] {
  const words = term.toLowerCase().split(/\W+/).filter((word) => word.length > 4);
  const urls: string[] = [];
  for (const competitor of competitors) {
    const observed = [...competitor.strengths, ...competitor.contentGaps].join(" ").toLowerCase();
    if (words.length && words.some((word) => observed.includes(word))) {
      urls.push(competitor.domain.startsWith("http") ? competitor.domain : `https://${competitor.domain}`);
    }
  }
  return [...new Set(urls)];
}
