import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pages, projects, seoArtifacts } from "../src/core/db/schema";
import {
  auditUrl, checkRedirects, evaluatePage, parsePage,
} from "../src/core/seo/audit";
import { analyzeSite } from "../src/core/seo/site-audit";
import { generateArtifacts } from "../src/core/seo/artifacts";
import { registerAllAgents } from "../src/core/agents/definitions";
import { runAgent } from "../src/core/agents/framework";
import { seedIdentity, setupTestDb } from "./helpers";

let originalFetch: typeof globalThis.fetch;

const HTML = `<!doctype html><html lang="en"><head>
<title>Real Plumbing Services in London</title>
<meta name="description" content="Licensed local plumbers offering transparent quotes and 24/7 emergency callouts across London.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Real Plumbing Services">
<meta property="og:description" content="Local plumbing help when you need it.">
<meta property="og:image" content="https://example.com/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://example.com/">
<script type="application/ld+json">{"@type":"Organization","name":"Real Plumbing"}</script>
</head><body><h1>Real Plumbing Services</h1><p>${"Useful service information. ".repeat(12)}</p>
<img src="/a.jpg" alt="Plumber at work" width="800" height="600">
<a href="/contact">Contact</a></body></html>`;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  registerAllAgents();
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe("phase 4 — deep technical checks", () => {
  it("captures viewport, dimensions, OG and structured data from real HTML", () => {
    const snapshot = parsePage(HTML, "https://example.com/", 100);
    expect(snapshot.viewport).toContain("width=device-width");
    expect(snapshot.twitterCard).toBe("summary_large_image");
    expect(snapshot.imagesMissingDimensions).toBe(0);
    expect(snapshot.structuredDataTypes).toContain("Organization");
    expect(snapshot.structuredData[0]).toMatchObject({ "@type": "Organization", name: "Real Plumbing" });
    const findings = evaluatePage(snapshot, true);
    expect(findings.some((f) => f.id === "viewport.missing")).toBe(false);
    expect(findings.some((f) => f.id === "images.dimensions")).toBe(false);
  });

  it("flags unverifiable rating/review markup instead of accepting fabricated data", () => {
    const snapshot = parsePage(
      HTML.replace(
        '{"@type":"Organization","name":"Real Plumbing"}',
        '{"@type":"LocalBusiness","name":"Real Plumbing","aggregateRating":{"ratingValue":"5","reviewCount":"1000"}}',
      ),
      "https://example.com/",
      100,
    );
    const findings = evaluatePage(snapshot, true);
    const flagged = findings.find((f) => f.id === "structured-data.unverifiable");
    expect(flagged).toBeDefined();
    expect(flagged?.severity).toBe("critical");
  });

  it("detects redirect chains and loops from real HTTP responses", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/a")) return new Response(null, { status: 301, headers: { Location: "/b" } });
      if (url.includes("/b")) return new Response(null, { status: 302, headers: { Location: "/a" } });
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;
    const loop = await checkRedirects("https://example.com/a", { fetchImpl });
    expect(loop.loop).toBe(true);
    expect(loop.chain.length).toBeGreaterThan(1);

    const clean = await checkRedirects("https://example.com/final", { fetchImpl });
    expect(clean.loop).toBe(false);
    expect(clean.chain).toHaveLength(0);
  });

  it("audit result includes redirect evidence and honest limitations", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml", { status: 200 });
      if (url.includes("sitemap.xml")) return new Response("<urlset><loc>https://example.com/</loc></urlset>", { status: 200 });
      if (url.includes("/contact")) return new Response("ok", { status: 200 });
      return new Response(HTML, { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await auditUrl("https://example.com/", { fetchImpl, maxLinkChecks: 2 });
    expect(result.redirects).not.toBeNull();
    expect(result.limitations.join(" ")).toMatch(/Core Web Vitals/);
    expect(result.findings.some((f) => f.id === "structured-data.unverifiable")).toBe(false);
  });
});

