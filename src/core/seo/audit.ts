import * as cheerio from "cheerio";
import { createHash } from "node:crypto";

export type FindingSeverity = "critical" | "warning" | "info" | "pass";
export type FindingCategory =
  | "metadata"
  | "semantics"
  | "crawlability"
  | "structured-data"
  | "content"
  | "performance"
  | "links"
  | "images"
  | "social";

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  detail: string;
  recommendation?: string;
  evidence?: string;
  weight: number;
}

export interface PageSnapshot {
  url: string;
  finalUrl: string;
  statusCode: number;
  title: string | null;
  metaDescription: string | null;
  robots: string | null;
  canonical: string | null;
  lang: string | null;
  h1Count: number;
  headingOutline: Array<{ level: number; text: string }>;
  openGraph: Record<string, string>;
  twitterCard: string | null;
  structuredDataTypes: string[];
  structuredData: Array<Record<string, unknown>>;
  viewport: string | null;
  imagesTotal: number;
  imagesMissingAlt: number;
  imagesMissingDimensions: number;
  internalLinks: string[];
  externalLinks: string[];
  wordCount: number;
  contentHash: string;
  ttfbMs: number;
}

export interface LinkCheck {
  sourceUrl: string;
  targetUrl: string;
  kind: "internal" | "external";
  statusCode: number | null;
  isBroken: boolean;
}

export interface RedirectCheck {
  from: string;
  chain: string[];
  finalUrl: string;
  statusCodes: number[];
  loop: boolean;
}

export interface RobotsSitemapCheck {
  robotsFound: boolean;
  robotsDisallowsAll: boolean;
  sitemapDeclared: string[];
  sitemapReachable: boolean | null;
  sitemapUrlCount: number | null;
}

export interface AuditResult {
  auditedUrl: string;
  auditedAt: string;
  score: number;
  findings: Finding[];
  page: PageSnapshot | null;
  robotsSitemap: RobotsSitemapCheck;
  linkChecks: LinkCheck[];
  redirects: RedirectCheck | null;
  limitations: string[];
}

export interface AuditOptions {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxLinkChecks?: number;
  userAgent?: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; SearchRankOS/1.0; +https://searchrank.os/bot)";

/** Rejects private/loopback targets in production to prevent SSRF. */
export function assertPublicUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs can be audited.");
  if (process.env.NODE_ENV === "production") {
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error(`Refusing to audit private address: ${host}`);
    }
  }
  return url;
}

