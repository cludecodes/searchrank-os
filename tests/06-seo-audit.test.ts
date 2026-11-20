import { describe, expect, it } from "vitest";
import {
  auditUrl,
  calculateScore,
  checkRobotsAndSitemap,
  evaluatePage,
  generateRobotsTxt,
  generateSitemap,
  parsePage,
} from "../src/core/seo/audit";

const GOOD_HTML = `<!doctype html><html lang="en"><head>
<title>Emergency Plumber London | 24/7 Local Service</title>
<meta name="description" content="Licensed London plumbers available day and night. Transparent pricing, clear quotes and workmanship you can rely on.">
<link rel="canonical" href="https://example.com/plumber-london">
<meta property="og:title" content="Emergency Plumber London">
<meta property="og:description" content="Local plumbing help when you need it.">
<script type="application/ld+json">{"@type":"LocalBusiness","name":"Example Plumbing"}</script>
</head><body>
<h1>Emergency Plumber in London</h1><h2>Our services</h2>
<p>${"Useful information about local plumbing services. ".repeat(12)}</p>
<img src="/a.jpg" alt="Plumber at work"><img src="/b.jpg" alt="">
<a href="/contact">Contact</a><a href="https://external.test/page">External</a>
</body></html>`;

describe("technical SEO engine", () => {
  it("parses real HTML structure without inventing values", () => {
    const page = parsePage(GOOD_HTML, "https://example.com/plumber-london", 120);
    expect(page.title).toContain("Emergency Plumber");
    expect(page.canonical).toBe("https://example.com/plumber-london");
    expect(page.h1Count).toBe(1);
    expect(page.lang).toBe("en");
    expect(page.structuredDataTypes).toContain("LocalBusiness");
    expect(page.imagesMissingAlt).toBe(1);
    expect(page.internalLinks).toEqual(["https://example.com/contact"]);
    expect(page.externalLinks).toEqual(["https://external.test/page"]);
    expect(page.wordCount).toBeGreaterThan(50);
  });

  it("produces deterministic findings and a deduction-based score", () => {
    const good = parsePage(GOOD_HTML, "https://example.com/plumber-london", 100);
    const goodFindings = evaluatePage(good, true);
    expect(goodFindings.every((f) => f.severity === "pass" || f.severity === "info" || f.severity === "warning")).toBe(true);
    expect(calculateScore(goodFindings)).toBeGreaterThanOrEqual(80);

    const bad = parsePage("<html><body><p>thin</p></body></html>", "https://example.com/x", 2000);
    const badFindings = evaluatePage(bad, false);
    const ids = badFindings.map((f) => f.id);
    expect(ids).toContain("title.missing");
    expect(ids).toContain("description.missing");
    expect(ids).toContain("h1.missing");
    expect(ids).toContain("canonical.missing");
    expect(calculateScore(badFindings)).toBeLessThan(calculateScore(goodFindings));
  });

  it("declares limitations instead of fabricating Core Web Vitals", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml", { status: 200 });
      if (url.includes("sitemap.xml")) return new Response("<urlset><loc>https://example.com/a</loc></urlset>", { status: 200 });
      if (url.includes("/contact")) return new Response("ok", { status: 200 });
      const htmlResponse = new Response(GOOD_HTML, { status: 200 });
      Object.defineProperty(htmlResponse, "url", { value: "https://example.com/plumber-london" });
      return htmlResponse;
    }) as typeof globalThis.fetch;
    const result = await auditUrl("https://example.com/plumber-london", { fetchImpl, maxLinkChecks: 3 });
    expect(result.score).toBeGreaterThan(0);
    expect(result.robotsSitemap.sitemapUrlCount).toBe(1);
    expect(result.linkChecks).toHaveLength(1);
    expect(result.linkChecks[0].isBroken).toBe(false);
    expect(result.limitations.join(" ")).toMatch(/Core Web Vitals/);
  });

  it("reads robots.txt rules and sitemap declarations", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /\nSitemap: https://example.com/sitemap.xml", { status: 200 });
      return new Response("<urlset></urlset>", { status: 200 });
    }) as typeof globalThis.fetch;
    const check = await checkRobotsAndSitemap("https://example.com", { fetchImpl });
    expect(check.robotsFound).toBe(true);
    expect(check.robotsDisallowsAll).toBe(true);
    expect(check.sitemapDeclared).toHaveLength(1);
  });

  it("generates sitemaps and robots.txt from supplied URLs only", () => {
    const sitemap = generateSitemap(["https://example.com/a", "https://example.com/a", "javascript:alert(1)"]);
    expect((sitemap.match(/<loc>/g) ?? []).length).toBe(1);
    expect(sitemap).toContain("https://example.com/a");
    expect(sitemap).not.toContain("javascript:");
    expect(generateRobotsTxt("https://example.com/sitemap.xml")).toContain("Sitemap: https://example.com/sitemap.xml");
  });
});