describe("phase 4 — site-wide analysis", () => {
  it("detects duplicate content/titles and orphan pages from audited rows", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Site", slug: "site" }).returning())[0];
    await db.insert(pages).values([
      {
        projectId: project.id, url: "https://x.com/a", title: "Same Title", contentHash: "hash1", statusCode: 200,
        metadata: { internalLinks: ["https://x.com/b"] } as Record<string, unknown>,
      },
      {
        projectId: project.id, url: "https://x.com/b", title: "Same Title", contentHash: "hash1", statusCode: 200,
        metadata: { internalLinks: [] } as Record<string, unknown>,
      },
      {
        projectId: project.id, url: "https://x.com/c", title: "Other", contentHash: "hash2", statusCode: 200,
        metadata: { internalLinks: [] } as Record<string, unknown>,
      },
    ]);

    const analysis = await analyzeSite(db, project.id);
    expect(analysis.issues.map((i) => i.id)).toContain("duplicate.content");
    expect(analysis.issues.map((i) => i.id)).toContain("duplicate.title");
    expect(analysis.orphanUrls).toContain("https://x.com/a");
    expect(analysis.orphanUrls).toContain("https://x.com/c");
    expect(analysis.orphanUrls).not.toContain("https://x.com/b");

    const flagged = await db.select().from(pages).where(eq(pages.projectId, project.id));
    expect(flagged.filter((p) => p.isOrphan).length).toBe(2);
    await close();
  });
});

describe("phase 4 — artifact generation", () => {
  it("produces framework-aware artifacts with only verified data and no fabricated markup", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Real Plumbing", slug: "real-plumbing", framework: "Next.js",
      productionUrl: "https://plumbing.example", description: "Licensed local plumbers in London.",
    }).returning())[0];
    await db.insert(pages).values([
      { projectId: project.id, url: "https://plumbing.example/", statusCode: 200, title: "Home", h1: "Plumbing Services" },
      { projectId: project.id, url: "https://plumbing.example/about", statusCode: 200, title: "About", h1: "About Us" },
    ]);
    const rows = await db.select().from(pages).where(eq(pages.projectId, project.id));

    const nextArtifacts = generateArtifacts(project, rows, project.framework);
    expect(nextArtifacts.map((a) => a.path)).toContain("src/app/sitemap.ts");
    expect(nextArtifacts.map((a) => a.path)).toContain("public/robots.txt");
    const ld = nextArtifacts.find((a) => a.kind === "structured-data")!;
    expect(ld.content).not.toMatch(/aggregateRating|review|testimonial|"price"|"telephone"/i);

    const staticArtifacts = generateArtifacts(project, rows, "Static HTML");
    expect(staticArtifacts.map((a) => a.path)).toContain("sitemap.xml");
    await close();
  });

  it("technical agent generates and persists artifact proposals from real pages", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({
      workspaceId, name: "Artifact Site", slug: "artifact-site", framework: "React",
      productionUrl: "https://artifact.example", description: "A real business description.",
    }).returning())[0];
    await db.insert(pages).values({
      projectId: project.id, url: "https://artifact.example/", statusCode: 200, title: "Home", h1: "Welcome",
    });
    const { result } = await runAgent(db, "TECHNICAL_SEO_AGENT", {
      workspaceId, projectId: project.id, input: { mode: "generate-artifacts" },
    });
    expect(result.skippedReason).toBeUndefined();
    expect(result.data?.generated).toBeGreaterThan(0);
    const stored = await db.select().from(seoArtifacts).where(eq(seoArtifacts.projectId, project.id));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((a) => a.status === "proposed")).toBe(true);
    await close();
  });

  it("site-analysis agent mode persists orphan flags", async () => {
    const { db, close } = await setupTestDb();
    const { workspaceId } = await seedIdentity(db);
    const project = (await db.insert(projects).values({ workspaceId, name: "Orphans", slug: "orphans" }).returning())[0];
    await db.insert(pages).values({
      projectId: project.id, url: "https://orphan.example/x", statusCode: 200, title: "X",
      metadata: { internalLinks: [] } as Record<string, unknown>,
    });
    const { result } = await runAgent(db, "TECHNICAL_SEO_AGENT", {
      workspaceId, projectId: project.id, input: { mode: "site-analysis" },
    });
    expect(result.summary).toMatch(/Analyzed 1 audited page/);
    const stored = await db.select().from(pages).where(eq(pages.projectId, project.id));
    expect(stored[0].isOrphan).toBe(true);
    await close();
  });
});