async function fetchWithTimeout(
  url: string,
  options: AuditOptions,
): Promise<{ response: Response; body: string; elapsedMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const started = Date.now();
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
      headers: { "User-Agent": options.userAgent ?? DEFAULT_UA, Accept: "text/html,application/xml,text/plain,*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    return { response, body, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Follows redirects manually so chains and loops can be reported accurately. */
export async function checkRedirects(
  url: string,
  options: AuditOptions = {},
): Promise<RedirectCheck> {
  const chain: string[] = [];
  const statusCodes: number[] = [];
  const seen = new Set<string>();
  let current = url;
  let loop = false;

  for (let hop = 0; hop < 6; hop++) {
    if (seen.has(current)) { loop = true; break; }
    seen.add(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(current, {
        headers: { "User-Agent": options.userAgent ?? DEFAULT_UA },
        redirect: "manual",
        signal: controller.signal,
      });
      statusCodes.push(response.status);
      const location = response.headers?.get?.("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).toString();
        chain.push(next);
        current = next;
        continue;
      }
      break;
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  return { from: url, chain, finalUrl: current, statusCodes, loop };
}

function absoluteUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Parses a captured HTML document into a structured snapshot. */
export function parsePage(html: string, finalUrl: string, ttfbMs: number): PageSnapshot {
  const $ = cheerio.load(html);
  const origin = new URL(finalUrl).origin;
  const title = $("title").first().text().trim() || null;
  const metaDescription =
    $("meta[name='description']").first().attr("content")?.trim() ||
    $("meta[property='og:description']").first().attr("content")?.trim() ||
    null;
  const robots = $("meta[name='robots']").first().attr("content")?.trim() ?? null;
  const canonicalHref = $("link[rel='canonical']").first().attr("href");
  const canonical = canonicalHref ? absoluteUrl(canonicalHref, finalUrl) : null;
  const lang = $("html").first().attr("lang")?.trim() ?? null;

  const headings: Array<{ level: number; text: string }> = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const level = Number(tag.replace("h", ""));
    if (level >= 1 && level <= 6) {
      headings.push({ level, text: $(el).text().replace(/\s+/g, " ").trim() });
    }
  });

  const openGraph: Record<string, string> = {};
  $("meta[property^='og:']").each((_, el) => {
    const key = $(el).attr("property")?.replace(/^og:/, "");
    const value = $(el).attr("content");
    if (key && value) openGraph[key] = value;
  });
  const twitterCard = $("meta[name='twitter:card']").first().attr("content")?.trim() ?? null;
  const viewport = $("meta[name='viewport']").first().attr("content")?.trim() ?? null;

  const structuredDataTypes: string[] = [];
  const structuredData: Array<Record<string, unknown>> = [];
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() ?? "") as unknown;
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (entry && typeof entry === "object") structuredData.push(entry as Record<string, unknown>);
        const type = (entry as { "@type"?: unknown })?.["@type"];
        if (typeof type === "string") structuredDataTypes.push(type);
        else if (Array.isArray(type)) structuredDataTypes.push(...type.filter((t): t is string => typeof t === "string"));
      }
    } catch {
      structuredDataTypes.push("InvalidJSONLD");
    }
  });

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let imagesMissingDimensions = 0;
  $("img").each((_, el) => {
    imagesTotal++;
    const alt = $(el).attr("alt");
    if (alt === undefined || alt.trim() === "") imagesMissingAlt++;
    if (!$(el).attr("width") || !$(el).attr("height")) imagesMissingDimensions++;
  });

  const internal = new Set<string>();
  const external = new Set<string>();
  $("a[href]").each((_, el) => {
    const resolved = absoluteUrl($(el).attr("href") ?? "", finalUrl);
    if (!resolved) return;
    if (new URL(resolved).origin === origin) internal.add(resolved);
    else external.add(resolved);
  });

  const text = $("script, style, noscript, svg").remove().end().text().replace(/\s+/g, " ").trim();
  const wordCount = text ? text.split(" ").length : 0;

  return {
    url: finalUrl,
    finalUrl,
    statusCode: 200,
    title,
    metaDescription,
    robots,
    canonical,
    lang,
    h1Count: headings.filter((h) => h.level === 1).length,
    headingOutline: headings,
    openGraph,
    twitterCard,
    structuredDataTypes,
    structuredData,
    viewport,
    imagesTotal,
    imagesMissingAlt,
    imagesMissingDimensions,
    internalLinks: [...internal],
    externalLinks: [...external],
    wordCount,
    contentHash: createHash("sha256").update(text).digest("hex"),
    ttfbMs,
  };
}

function finding(
  id: string,
  category: FindingCategory,
  severity: FindingSeverity,
  title: string,
  detail: string,
  weight: number,
  recommendation?: string,
  evidence?: string,
): Finding {
  return { id, category, severity, title, detail, weight, recommendation, evidence };
}

/** Deterministic deduction-based score. Only observed failures reduce it. */
export function calculateScore(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.severity === "critical") score -= f.weight;
    else if (f.severity === "warning") score -= Math.round(f.weight * 0.5);
  }
  return Math.max(0, Math.min(100, score));
}

