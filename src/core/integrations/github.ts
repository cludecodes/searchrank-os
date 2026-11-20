import { IntegrationHttpClient, buildAuthorizationUrl, exchangeAuthorizationCode, type FetchLike } from "./http";

export const GITHUB_OAUTH_SCOPES = ["read:user", "public_repo", "repo:status"];
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  html_url: string;
  homepage: string | null;
  description: string | null;
  language: string | null;
  default_branch: string;
  topics?: string[];
  pushed_at: string | null;
  owner: { login: string; type: string };
}

export interface GitHubFile {
  path: string;
  content: string;
  sha: string;
}

export interface GitHubClientOptions {
  accessToken: string;
  fetchImpl?: FetchLike;
}

export function buildGitHubOAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return buildAuthorizationUrl(GITHUB_AUTHORIZE_URL, {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GITHUB_OAUTH_SCOPES.join(" "),
    state,
    allow_signup: "false",
  });
}

export async function exchangeGitHubCode(
  clientId: string,
  clientSecret: string,
  code: string,
  fetchImpl: FetchLike = globalThis.fetch,
) {
  return exchangeAuthorizationCode(
    GITHUB_TOKEN_URL,
    { client_id: clientId, client_secret: clientSecret, code },
    fetchImpl,
  );
}

export class GitHubClient {
  private readonly http: IntegrationHttpClient;

  constructor(options: GitHubClientOptions) {
    this.http = new IntegrationHttpClient({
      provider: "github",
      baseURL: GITHUB_API_BASE,
      accessToken: options.accessToken,
      fetchImpl: options.fetchImpl,
      extraHeaders: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "searchrank-os",
      },
    });
  }

  /** Lists public repositories accessible to the token. Private repositories
   *  are deliberately filtered out and never enter the project registry. */
  async listPublicRepositories(maxPages = 10): Promise<GitHubRepository[]> {
    const repos: GitHubRepository[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.http.request<GitHubRepository[]>({
        path: "/user/repos",
        query: { per_page: 100, page, sort: "pushed", affiliation: "owner,collaborator,organization_member" },
      });
      repos.push(...batch.filter((r) => !r.private && !r.disabled));
      if (batch.length < 100) break;
    }
    return repos;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.http.request<GitHubRepository>({ path: `/repos/${owner}/${repo}` });
  }

  /** Reads a text file from a repository; returns null when absent. */
  async readFile(owner: string, repo: string, path: string, ref?: string): Promise<GitHubFile | null> {
    try {
      const data = await this.http.request<{ content: string; sha: string; path: string }>({
        path: `/repos/${owner}/${repo}/contents/${path}`,
        query: { ref },
      });
      return {
        path: data.path,
        sha: data.sha,
        content: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8"),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) return null;
      throw error;
    }
  }

  /** Detects framework from well-known manifest files. Only reads files. */
  async detectFramework(owner: string, repo: string, defaultBranch?: string): Promise<string | null> {
    const candidates: Array<[string, string]> = [
      ["package.json", "Node.js"],
      ["next.config.js", "Next.js"],
      ["next.config.mjs", "Next.js"],
      ["next.config.ts", "Next.js"],
      ["vite.config.ts", "Vite"],
      ["astro.config.mjs", "Astro"],
      ["requirements.txt", "Python"],
      ["pyproject.toml", "Python"],
      ["Gemfile", "Ruby on Rails"],
      ["composer.json", "PHP"],
      ["index.html", "Static HTML"],
    ];
    for (const [file, framework] of candidates) {
      const content = await this.readFile(owner, repo, file, defaultBranch);
      if (!content) continue;
      if (file === "package.json") {
        try {
          const pkg = JSON.parse(content.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps.next) return "Next.js";
          if (deps.astro) return "Astro";
          if (deps.vite) return "Vite";
          if (deps.react) return "React";
          if (deps.vue) return "Vue";
          if (deps.svelte || deps["@sveltejs/kit"]) return "SvelteKit";
        } catch {
          // Malformed manifest — fall through to generic Node.js.
        }
      }
      return framework;
    }
    return null;
  }

  async createBranch(owner: string, repo: string, branchName: string, fromRef: string): Promise<void> {
    const ref = await this.http.request<{ object: { sha: string } }>({
      path: `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromRef)}`,
    });
    await this.http.request({
      method: "POST",
      path: `/repos/${owner}/${repo}/git/refs`,
      body: { ref: `refs/heads/${branchName}`, sha: ref.object.sha },
    });
  }

  /** Writes a file change. Requires an existing branch and a prior approval. */
  async upsertFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
    sha?: string,
  ): Promise<void> {
    await this.http.request({
      method: "PUT",
      path: `/repos/${owner}/${repo}/contents/${path}`,
      body: {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      },
    });
  }

  async createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<{ html_url: string; number: number }> {
    const pr = await this.http.request<{ html_url: string; number: number }>({
      method: "POST",
      path: `/repos/${owner}/${repo}/pulls`,
      body: input,
    });
    return { html_url: pr.html_url, number: pr.number };
  }

  /** Tip sha of a branch, used as the head ref for checks and reverts. */
  async getBranchHead(owner: string, repo: string, branch: string): Promise<string> {
    const commits = await this.http.request<Array<{ sha: string }>>({
      path: `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
    });
    return commits[0]?.sha ?? "";
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<{
    number: number;
    state: string;
    merged: boolean;
    head: { sha: string; ref: string };
    base: { ref: string; sha: string };
  }> {
    return this.http.request({ path: `/repos/${owner}/${repo}/pulls/${number}` });
  }

  /** Merges only when an explicit approval has been recorded by the caller. */
  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    method: "squash" | "merge" | "rebase" = "squash",
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    const result = await this.http.request<{ merged: boolean; sha?: string; message?: string }>({
      method: "PUT",
      path: `/repos/${owner}/${repo}/pulls/${number}/merge`,
      body: { merge_method: method },
    });
    return { merged: Boolean(result.merged), sha: result.sha ?? "", message: result.message ?? "" };
  }

  /** Rollback is itself a reviewed PR — production is never force-pushed. */
  async createRevertPullRequest(
    owner: string,
    repo: string,
    sha: string,
    base: string,
  ): Promise<{ html_url: string; number: number; branch: string }> {
    const branch = `revert/${sha.slice(0, 12)}`;
    await this.createBranch(owner, repo, branch, base);
    const revert = await this.http.request<{ commit: { sha: string } }>({
      method: "POST",
      path: `/repos/${owner}/${repo}/git/reverts`,
      body: { sha },
    });
    await this.http.request({
      method: "PATCH",
      path: `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      body: { sha: revert.commit.sha, force: false },
    });
    const pr = await this.createPullRequest(owner, repo, {
      title: `Revert ${sha.slice(0, 12)}`,
      head: branch,
      base,
      body: `Automated rollback for commit ${sha}. Requires the same human approval as the original change.`,
    });
    return { ...pr, branch };
  }

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<Array<{ name: string; conclusion: string | null; status: string }>> {
    const data = await this.http.request<{ check_runs: Array<{ name: string; conclusion: string | null; status: string }> }>({
      path: `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`,
    });
    return data.check_runs ?? [];
  }
}
