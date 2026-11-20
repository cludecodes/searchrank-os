import { IntegrationHttpClient, buildAuthorizationUrl, exchangeAuthorizationCode, type FetchLike } from "./http";

export const VERCEL_AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
export const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/token";
export const VERCEL_API_BASE = "https://api.vercel.com";
export const VERCEL_OAUTH_SCOPES = ["team:project", "team:deployment", "user:project", "user:deployment"];

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  description: string | null;
  targets?: Record<string, { url?: string; alias?: string[] }>;
  latestDeployment?: { id?: string; url?: string; state?: string } | null;
  updatedAt?: number;
  link?: { repo?: string; repoId?: string } | null;
}

export interface VercelDeployment {
  id: string;
  url: string;
  state: string;
  target?: string;
  meta?: { githubCommitSha?: string };
  created?: number;
}

export interface VercelDeploymentSummary {
  production: VercelDeployment | null;
  previews: VercelDeployment[];
  latestFailed: VercelDeployment | null;
}

export function buildVercelOAuthUrl(clientId: string, redirectUri: string, state: string): string {
  return buildAuthorizationUrl(VERCEL_AUTHORIZE_URL, {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: VERCEL_OAUTH_SCOPES.join(" "),
    state,
  });
}

export async function exchangeVercelCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = globalThis.fetch,
) {
  return exchangeAuthorizationCode(
    VERCEL_TOKEN_URL,
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
}

export class VercelClient {
  private readonly http: IntegrationHttpClient;

  constructor(options: { accessToken: string; teamId?: string; fetchImpl?: FetchLike }) {
    this.http = new IntegrationHttpClient({
      provider: "vercel",
      baseURL: VERCEL_API_BASE,
      accessToken: options.accessToken,
      fetchImpl: options.fetchImpl,
    });
    this.teamId = options.teamId;
  }

  private readonly teamId?: string;

  async listProjects(): Promise<VercelProject[]> {
    const all: VercelProject[] = [];
    let until: number | undefined;
    for (let i = 0; i < 20; i++) {
      const data = await this.http.request<{ projects: VercelProject[]; pagination?: { next?: number } }>({
        path: "/v9/projects",
        query: { limit: 100, until, teamId: this.teamId },
      });
      all.push(...(data.projects ?? []));
      until = data.pagination?.next;
      if (!until) break;
    }
    return all;
  }

  async listDeployments(projectId: string, limit = 20): Promise<VercelDeployment[]> {
    const data = await this.http.request<{ deployments: VercelDeployment[] }>({
      path: "/v6/deployments",
      query: { projectId, limit, teamId: this.teamId },
    });
    return data.deployments ?? [];
  }

  /** Returns the production alias and latest deployment for a project. */
  async getProductionInfo(projectId: string): Promise<{ url: string | null; deployment: VercelDeployment | null }> {
    const deployments = await this.listDeployments(projectId, 50);
    const production = deployments.find((d) => d.target === "production" && d.state === "READY");
    return {
      url: production?.url ?? null,
      deployment: production ?? null,
    };
  }

  /** Returns production, preview and failed deployments for a project. */
  async getDeploymentSummary(projectId: string): Promise<VercelDeploymentSummary> {
    const deployments = await this.listDeployments(projectId, 100);
    const production = deployments.find((d) => d.target === "production") ?? null;
    const previews = deployments.filter((d) => d.target === "preview");
    const latestFailed = deployments.find((d) => d.state !== "READY" && d.state !== "QUEUED" && d.state !== "BUILDING") ?? null;
    return { production, previews, latestFailed };
  }
}