export function evaluatePage(snapshot: PageSnapshot, declaredSitemap: boolean): Finding[] {
  const findings: Finding[] = [];
  const titleLength = snapshot.title?.length ?? 0;
  if (!snapshot.title) {
    findings.push(finding("title.missing", "metadata", "critical", "Missing title tag", "No <title> element was found.", 12, "Add a unique, descriptive title tag to this page."));
  } else if (titleLength < 30 || titleLength > 65) {
    findings.push(finding("title.length", "metadata", "warning", "Title length outside 30–65 characters", `Observed length: ${titleLength}.`, 5, "Rewrite the title to 30–65 characters.", snapshot.title ?? undefined));
  } else {
    findings.push(finding("title.ok", "metadata", "pass", "Title tag present", `Length: ${titleLength}.`, 0));
  }

  const descLength = snapshot.metaDescription?.length ?? 0;
  if (!snapshot.metaDescription) {
    findings.push(finding("description.missing", "metadata", "critical", "Missing meta description", "No usable meta description was found.", 8, "Add a unique 120–160 character meta description."));
  } else if (descLength < 70 || descLength > 165) {
    findings.push(finding("description.length", "metadata", "warning", "Meta description length outside 70–165 characters", `Observed length: ${descLength}.`, 4, "Adjust the description length.", snapshot.metaDescription ?? undefined));
  } else {
    findings.push(finding("description.ok", "metadata", "pass", "Meta description present", `Length: ${descLength}.`, 0));
  }

  if (!snapshot.canonical) {
    findings.push(finding("canonical.missing", "crawlability", "warning", "No canonical URL declared", "No rel=canonical link was found.", 6, "Declare a self-referencing canonical URL."));
  } else if (new URL(snapshot.canonical).origin + new URL(snapshot.canonical).pathname !==
    new URL(snapshot.finalUrl).origin + new URL(snapshot.finalUrl).pathname) {
    findings.push(finding("canonical.mismatch", "crawlability", "warning", "Canonical URL differs from final URL", `Canonical: ${snapshot.canonical}`, 6, "Verify the canonical is intentional.", snapshot.finalUrl));
  } else {
    findings.push(finding("canonical.ok", "crawlability", "pass", "Canonical matches final URL", snapshot.canonical, 0));
  }

  if (snapshot.robots && /noindex/i.test(snapshot.robots)) {
    findings.push(finding("robots.noindex", "crawlability", "critical", "Page is set to noindex", `robots: ${snapshot.robots}`, 20, "Remove noindex if this page should rank.", snapshot.robots));
  }

  if (snapshot.h1Count === 0) {
    findings.push(finding("h1.missing", "semantics", "critical", "No H1 heading", "The page contains no <h1>.", 8, "Add exactly one descriptive H1."));
  } else if (snapshot.h1Count > 1) {
    findings.push(finding("h1.multiple", "semantics", "warning", "Multiple H1 headings", `Found ${snapshot.h1Count} H1 elements.`, 4, "Use a single primary H1."));
  } else {
    findings.push(finding("h1.ok", "semantics", "pass", "Single H1 heading", "", 0));
  }

  if (!snapshot.lang) {
    findings.push(finding("lang.missing", "semantics", "warning", "No document language", "<html> has no lang attribute.", 4, "Set the correct lang attribute."));
  }

  let previousLevel = 1;
  let skipped = false;
  for (const heading of snapshot.headingOutline) {
    if (heading.level > previousLevel + 1) skipped = true;
    previousLevel = heading.level;
  }
  if (skipped) {
    findings.push(finding("heading.skipped", "semantics", "info", "Heading levels skip a rank", "At least one heading jumps more than one level.", 2, "Keep heading hierarchy sequential."));
  }

  // Ratings/testimonials cannot be verified from HTML. Flag for human review
  // rather than accepting or emitting fabricated structured data.
  const unverifiableMarkup = snapshot.structuredData.filter(
    (entry) => "aggregateRating" in entry || "review" in entry || "testimonial" in entry,
  );
  if (unverifiableMarkup.length) {
    findings.push(finding(
      "structured-data.unverifiable",
      "structured-data",
      "critical",
      "Unverifiable rating/review markup detected",
      `${unverifiableMarkup.length} structured-data block(s) contain aggregateRating, review or testimonial fields. These cannot be validated from HTML.`,
      10,
      "Remove unless the rating is real and independently verifiable. Never fabricate ratings or testimonials.",
    ));
  }

  if (snapshot.structuredDataTypes.length === 0) {
    findings.push(finding("structured-data.missing", "structured-data", "info", "No structured data detected", "No valid JSON-LD types were found.", 2, "Add structured data only when it describes real, verifiable entities."));
  } else if (snapshot.structuredDataTypes.includes("InvalidJSONLD")) {
    findings.push(finding("structured-data.invalid", "structured-data", "warning", "Invalid JSON-LD detected", "At least one JSON-LD block failed to parse.", 4, "Fix the JSON-LD syntax."));
  } else {
    findings.push(finding("structured-data.ok", "structured-data", "pass", "Structured data present", snapshot.structuredDataTypes.join(", "), 0));
  }

  if (snapshot.imagesMissingAlt > 0) {
    findings.push(finding("images.alt", "images", "warning", "Images missing alt text", `${snapshot.imagesMissingAlt} of ${snapshot.imagesTotal} images have no alt attribute.`, 5, "Add descriptive alt text; use alt=\"\" for decorative images."));
  }
  if (snapshot.imagesMissingDimensions > 0) {
    findings.push(finding("images.dimensions", "images", "info", "Images without declared dimensions", `${snapshot.imagesMissingDimensions} of ${snapshot.imagesTotal} images omit width/height, which can cause layout shift.`, 2, "Declare intrinsic width and height or an aspect-ratio."));
  }

  if (!snapshot.viewport) {
    findings.push(finding("viewport.missing", "crawlability", "warning", "No viewport meta tag", "The page does not declare a viewport, so mobile rendering may be poor.", 5, "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">. True mobile friendliness still requires lab/field data."));
  }

  if (snapshot.wordCount < 150) {
    findings.push(finding("content.thin", "content", "warning", "Low visible text volume", `Approximately ${snapshot.wordCount} visible words.`, 5, "Add genuinely useful content that answers search intent."));
  }

  if (!snapshot.openGraph.title || !snapshot.openGraph.description) {
    findings.push(finding("og.incomplete", "social", "info", "Open Graph metadata incomplete", "og:title and/or og:description missing.", 2, "Complete Open Graph metadata for social sharing."));
  }
  if (!snapshot.openGraph.image) {
    findings.push(finding("og.image.missing", "social", "info", "No og:image declared", "Social shares will not have a preview image.", 1, "Add an og:image pointing to a real image."));
  }
  if (!snapshot.twitterCard) {
    findings.push(finding("twitter.card.missing", "social", "info", "No Twitter card declared", "twitter:card meta tag is absent.", 1, "Add twitter:card=summary_large_image when appropriate."));
  }

  if (!declaredSitemap) {
    findings.push(finding("sitemap.undeclared", "crawlability", "warning", "No sitemap declared in robots.txt", "robots.txt did not declare a sitemap.", 5, "Declare the XML sitemap in robots.txt."));
  }

  if (snapshot.ttfbMs > 1200) {
    findings.push(finding("performance.ttfb", "performance", "warning", "Slow first byte", `TTFB was ${snapshot.ttfbMs} ms in this environment.`, 5, "Investigate server/edge latency. Core Web Vitals require field data and are not inferred."));
  }

  return findings;
}

/** Runs a complete audit against one live URL. */
export async function auditUrl(url: string, options: AuditOptions = {}): Promise<AuditResult> {
  const target = assertPublicUrl(url);
  const limitations: string[] = [
    "Core Web Vitals and mobile friendliness require field/lab data from GSC or PageSpeed Insights and are reported as unavailable unless an integration provides them.",
    "Rankings and traffic are never inferred from an HTML audit.",
  ];

  let page: PageSnapshot | null = null;
  let findings: Finding[] = [];
  const linkChecks: LinkCheck[] = [];
  let responseStatus = 0;

  try {
    const { response, body, elapsedMs } = await fetchWithTimeout(target.toString(), options);
    responseStatus = response.status;
    if (!response.ok) {
      findings.push(finding("http.status", "crawlability", "critical", `Page returned HTTP ${response.status}`, target.toString(), 20, "Fix the server response before optimizing other factors."));
    } else {
      page = parsePage(body, response.url || target.toString(), elapsedMs);
      page.statusCode = response.status;
    }
  } catch (error) {
    findings.push(finding("http.fetch", "crawlability", "critical", "Page could not be fetched", error instanceof Error ? error.message : String(error), 20, "Check DNS, TLS, firewall and server availability."));
  }

  const base = `${target.protocol}//${target.host}`;
  const robotsSitemap = await checkRobotsAndSitemap(base, options);
  const redirects = await checkRedirects(target.toString(), options);
  if (redirects.loop) {
    findings.push(finding("redirect.loop", "crawlability", "critical", "Redirect loop detected", redirects.chain.join(" → "), 15, "Break the redirect cycle."));
  } else if (redirects.chain.length > 2) {
    findings.push(finding("redirect.chain", "crawlability", "warning", `Redirect chain of ${redirects.chain.length} hops`, redirects.chain.join(" → "), 4, "Point links directly at the final URL."));
  }
  if (page) findings.push(...evaluatePage(page, robotsSitemap.sitemapDeclared.length > 0));

  const maxChecks = options.maxLinkChecks ?? 10;
  if (page) {
    for (const link of page.internalLinks.slice(0, maxChecks)) {
      try {
        const { response } = await fetchWithTimeout(link, { ...options, timeoutMs: options.timeoutMs ?? 8000 });
        linkChecks.push({
          sourceUrl: page.finalUrl,
          targetUrl: link,
          kind: "internal",
          statusCode: response.status,
          isBroken: response.status >= 400,
        });
      } catch {
        linkChecks.push({ sourceUrl: page.finalUrl, targetUrl: link, kind: "internal", statusCode: null, isBroken: true });
      }
    }
    const broken = linkChecks.filter((l) => l.isBroken).length;
    if (broken > 0) {
      findings.push(finding("links.broken", "links", "warning", `${broken} broken internal link(s) detected`, "Checked a bounded sample of internal links.", 5, "Fix or redirect broken internal links."));
    }
  }

  return {
    auditedUrl: target.toString(),
    auditedAt: new Date().toISOString(),
    score: calculateScore(findings),
    findings,
    page,
    robotsSitemap,
    linkChecks,
    redirects,
    limitations,
  };
}

export async function checkRobotsAndSitemap(
  baseUrl: string,
  options: AuditOptions = {},
): Promise<RobotsSitemapCheck> {
  const result: RobotsSitemapCheck = {
    robotsFound: false,
    robotsDisallowsAll: false,
    sitemapDeclared: [],
    sitemapReachable: null,
    sitemapUrlCount: null,
  };
  try {
    const robotsUrl = `${baseUrl.replace(/\/$/, "")}/robots.txt`;
    const { body } = await fetchWithTimeout(robotsUrl, { ...options, timeoutMs: options.timeoutMs ?? 8000 });
    result.robotsFound = true;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^Sitemap:/i.test(trimmed)) result.sitemapDeclared.push(trimmed.replace(/^Sitemap:\s*/i, "").trim());
      if (/^Disallow:\s*\/\s*$/i.test(trimmed)) result.robotsDisallowsAll = true;
    }
  } catch {
    // A missing robots.txt is itself a finding, handled by evaluatePage.
  }

  const sitemapUrl = result.sitemapDeclared[0] ?? `${baseUrl.replace(/\/$/, "")}/sitemap.xml`;
  try {
    const { body } = await fetchWithTimeout(sitemapUrl, { ...options, timeoutMs: options.timeoutMs ?? 8000 });
    result.sitemapReachable = true;
    result.sitemapUrlCount = (body.match(/<loc\s*>/g) ?? []).length;
  } catch {
    result.sitemapReachable = false;
  }
  return result;
}

/** Generates a sitemap from verified page URLs. No invented URLs. */
export function generateSitemap(urls: string[], lastModified?: Date): string {
  const unique = [...new Set(urls)].filter((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  });
  const today = (lastModified ?? new Date()).toISOString().slice(0, 10);
  const entries = unique
    .map((u) => `  <url><loc>${escapeXml(u)}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function generateRobotsTxt(sitemapUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}
