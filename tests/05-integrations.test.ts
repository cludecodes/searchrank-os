import { describe, expect, it } from "vitest";
import { GitHubClient, buildGitHubOAuthUrl } from "../src/core/integrations/github";
import { VercelClient, buildVercelOAuthUrl } from "../src/core/integrations/vercel";
import { GoogleSearchConsoleClient, buildGoogleOAuthUrl } from "../src/core/integrations/google-search-console";
import { BingWebmasterClient, buildBingOAuthUrl } from "../src/core/integrations/bing-webmaster";
import { submitToIndexNow } from "../src/core/integrations/indexnow";
import { encryptSecret, decryptSecret } from "../src/core/security/crypto";

function jsonFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown; headers?: Record<string, string> }) {
  return (async (url: string, init: RequestInit) => {
    const out = handler(url, init);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: (k: string) => out.headers?.[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(out.body),
      json: async () => out.body,
    } as Response;
  }) as typeof globalThis.fetch;
}

describe("integration clients", () => {
  it("builds least-privilege OAuth URLs with state", () => {
    const github = new URL(buildGitHubOAuthUrl("cid", "http://localhost/cb", "state123"));
    expect(github.searchParams.get("scope")).toContain("public_repo");
    expect(github.searchParams.get("state")).toBe("state123");
    const vercel = new URL(buildVercelOAuthUrl("cid", "http://localhost/cb", "s"));
    expect(vercel.searchParams.get("response_type")).toBe("code");
    const google = new URL(buildGoogleOAuthUrl("cid", "http://localhost/cb", "s"));
    expect(google.searchParams.get("access_type")).toBe("offline");
    const bing = new URL(buildBingOAuthUrl("cid", "http://localhost/cb", "s"));
    expect(bing.searchParams.get("scope")).toBe("webmaster.manage");
  });

  it("lists public GitHub repositories and omits private ones", async () => {
    const fetchImpl = jsonFetch(() => ({
      status: 200,
      body: [
        { id: 1, name: "public-one", full_name: "org/public-one", private: false, disabled: false, default_branch: "main", homepage: "https://one.example", owner: { login: "org" } },
        { id: 2, name: "secret", full_name: "org/secret", private: true, disabled: false, default_branch: "main", homepage: null, owner: { login: "org" } },
      ],
    }));
    const repos = await new GitHubClient({ accessToken: "t", fetchImpl }).listPublicRepositories();
    expect(repos.map((r) => r.name)).toEqual(["public-one"]);
  });

  it("detects Next.js from a package.json manifest", async () => {
    const pkg = Buffer.from(JSON.stringify({ dependencies: { next: "16.0.0" } })).toString("base64");
    const fetchImpl = jsonFetch((url) => {
      if (url.includes("package.json")) return { status: 200, body: { content: pkg, sha: "abc", path: "package.json" } };
      return { status: 404, body: { message: "Not Found" } };
    });
    const framework = await new GitHubClient({ accessToken: "t", fetchImpl }).detectFramework("org", "repo", "main");
    expect(framework).toBe("Next.js");
  });

  it("creates a branch and pull request through the GitHub API", async () => {
    const calls: string[] = [];
    const fetchImpl = jsonFetch((url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url.includes("git/ref/heads")) return { status: 200, body: { object: { sha: "sha123" } } };
      if (url.includes("/pulls")) return { status: 201, body: { html_url: "https://github.com/o/r/pull/7", number: 7 } };
      return { status: 200, body: {} };
    });
    const client = new GitHubClient({ accessToken: "t", fetchImpl });
    await client.createBranch("o", "r", "seo/1", "main");
    const pr = await client.createPullRequest("o", "r", { title: "SEO", head: "seo/1", base: "main", body: "..." });
    expect(pr.number).toBe(7);
    expect(calls.some((c) => c.includes("refs"))).toBe(true);
  });

  it("paginates Vercel projects and resolves production info", async () => {
    const fetchImpl = jsonFetch((url) => {
      if (url.includes("/v9/projects")) {
        return { status: 200, body: { projects: [{ id: "p1", name: "site", targets: { production: { url: "site.vercel.app" } } }], pagination: {} } };
      }
      return { status: 200, body: { deployments: [{ id: "d1", url: "site.vercel.app", state: "READY", target: "production" }] } };
    });
    const client = new VercelClient({ accessToken: "t", fetchImpl });
    const projects = await client.listProjects();
    expect(projects[0].name).toBe("site");
    const info = await client.getProductionInfo("p1");
    expect(info.url).toBe("site.vercel.app");
  });

  it("queries Search Console analytics and unwraps Bing responses", async () => {
    const gscFetch = jsonFetch((url) =>
      url.includes("searchAnalytics")
        ? { status: 200, body: { rows: [{ keys: ["plumber london", "https://x.com/", "GB", "MOBILE"], clicks: 5, impressions: 100, ctr: 0.05, position: 8 }] } }
        : { status: 200, body: { siteEntry: [{ siteUrl: "https://x.com/" }] } },
    );
    const gsc = new GoogleSearchConsoleClient({ accessToken: "t", fetchImpl: gscFetch });
    expect((await gsc.listSites())[0].siteUrl).toBe("https://x.com/");
    const rows = await gsc.querySearchAnalytics({ siteUrl: "https://x.com/", startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(rows[0].keys?.[0]).toBe("plumber london");

    const bingFetch = jsonFetch(() => ({ status: 200, body: { d: [{ Url: "https://x.com/", IsVerified: true }] } }));
    const bing = new BingWebmasterClient({ accessToken: "t", fetchImpl: bingFetch });
    expect((await bing.listSites())[0].IsVerified).toBe(true);
  });

  it("submits URLs to IndexNow and reports acceptance honestly", async () => {
    const fetchImpl = jsonFetch(() => ({ status: 202, body: {} }));
    const results = await submitToIndexNow(
      { host: "example.com", key: "key", keyLocation: "https://example.com/key.txt", urlList: ["https://example.com/a"] },
      ["bing"],
      fetchImpl,
    );
    expect(results[0].accepted).toBe(true);
    expect(results[0].httpStatus).toBe(202);
  });

  it("encrypts OAuth tokens at rest", () => {
    const envelope = encryptSecret("refresh-token-value");
    expect(envelope).not.toContain("refresh-token-value");
    expect(decryptSecret(envelope)).toBe("refresh-token-value");
  });
});
