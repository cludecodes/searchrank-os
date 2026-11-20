import { IntegrationHttpClient, buildAuthorizationUrl, exchangeAuthorizationCode, type FetchLike } from "./http";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
export const GSC_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/webmasters",
];

export interface GscSite {
  siteUrl: string;
  permissionLevel?: string;
}

export interface GscSearchRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscSitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isThrottled?: boolean;
  contents?: Array<{ type: string; submitted?: string; seen?: string }>;
}

export function buildGoogleOAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeVerifier?: string,
  codeChallenge?: string,
): string {
  return buildAuthorizationUrl(GOOGLE_AUTHORIZE_URL, {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GSC_SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    ...(codeChallenge && codeVerifier
      ? { code_challenge: codeChallenge, code_challenge_method: "S256" }
      : {}),
  });
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = globalThis.fetch,
) {
  return exchangeAuthorizationCode(
    GOOGLE_TOKEN_URL,
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

export class GoogleSearchConsoleClient {
  private readonly http: IntegrationHttpClient;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { accessToken: string; fetchImpl?: FetchLike }) {
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.http = new IntegrationHttpClient({
      provider: "google_search_console",
      baseURL: GSC_API_BASE,
      accessToken: options.accessToken,
      fetchImpl: options.fetchImpl,
    });
  }

  async listSites(): Promise<GscSite[]> {
    const data = await this.http.request<{ siteEntry?: GscSite[] }>({ path: "/sites" });
    return data.siteEntry ?? [];
  }

  async querySearchAnalytics(input: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    dimensions?: Array<"query" | "page" | "country" | "device" | "date">;
    rowLimit?: number;
    startRow?: number;
  }): Promise<GscSearchRow[]> {
    const data = await this.http.request<{ rows?: GscSearchRow[] }>({
      method: "POST",
      path: `/sites/${encodeURIComponent(input.siteUrl)}/searchAnalytics/query`,
      body: {
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions ?? ["query", "page", "country", "device"],
        rowLimit: input.rowLimit ?? 1000,
        startRow: input.startRow ?? 0,
      },
    });
    return data.rows ?? [];
  }

  async listSitemaps(siteUrl: string): Promise<GscSitemap[]> {
    const data = await this.http.request<{ sitemap?: GscSitemap[] }>({
      path: `/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    });
    return data.sitemap ?? [];
  }

  /** Submits a sitemap. Success means GSC accepted the request, not that URLs are indexed. */
  async submitSitemap(siteUrl: string, sitemapUrl: string): Promise<void> {
    await this.http.request({
      method: "PUT",
      path: `/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
    });
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string) {
    const response = await this.fetchImpl("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
    });
    if (!response.ok) {
      throw new Error(`GSC URL inspection failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
